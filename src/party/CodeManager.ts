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
  lockedUntil: number | null;
}

// 設定定数
const CODE_EXPIRY_MS = 5 * 60 * 1000; // 5分（セキュリティ強化のため短縮）
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1分
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const LOCKOUT_THRESHOLD = 3;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5分

export class CodeManager {
  private activeCodes: Map<string, CodeInfo> = new Map();
  private rateLimits: Map<string, RateLimitInfo> = new Map();
  private lockouts: Map<string, LockoutInfo> = new Map();

  /**
   * コードを登録
   *
   * NOTE: ペアリングコードはクライアントが CSPRNG で生成し
   * （client/utils/codeGenerator）、そのまま PartyKit のルーム ID として使う
   * （server.ts の handleGenerateCode 参照）。このため以前サーバ側にあった
   * generateCode / generateRandomCode は未使用となり削除した。
   *
   * 既知の制約（コード列挙）: コード空間は 10^6・有効期限は5分のため、
   * アクティブなコードを総当たりで探す攻撃を完全には防げない。レート制限は
   * このクラスにあるが、キーが接続 ID かつ PartyKit のルームはコードごとに
   * 別インスタンスなので、ルームを跨いだ列挙には効きにくい。完全な列挙対策には
   * 跨ルームの中央リミッターが必要。
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
    if (now - info.windowStart > RATE_LIMIT_WINDOW_MS) {
      this.rateLimits.delete(ip);
      return true;
    }

    return info.attempts < RATE_LIMIT_MAX_ATTEMPTS;
  }

  /**
   * 試行を記録
   */
  recordAttempt(ip: string): void {
    const now = Date.now();
    const info = this.rateLimits.get(ip);

    if (!info || now - info.windowStart > RATE_LIMIT_WINDOW_MS) {
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
    const info = this.lockouts.get(ip) || {
      failedAttempts: 0,
      lockedUntil: null,
    };

    info.failedAttempts++;

    if (info.failedAttempts >= LOCKOUT_THRESHOLD) {
      info.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
    }

    this.lockouts.set(ip, info);
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
