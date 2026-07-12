import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CodeManager } from './CodeManager';

describe('CodeManager', () => {
  let codeManager: CodeManager;

  beforeEach(() => {
    codeManager = new CodeManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('registerCode', () => {
    it('コードとreceiverのconnectionIdを紐付けて登録できる', () => {
      const code = '123456';
      const connectionId = 'receiver-abc';

      codeManager.registerCode(code, connectionId);

      expect(codeManager.isCodeActive(code)).toBe(true);
    });

    it('登録時にタイムスタンプが記録される', () => {
      const code = '123456';
      const now = Date.now();
      vi.setSystemTime(now);

      codeManager.registerCode(code, 'receiver-abc');
      const info = codeManager.getCodeInfo(code);

      expect(info?.createdAt).toBe(now);
    });
  });

  describe('validateCode', () => {
    it('有効なコードに対してtrueを返す', () => {
      const code = '567890';
      codeManager.registerCode(code, 'receiver-xyz');

      expect(codeManager.validateCode(code)).toBe(true);
    });

    it('未登録のコードに対してfalseを返す', () => {
      expect(codeManager.validateCode('999999')).toBe(false);
    });

    it('有効期限切れのコードに対してfalseを返す', () => {
      const code = '123456';
      const now = Date.now();
      vi.setSystemTime(now);

      codeManager.registerCode(code, 'receiver-abc');

      // 10分 + 1ms 経過
      vi.setSystemTime(now + 10 * 60 * 1000 + 1);

      expect(codeManager.validateCode(code)).toBe(false);
    });
  });

  describe('expireCode', () => {
    it('コードを無効化できる', () => {
      const code = '123456';
      codeManager.registerCode(code, 'receiver-abc');

      codeManager.expireCode(code);

      expect(codeManager.isCodeActive(code)).toBe(false);
    });
  });

  describe('getReceiverConnectionId', () => {
    it('コードに紐付いたreceiverのconnectionIdを取得できる', () => {
      const code = '123456';
      const connectionId = 'receiver-abc';
      codeManager.registerCode(code, connectionId);

      expect(codeManager.getReceiverConnectionId(code)).toBe(connectionId);
    });

    it('未登録のコードに対してundefinedを返す', () => {
      expect(codeManager.getReceiverConnectionId('999999')).toBeUndefined();
    });
  });

  describe('レート制限', () => {
    it('同一IPから10回/分を超えるとレート制限される', () => {
      const ip = '192.168.1.1';

      // 10回は成功
      for (let i = 0; i < 10; i++) {
        expect(codeManager.checkRateLimit(ip)).toBe(true);
        codeManager.recordAttempt(ip);
      }

      // 11回目は制限
      expect(codeManager.checkRateLimit(ip)).toBe(false);
    });

    it('1分経過後はレート制限がリセットされる', () => {
      const ip = '192.168.1.1';
      const now = Date.now();
      vi.setSystemTime(now);

      // 10回試行
      for (let i = 0; i < 10; i++) {
        codeManager.recordAttempt(ip);
      }

      // 1分経過
      vi.setSystemTime(now + 60 * 1000 + 1);

      expect(codeManager.checkRateLimit(ip)).toBe(true);
    });
  });

  describe('ロックアウト', () => {
    it('3回連続で無効なコードを入力するとロックアウトされる', () => {
      const ip = '192.168.1.1';

      // 3回失敗
      for (let i = 0; i < 3; i++) {
        codeManager.recordFailedAttempt(ip);
      }

      expect(codeManager.isLockedOut(ip)).toBe(true);
    });

    it('ロックアウトは5分後に解除される', () => {
      const ip = '192.168.1.1';
      const now = Date.now();
      vi.setSystemTime(now);

      // 3回失敗
      for (let i = 0; i < 3; i++) {
        codeManager.recordFailedAttempt(ip);
      }

      // 5分経過
      vi.setSystemTime(now + 5 * 60 * 1000 + 1);

      expect(codeManager.isLockedOut(ip)).toBe(false);
    });

    it('成功した場合は失敗カウントがリセットされる', () => {
      const ip = '192.168.1.1';

      // 2回失敗
      codeManager.recordFailedAttempt(ip);
      codeManager.recordFailedAttempt(ip);

      // 成功
      codeManager.recordSuccessfulAttempt(ip);

      // もう1回失敗してもロックアウトされない
      codeManager.recordFailedAttempt(ip);

      expect(codeManager.isLockedOut(ip)).toBe(false);
    });
  });
});
