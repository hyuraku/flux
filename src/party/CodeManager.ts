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
}

// 設定定数
const CODE_EXPIRY_MS = 5 * 60 * 1000; // 5分（セキュリティ強化のため短縮）

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
  private readonly config: RateLimitConfig;

  constructor(config: RateLimitConfig = DEFAULT_RATE_LIMIT) {
    this.config = config;
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
    const info = this.rateLimits.get(ip);

    if (!info) {
      return true;
    }

    // ウィンドウが過ぎていればリセット
    if (now - info.windowStart > this.config.windowMs) {
      this.rateLimits.delete(ip);
      return true;
    }

    return info.attempts < this.config.maxAttempts;
  }

  /**
   * 試行を記録
   */
  recordAttempt(ip: string): void {
    const now = Date.now();
    const info = this.rateLimits.get(ip);

    if (!info || now - info.windowStart > this.config.windowMs) {
      this.rateLimits.set(ip, {
        attempts: 1,
        windowStart: now,
      });
    } else {
      info.attempts++;
    }
  }

  /**
   * 失敗した試行を記録
   */
  recordFailedAttempt(ip: string): void {
    const now = Date.now();
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
  }

  /**
   * 成功した試行を記録（失敗カウントをリセット）
   */
  recordSuccessfulAttempt(ip: string): void {
    this.lockouts.delete(ip);
  }

  /**
   * ロックアウト状態かどうか
   */
  isLockedOut(ip: string): boolean {
    const info = this.lockouts.get(ip);
    if (!info || !info.lockedUntil) {
      return false;
    }

    const now = Date.now();
    if (now > info.lockedUntil) {
      this.lockouts.delete(ip);
      return false;
    }

    return true;
  }
}
