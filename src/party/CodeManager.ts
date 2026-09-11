interface CodeInfo {
  code: string;
  receiverConnectionId: string;
  createdAt: number;
}

interface RateLimitInfo {
  attempts: number;
  windowStart: number;
}

interface LockoutInfo {
  failedAttempts: number;
  // 連続失敗の起点。failureWindowMs による失効判定に使う。
  firstFailureAt: number;
  lockedUntil: number | null;
}

/**
 * レート制限・ロックアウトのしきい値。
 *
 * 接続IDをキーにするローカル制限と、IPをキーにするルーム横断制限とで
 * 値を変えられるように外から差し込めるようにしてある
 * （ルーム横断側は rateLimit.ts の CROSS_ROOM_RATE_LIMIT を参照）。
 */
export interface RateLimitConfig {
  /** レート制限のウィンドウ幅 */
  windowMs: number;
  /** ウィンドウ内に許容する試行回数 */
  maxAttempts: number;
  /** ロックアウトに至る失敗回数 */
  lockoutThreshold: number;
  /** ロックアウトの継続時間 */
  lockoutMs: number;
  /**
   * 失敗カウントを保持する期間。
   * この期間より前の失敗は数え直す（＝時間が経てば回復する）。
   * null なら失効させない（成功かロックアウト解除でのみリセット）。
   */
  failureWindowMs: number | null;
  /**
   * 追跡するキーの上限（省略時 DEFAULT_MAX_TRACKED_KEYS）。
   * 超えたぶんは evictOverflow のポリシーで追い出す。
   */
  maxTrackedKeys?: number;
  /**
   * 期限切れキーの掃除を行う最短間隔（省略時 DEFAULT_SWEEP_INTERVAL_MS）。
   * タイマーではなく record/check の中から日和見的に呼ぶ。
   */
  sweepIntervalMs?: number;
}

// 設定定数
const CODE_EXPIRY_MS = 5 * 60 * 1000; // 5分（セキュリティ強化のため短縮）

/**
 * 追跡キー数の既定上限。
 *
 * このクラスの Map は Durable Object（PartyKit のルーム）のメモリ上にあり、
 * 1インスタンスあたりのメモリは 128MB 程度しかない。
 * 1キーあたり数百バイト見積もりで 10,000 キー ≒ 数MB に収まるので、
 * ルーム横断リミッター（全ルーム分のIPが1インスタンスに集まる）でも
 * 安全側に倒せる値としてこれを既定にした。
 */
export const DEFAULT_MAX_TRACKED_KEYS = 10_000;

/** 期限切れキーの掃除間隔の既定値（1分） */
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * 既定のしきい値（接続IDをキーにするローカル制限用）。
 * 接続ごとに独立したキーになるので厳しめでも巻き添えが出にくい。
 */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60 * 1000, // 1分
  maxAttempts: 10,
  lockoutThreshold: 3,
  lockoutMs: 5 * 60 * 1000, // 5分
  failureWindowMs: null,
};

export class CodeManager {
  private activeCodes: Map<string, CodeInfo> = new Map();
  private rateLimits: Map<string, RateLimitInfo> = new Map();
  private lockouts: Map<string, LockoutInfo> = new Map();
  /**
   * rateLimits / lockouts に載っているキーの最終更新時刻。
   *
   * Map は挿入順を保つので、touch のたびに delete → set し直すことで
   * 「反復順 = 古い順（LRU）」を保っている。上限超過時の追い出し順に使う。
   */
  private keyLastSeen: Map<string, number> = new Map();
  private lastSweepAt = 0;
  private readonly config: RateLimitConfig;
  private readonly maxTrackedKeys: number;
  private readonly sweepIntervalMs: number;

