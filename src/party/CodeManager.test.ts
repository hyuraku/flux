import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  CodeManager,
  DEFAULT_MAX_TRACKED_KEYS,
  DEFAULT_SWEEP_INTERVAL_MS,
  type RateLimitConfig,
} from './CodeManager';

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

  describe('しきい値の差し替え（ルーム横断リミッター用）', () => {
    it('渡した設定のしきい値が使われる', () => {
      const limiter = new CodeManager({
        windowMs: 60 * 1000,
        maxAttempts: 30,
        lockoutThreshold: 10,
        lockoutMs: 5 * 60 * 1000,
        failureWindowMs: 5 * 60 * 1000,
      });
      const ip = '203.0.113.10';

      // 既定（10回）を超えても、maxAttempts=30 までは通る
      for (let i = 0; i < 30; i++) {
        expect(limiter.checkRateLimit(ip)).toBe(true);
        limiter.recordAttempt(ip);
      }
      expect(limiter.checkRateLimit(ip)).toBe(false);

      // 既定（3回）を超えても、lockoutThreshold=10 までロックされない
      for (let i = 0; i < 9; i++) {
        limiter.recordFailedAttempt(ip);
      }
      expect(limiter.isLockedOut(ip)).toBe(false);

      limiter.recordFailedAttempt(ip);
      expect(limiter.isLockedOut(ip)).toBe(true);
    });

    it('failureWindowMsを過ぎた失敗は数え直す（共有IPの巻き添え防止）', () => {
      const limiter = new CodeManager({
        windowMs: 60 * 1000,
        maxAttempts: 30,
        lockoutThreshold: 3,
        lockoutMs: 5 * 60 * 1000,
        failureWindowMs: 5 * 60 * 1000,
      });
      const ip = '203.0.113.11';
      const now = Date.now();
      vi.setSystemTime(now);

      limiter.recordFailedAttempt(ip);
      limiter.recordFailedAttempt(ip);

      // ウィンドウを過ぎたので、ここからは1回目として数え直される
      vi.setSystemTime(now + 5 * 60 * 1000 + 1);
      limiter.recordFailedAttempt(ip);
      limiter.recordFailedAttempt(ip);
      expect(limiter.isLockedOut(ip)).toBe(false);

      limiter.recordFailedAttempt(ip);
      expect(limiter.isLockedOut(ip)).toBe(true);
    });

    it('既定（failureWindowMs=null）では失敗が時間で失効しない', () => {
      const ip = '203.0.113.12';
      const now = Date.now();
      vi.setSystemTime(now);

      codeManager.recordFailedAttempt(ip);
      codeManager.recordFailedAttempt(ip);

      vi.setSystemTime(now + 60 * 60 * 1000);
      codeManager.recordFailedAttempt(ip);

      expect(codeManager.isLockedOut(ip)).toBe(true);
    });
  });

  describe('レート制限 state の上限', () => {
    const BOUNDED: RateLimitConfig = {
      windowMs: 60 * 1000,
      maxAttempts: 30,
      lockoutThreshold: 3,
      lockoutMs: 5 * 60 * 1000,
      failureWindowMs: 5 * 60 * 1000,
      maxTrackedKeys: 5,
      sweepIntervalMs: 60 * 1000,
    };

    it('既定値が入る（設定を省略しても上限は効く）', () => {
      const limiter = new CodeManager({
        windowMs: 60 * 1000,
        maxAttempts: 30,
        lockoutThreshold: 3,
        lockoutMs: 5 * 60 * 1000,
        failureWindowMs: null,
      });

      limiter.recordAttempt('198.51.100.1');
      expect(limiter.getTrackedKeyCount()).toBe(1);
      expect(DEFAULT_MAX_TRACKED_KEYS).toBe(10_000);
      expect(DEFAULT_SWEEP_INTERVAL_MS).toBe(60 * 1000);
    });

    it('期限切れのキーは掃除される', () => {
      const limiter = new CodeManager(BOUNDED);
      const now = Date.now();
      vi.setSystemTime(now);

      limiter.recordAttempt('198.51.100.1');
      limiter.recordFailedAttempt('198.51.100.2');
      expect(limiter.getTrackedKeyCount()).toBe(2);

      // ウィンドウも失敗の保持期間も過ぎた時点で別のキーを触る
      vi.setSystemTime(now + 10 * 60 * 1000);
      limiter.recordAttempt('198.51.100.3');

      expect(limiter.getTrackedKeyCount()).toBe(1);
    });

    it('掃除は sweepIntervalMs ごとにしか走らない', () => {
      const limiter = new CodeManager({
        ...BOUNDED,
        sweepIntervalMs: 10 * 60 * 1000,
      });
      const now = Date.now();
      vi.setSystemTime(now);

      limiter.recordAttempt('198.51.100.1');

      // ウィンドウ（1分）は過ぎたが掃除間隔（10分）には達していないので残る
      vi.setSystemTime(now + 5 * 60 * 1000);
      limiter.recordAttempt('198.51.100.2');
      expect(limiter.getTrackedKeyCount()).toBe(2);

      // 掃除間隔を過ぎると期限切れの2件がまとめて消える
      vi.setSystemTime(now + 11 * 60 * 1000);
      limiter.recordAttempt('198.51.100.3');
      expect(limiter.getTrackedKeyCount()).toBe(1);
    });

    it('掃除してもロックアウト中のキーは残る', () => {
      const limiter = new CodeManager(BOUNDED);
      const now = Date.now();
      vi.setSystemTime(now);

      const locked = '198.51.100.9';
      for (let i = 0; i < 3; i++) {
        limiter.recordFailedAttempt(locked);
      }
      expect(limiter.isLockedOut(locked)).toBe(true);

      // 失敗の保持期間（5分）は過ぎるがロックアウト（5分）はまだ有効
      vi.setSystemTime(now + 5 * 60 * 1000 - 1);
      limiter.recordAttempt('198.51.100.10');

      expect(limiter.getTrackedKeyCount()).toBe(2);
      expect(limiter.isLockedOut(locked)).toBe(true);

      // ロックアウトが切れれば掃除対象になる
      vi.setSystemTime(now + 20 * 60 * 1000);
      limiter.recordAttempt('198.51.100.11');
      expect(limiter.getTrackedKeyCount()).toBe(1);
    });

    it('キー数の上限を超えない', () => {
      const limiter = new CodeManager(BOUNDED);
      const now = Date.now();
      vi.setSystemTime(now);

      for (let i = 0; i < 50; i++) {
        limiter.recordAttempt(`198.51.100.${i}`);
      }

      expect(limiter.getTrackedKeyCount()).toBe(5);
    });

    it('上限超過時は古い非ロックのキーから追い出す', () => {
      const limiter = new CodeManager(BOUNDED);
      const now = Date.now();
      vi.setSystemTime(now);

      // 先にロックアウトされたキーを作る
      const locked = '198.51.100.99';
      for (let i = 0; i < 3; i++) {
        limiter.recordFailedAttempt(locked);
      }
      expect(limiter.isLockedOut(locked)).toBe(true);

      // 上限（5）を超えるまで非ロックのキーを増やす。
      // 掃除が走らないよう同じ時刻のままにする。
      for (let i = 0; i < 20; i++) {
        limiter.recordAttempt(`198.51.100.${i}`);
      }

      expect(limiter.getTrackedKeyCount()).toBe(5);
      // ロック中のキーは非ロックのキーより後に追い出される
      expect(limiter.isLockedOut(locked)).toBe(true);
    });

    it('上限が埋まりきった場合は解除の近いロックから追い出す', () => {
      // 1回の失敗で即ロックする設定にして、全キーがロック中の状態を作る
      const limiter = new CodeManager({
        ...BOUNDED,
        lockoutThreshold: 1,
        maxTrackedKeys: 3,
      });
      const now = Date.now();

      // 解除時刻が異なる4つのロックを作る
      const keys = ['a', 'b', 'c', 'd'];
      keys.forEach((key, index) => {
        vi.setSystemTime(now + index);
        limiter.recordFailedAttempt(key);
      });

      expect(limiter.getTrackedKeyCount()).toBe(3);
      // 最初にロックされた（＝最も早く解除される）キーが落ちる
      expect(limiter.isLockedOut('a')).toBe(false);
      expect(limiter.isLockedOut('b')).toBe(true);
      expect(limiter.isLockedOut('c')).toBe(true);
      expect(limiter.isLockedOut('d')).toBe(true);
    });

    it('ウィンドウ内のキーの判定は上限処理の影響を受けない', () => {
      const limiter = new CodeManager(BOUNDED);
      const now = Date.now();
      vi.setSystemTime(now);

      const ip = '198.51.100.200';
      for (let i = 0; i < 30; i++) {
        limiter.recordAttempt(ip);
      }

      expect(limiter.checkRateLimit(ip)).toBe(false);
    });
  });
});
