import { describe, it, expect } from 'vitest';
import { EncryptionService } from './EncryptionService';

describe('EncryptionService', () => {
  describe('generateKeyPair', () => {
    it('ExportedPublicKey（x, y）を返す', async () => {
      const service = new EncryptionService();
      const publicKey = await service.generateKeyPair();

      expect(publicKey).toHaveProperty('x');
      expect(publicKey).toHaveProperty('y');
      expect(typeof publicKey.x).toBe('string');
      expect(typeof publicKey.y).toBe('string');
    });
  });

  describe('isReady', () => {
    it('鍵導出前はfalseを返す', () => {
      const service = new EncryptionService();
      expect(service.isReady()).toBe(false);
    });

    it('鍵導出後はtrueを返す', async () => {
      const alice = new EncryptionService();
      const bob = new EncryptionService();

      const aliceKey = await alice.generateKeyPair();
      const bobKey = await bob.generateKeyPair();

      await alice.deriveSharedKey(bobKey);
      expect(alice.isReady()).toBe(true);
    });
  });

  describe('deriveSharedKey', () => {
    it('generateKeyPair未呼び出し時にthrowする', async () => {
      const service = new EncryptionService();
      const other = new EncryptionService();
      const otherKey = await other.generateKeyPair();

      await expect(service.deriveSharedKey(otherKey)).rejects.toThrow(
        'Key pair not generated'
      );
    });
  });

  describe('encrypt / decrypt', () => {
    it('共有鍵未導出時にencryptがthrowする', async () => {
      const service = new EncryptionService();
      await service.generateKeyPair();
      const data = new Uint8Array([1, 2, 3]).buffer;

      await expect(service.encrypt(data)).rejects.toThrow(
        'Shared key not derived'
      );
    });

    it('共有鍵未導出時にdecryptがthrowする', async () => {
      const service = new EncryptionService();
      await service.generateKeyPair();

      await expect(
        service.decrypt({ ciphertext: new ArrayBuffer(16), iv: new Uint8Array(12) })
      ).rejects.toThrow('Shared key not derived');
    });

    it('2インスタンス間で暗号化→復号のラウンドトリップが成功する', async () => {
      const alice = new EncryptionService();
      const bob = new EncryptionService();

      const aliceKey = await alice.generateKeyPair();
      const bobKey = await bob.generateKeyPair();

      await alice.deriveSharedKey(bobKey);
      await bob.deriveSharedKey(aliceKey);

      const original = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const encrypted = await alice.encrypt(original.buffer);
      const decrypted = await bob.decrypt(encrypted);

      expect(new Uint8Array(decrypted)).toEqual(original);
    });

    it('大きなデータの暗号化→復号が成功する', async () => {
      const alice = new EncryptionService();
      const bob = new EncryptionService();

      const aliceKey = await alice.generateKeyPair();
      const bobKey = await bob.generateKeyPair();

      await alice.deriveSharedKey(bobKey);
      await bob.deriveSharedKey(aliceKey);

      const original = new Uint8Array(16 * 1024); // 16KB
      for (let i = 0; i < original.length; i++) original[i] = i % 256;

      const encrypted = await alice.encrypt(original.buffer);
      const decrypted = await bob.decrypt(encrypted);

      expect(new Uint8Array(decrypted)).toEqual(original);
    });

    it('同一データの2回暗号化でIVが異なる', async () => {
      const alice = new EncryptionService();
      const bob = new EncryptionService();

      const aliceKey = await alice.generateKeyPair();
      const bobKey = await bob.generateKeyPair();

      await alice.deriveSharedKey(bobKey);

      const data = new Uint8Array([1, 2, 3]).buffer;
      const encrypted1 = await alice.encrypt(data);
      const encrypted2 = await alice.encrypt(data);

      // IVが異なることを確認
      expect(encrypted1.iv).not.toEqual(encrypted2.iv);
    });
  });

  describe('serializeEncryptedData / deserializeEncryptedData', () => {
    it('ラウンドトリップでIVとciphertextが保持される', async () => {
      const alice = new EncryptionService();
      const bob = new EncryptionService();

      const aliceKey = await alice.generateKeyPair();
      const bobKey = await bob.generateKeyPair();

      await alice.deriveSharedKey(bobKey);
      await bob.deriveSharedKey(aliceKey);

      const original = new Uint8Array([10, 20, 30, 40, 50]);
      const encrypted = await alice.encrypt(original.buffer);

      // シリアライズ → デシリアライズ
      const serialized = alice.serializeEncryptedData(encrypted);
      const deserialized = bob.deserializeEncryptedData(serialized);

      // デシリアライズしたデータから復号
      const decrypted = await bob.decrypt(deserialized);
      expect(new Uint8Array(decrypted)).toEqual(original);
    });

    it('シリアライズ形式が [IV (12 bytes)] + [ciphertext] である', async () => {
      const service = new EncryptionService();
      const iv = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      const ciphertext = new Uint8Array([100, 200]).buffer;

      const serialized = service.serializeEncryptedData({ iv, ciphertext });
      const bytes = new Uint8Array(serialized);

      // 合計14バイト: IV(12) + ciphertext(2)
      expect(bytes.length).toBe(14);
      // 先頭12バイトがIV
      expect(bytes.slice(0, 12)).toEqual(iv);
      // 残りがciphertext
      expect(bytes.slice(12)).toEqual(new Uint8Array([100, 200]));
    });
  });

  describe('clearKeys', () => {
    it('clearKeys後にisReadyがfalseを返す', async () => {
      const alice = new EncryptionService();
      const bob = new EncryptionService();

      const aliceKey = await alice.generateKeyPair();
      const bobKey = await bob.generateKeyPair();

      await alice.deriveSharedKey(bobKey);
      expect(alice.isReady()).toBe(true);

      alice.clearKeys();
      expect(alice.isReady()).toBe(false);
    });
  });
});
