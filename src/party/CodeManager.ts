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
const CODE_LENGTH = 6;
const CODE_MAX = Math.pow(10, CODE_LENGTH); // 1,000,000
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
   * 4桁のユニークなコードを生成
   */
  generateCode(): string {
    let code: string;
    let attempts = 0;
    const maxAttempts = 100;

    do {
      code = this.generateRandomCode();
      attempts++;

      if (attempts >= maxAttempts) {
        // 全コード使用中の場合は期限切れを削除して再試行
        this.cleanupExpiredCodes();
      }
    } while (this.isCodeActive(code) && attempts < maxAttempts * 2);

    return code;
  }

  /**
   * コードを登録
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

  /**
   * ランダムな4桁コードを生成
   */
  private generateRandomCode(): string {
    const num = Math.floor(Math.random() * 10000);
    return num.toString().padStart(4, '0');
  }

  /**
   * 期限切れコードを削除
   */
  private cleanupExpiredCodes(): void {
    const now = Date.now();
    for (const [code, info] of this.activeCodes) {
      if (now - info.createdAt > CODE_EXPIRY_MS) {
        this.activeCodes.delete(code);
      }
    }
  }
}
