import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CompressionService } from './CompressionService';

describe('CompressionService', () => {
  let service: CompressionService;

  beforeEach(() => {
    service = new CompressionService();
  });

  describe('isSupported', () => {
    it('CompressionStreamが利用可能な場合はtrueを返す', () => {
      expect(CompressionService.isSupported()).toBe(true);
    });
  });

  describe('shouldCompress', () => {
    it('10KB未満はfalse', () => {
      expect(service.shouldCompress(10 * 1024 - 1)).toBe(false);
    });

    it('10KBはtrue', () => {
      expect(service.shouldCompress(10 * 1024)).toBe(true);
    });

    it('100MBはtrue', () => {
      expect(service.shouldCompress(100 * 1024 * 1024)).toBe(true);
    });

    it('100MB超はfalse', () => {
      expect(service.shouldCompress(100 * 1024 * 1024 + 1)).toBe(false);
    });
  });

  describe('compress / decompress ラウンドトリップ', () => {
    it('繰り返しパターンデータで一致する', async () => {
      const pattern = new TextEncoder().encode('ABCDEFGHIJ');
      const data = new Uint8Array(1000);
      for (let i = 0; i < data.length; i++) data[i] = pattern[i % pattern.length];

      const compressed = await service.compress(data);
      const decompressed = await service.decompress(compressed);

      expect(decompressed).toEqual(data);
    });

    it('圧縮でサイズが小さくなる（高圧縮率データ）', async () => {
      const data = new Uint8Array(10000).fill(0);
      const compressed = await service.compress(data);

      expect(compressed.byteLength).toBeLessThan(data.byteLength);
    });

    it('ランダムデータのラウンドトリップが成功する', async () => {
      const data = new Uint8Array(500);
      for (let i = 0; i < data.length; i++) data[i] = Math.floor(Math.random() * 256);

      const compressed = await service.compress(data);
      const decompressed = await service.decompress(compressed);

      expect(decompressed).toEqual(data);
    });

    it('空データのラウンドトリップが成功する', async () => {
      const data = new Uint8Array(0);
      const compressed = await service.compress(data);
      const decompressed = await service.decompress(compressed);

      expect(decompressed).toEqual(data);
    });
  });

  describe('CompressionStream利用不可時のフォールバック', () => {
    let originalCS: typeof globalThis.CompressionStream;
    let originalDS: typeof globalThis.DecompressionStream;

    beforeEach(() => {
      originalCS = globalThis.CompressionStream;
      originalDS = globalThis.DecompressionStream;
      vi.stubGlobal('CompressionStream', undefined);
      vi.stubGlobal('DecompressionStream', undefined);
    });

    afterEach(() => {
      vi.stubGlobal('CompressionStream', originalCS);
      vi.stubGlobal('DecompressionStream', originalDS);
    });

    it('isSupportedがfalseを返す', () => {
      expect(CompressionService.isSupported()).toBe(false);
    });

    it('compressはデータをそのまま返す', async () => {
      const data = new Uint8Array([1, 2, 3]);
      const result = await service.compress(data);
      expect(result).toEqual(data);
    });

    it('decompressはデータをそのまま返す', async () => {
      const data = new Uint8Array([4, 5, 6]);
      const result = await service.decompress(data);
      expect(result).toEqual(data);
    });
  });

  describe('getCompressionRatio', () => {
    it('圧縮率を正しく計算する', () => {
      expect(CompressionService.getCompressionRatio(1000, 300)).toBe(70);
    });

    it('originalSizeが0の場合は0を返す', () => {
      expect(CompressionService.getCompressionRatio(0, 0)).toBe(0);
    });
  });
});