  constructor(config: RateLimitConfig = DEFAULT_RATE_LIMIT) {
    this.config = config;
    this.maxTrackedKeys = config.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
    this.sweepIntervalMs = config.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  /**
   * コードを登録
   *
   * NOTE: ペアリングコードはクライアントが CSPRNG で生成し
   * （client/utils/codeGenerator）、そのまま PartyKit のルーム ID として使う
   * （server.ts の handleGenerateCode 参照）。このため以前サーバ側にあった
   * generateCode / generateRandomCode は未使用となり削除した。
   *
   * 既知の制約（コード列挙）: コード空間は 10^6・有効期限は5分のため、
   * アクティブなコードを総当たりで探す攻撃を完全には防げない。
   * このクラスの制限を接続IDでキーにしたままだと接続を張り直すだけで回避でき、
   * PartyKit のルームはコードごとに別インスタンスなのでルームを跨いだ列挙にも
   * 効かない。そのため server.ts では接続元IPをキーにした専用ルーム
   * （rateLimit.ts の RATE_LIMITER_ROOM_ID）へ問い合わせる中央リミッターを
   * 併用し、このクラスの接続IDキーの制限は多重防御として残している。
   */
  registerCode(code: string, receiverConnectionId: string): void {
    this.activeCodes.set(code, {
      code,
      receiverConnectionId,
      createdAt: Date.now(),
    });
  }

  /**
   * コードが有効かどうか検証
   */
  validateCode(code: string): boolean {
    const info = this.activeCodes.get(code);
    if (!info) {
      return false;
    }

    const now = Date.now();
    if (now - info.createdAt > CODE_EXPIRY_MS) {
      this.activeCodes.delete(code);
      return false;
    }

    return true;
  }

  /**
   * コードがアクティブかどうか
   */
  isCodeActive(code: string): boolean {
    return this.activeCodes.has(code) && this.validateCode(code);
  }

  /**
   * コードを無効化
   */
  expireCode(code: string): void {
    this.activeCodes.delete(code);
  }

  /**
   * コード情報を取得
   */
  getCodeInfo(code: string): CodeInfo | undefined {
    return this.activeCodes.get(code);
  }

  /**
   * ReceiverのconnectionIdを取得
   */
  getReceiverConnectionId(code: string): string | undefined {
    return this.activeCodes.get(code)?.receiverConnectionId;
  }

  /**
   * レート制限チェック
   */
  checkRateLimit(ip: string): boolean {
    const now = Date.now();
    this.sweepIfDue(now);
    const info = this.rateLimits.get(ip);

    if (!info) {
      return true;
    }

    // ウィンドウが過ぎていればリセット
    if (now - info.windowStart > this.config.windowMs) {
      this.dropRateLimit(ip);
      return true;
    }

    return info.attempts < this.config.maxAttempts;
  }

  /**
   * 試行を記録
   */
  recordAttempt(ip: string): void {
    const now = Date.now();
    this.sweepIfDue(now);
    const info = this.rateLimits.get(ip);

    if (!info || now - info.windowStart > this.config.windowMs) {
      this.rateLimits.set(ip, {
        attempts: 1,
        windowStart: now,
      });
    } else {
      info.attempts++;
    }

    this.touch(ip, now);
    this.evictOverflow(now);
  }

  /**
   * 失敗した試行を記録
   */
  recordFailedAttempt(ip: string): void {
    const now = Date.now();
    this.sweepIfDue(now);
    let info = this.lockouts.get(ip);

    // 失効ウィンドウを過ぎた失敗は数え直す。
    // 共有IP（NAT）で長期間にわたる散発的な失敗が積み上がって
    // 無関係な利用者を巻き込むのを防ぐため。
    const { failureWindowMs } = this.config;
    if (
      info &&
      info.lockedUntil === null &&
      failureWindowMs !== null &&
      now - info.firstFailureAt > failureWindowMs
    ) {
      info = undefined;
    }

    const next: LockoutInfo = info ?? {
      failedAttempts: 0,
      firstFailureAt: now,
      lockedUntil: null,
    };

    next.failedAttempts++;

    if (next.failedAttempts >= this.config.lockoutThreshold) {
      next.lockedUntil = now + this.config.lockoutMs;
    }

    this.lockouts.set(ip, next);
    this.touch(ip, now);
    this.evictOverflow(now);
  }

  /**
   * 成功した試行を記録（失敗カウントをリセット）
   */
  recordSuccessfulAttempt(ip: string): void {
    const now = Date.now();
    this.sweepIfDue(now);
    this.dropLockout(ip);
  }

  /**
   * ロックアウト状態かどうか
   */
  isLockedOut(ip: string): boolean {
    const now = Date.now();
    this.sweepIfDue(now);
    const info = this.lockouts.get(ip);
    if (!info || !info.lockedUntil) {
      return false;
    }

    if (now > info.lockedUntil) {
      this.dropLockout(ip);
      return false;
    }

    return true;
  }

  /**
   * 追跡中のキー数（上限の監視・テスト用）
   */
  getTrackedKeyCount(): number {
    return this.keyLastSeen.size;
  }

  // --- 以下、レート制限の状態を有限に保つための内部処理 ---
  //
  // rateLimits / lockouts は放っておくとキーが増える一方で、
  // ルーム横断リミッターは1つの Durable Object に全ルーム分のIPが集まるため
  // そのままではメモリを食い潰される（＝リミッター自体がDoSの的になる）。
  // そこで
  //   (1) 期限切れキーの日和見的な掃除（sweepIfDue）
  //   (2) キー数の上限と決定的な追い出し（evictOverflow）
  // の2段で state を有限に抑える。
  // Durable Object はいつ退避されてもおかしくないのでタイマーは使わず、
  // record/check 呼び出しのついでに行う。

  /**
   * キーの最終更新時刻を記録する。
   * delete → set で挿入順の末尾に移し、反復順を「古い順」に保つ。
   */
  private touch(key: string, now: number): void {
    this.keyLastSeen.delete(key);
    this.keyLastSeen.set(key, now);
  }

  /** キーに紐づく全ての状態を捨てる */
  private forget(key: string): void {
    this.rateLimits.delete(key);
    this.lockouts.delete(key);
    this.keyLastSeen.delete(key);
  }

  private dropRateLimit(key: string): void {
    this.rateLimits.delete(key);
    if (!this.lockouts.has(key)) {
      this.keyLastSeen.delete(key);
    }
  }

  private dropLockout(key: string): void {
    this.lockouts.delete(key);
    if (!this.rateLimits.has(key)) {
      this.keyLastSeen.delete(key);
    }
  }

  /** ロックアウト中（＝解除時刻がまだ来ていない）か */
  private isKeyLocked(key: string, now: number): boolean {
    const lockout = this.lockouts.get(key);
    return lockout?.lockedUntil != null && now <= lockout.lockedUntil;
  }

  /**
   * そのキーの状態がもう意味を持たないか。
   *
   * 判定は既存のしきい値と完全に一致させてある
   * （＝掃除しても checkRateLimit / isLockedOut の結果は変わらない）:
   * - レート制限: ウィンドウを過ぎていれば失効
   * - ロックアウト: 解除時刻を過ぎていれば失効
   * - 失敗カウントのみ: failureWindowMs を過ぎていれば失効
   *
   * NOTE: failureWindowMs が null の設定（DEFAULT_RATE_LIMIT）では
   * 失敗カウントは時間で失効しない。この場合、失敗が残るキーは
   * 掃除では消えず上限による追い出しだけが効く（挙動を変えないため）。
   */
  private isKeyExpired(key: string, now: number): boolean {
    const rate = this.rateLimits.get(key);
    if (rate && now - rate.windowStart <= this.config.windowMs) {
      return false;
    }

    const lockout = this.lockouts.get(key);
    if (lockout) {
      if (lockout.lockedUntil !== null) {
        return now > lockout.lockedUntil;
      }
      const { failureWindowMs } = this.config;
      if (failureWindowMs === null) {
        return false;
      }
      return now - lockout.firstFailureAt > failureWindowMs;
    }

    return true;
  }

  /** 前回の掃除から sweepIntervalMs 以上経っていれば掃除する */
  private sweepIfDue(now: number): void {
    if (now - this.lastSweepAt < this.sweepIntervalMs) {
      return;
    }
    this.lastSweepAt = now;
    this.sweepExpired(now);
  }

  private sweepExpired(now: number): void {
    for (const key of [...this.keyLastSeen.keys()]) {
      if (this.isKeyExpired(key, now)) {
        this.forget(key);
      }
    }
  }

  /**
   * キー数が上限を超えていたら追い出す。
   *
   * 追い出し順（決定的）:
   *   1. 期限切れのキー（まず掃除で消える）
   *   2. ロックアウトされていないキーを最終更新が古い順に
   *   3. それでも足りなければロックアウト中のキーを解除時刻が近い順に
   *
   * 2 を先にするのは、ロックアウト中のキー（＝攻撃的な相手）を
   * 上限を埋めるだけで早期解放させられると、制限そのものを回避されるため。
   * 3 まで来るのは上限が完全に埋まっている異常時だけで、
   * その中でも「あと少しで解除されるもの」から捨てて影響を最小にする。
   */
  private evictOverflow(now: number): void {
    let overflow = this.keyLastSeen.size - this.maxTrackedKeys;
    if (overflow <= 0) {
      return;
    }

    // 1: 期限切れを先に落とす
    this.sweepExpired(now);
    overflow = this.keyLastSeen.size - this.maxTrackedKeys;
    if (overflow <= 0) {
      return;
    }

    // 2: 非ロックのキーを古い順に（Map の反復順がそのまま古い順）
    for (const key of [...this.keyLastSeen.keys()]) {
      if (overflow <= 0) {
        break;
      }
      if (this.isKeyLocked(key, now)) {
        continue;
      }
      this.forget(key);
      overflow--;
    }

    if (overflow <= 0) {
      return;
    }

    // 3: 全部ロック中の異常時のみ。解除が近いものから捨てる
    const locked = [...this.keyLastSeen.keys()]
      .map((key) => ({ key, until: this.lockouts.get(key)?.lockedUntil ?? 0 }))
      .sort((a, b) => a.until - b.until);

    for (const { key } of locked) {
      if (overflow <= 0) {
        break;
      }
      this.forget(key);
      overflow--;
    }
  }
}
