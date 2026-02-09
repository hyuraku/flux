import { describe, it, expect, beforeEach } from 'vitest';
import { ChunkManager, type Chunk } from './ChunkManager';

async function blobToArray(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

function toArray(data: Uint8Array): number[] {
  return Array.from(data);
}

describe('ChunkManager', () => {
  let manager: ChunkManager;

  beforeEach(() => {
    manager = new ChunkManager(16);
  });

  describe('serializeChunk / deserializeChunk', () => {
    it('ラウンドトリップでデータが一致する', () => {
      const chunk: Chunk = {
        index: 0,
        data: new Uint8Array([72, 101, 108, 108, 111]),
        size: 5,
      };

      const serialized = ChunkManager.serializeChunk(chunk);
      const deserialized = ChunkManager.deserializeChunk(serialized);

      expect(deserialized.index).toBe(0);
      expect(deserialized.size).toBe(5);
      expect(deserialized.data).toEqual(chunk.data);
    });

    it('複数インデックスが正しく保存される', () => {
      for (const idx of [0, 1, 2, 255]) {
        const chunk: Chunk = { index: idx, data: new Uint8Array([idx]), size: 1 };
        const result = ChunkManager.deserializeChunk(ChunkManager.serializeChunk(chunk));
        expect(result.index).toBe(idx);
      }
    });

    it('大きなチャンク (64KB) のラウンドトリップが成功する', () => {
      const data = new Uint8Array(64 * 1024);
      for (let i = 0; i < data.length; i++) data[i] = i % 256;

      const chunk: Chunk = { index: 0, data, size: data.byteLength };
      const result = ChunkManager.deserializeChunk(ChunkManager.serializeChunk(chunk));

      expect(result.data).toEqual(data);
    });

    it('ArrayBufferを入力としてデシリアライズできる', () => {
      const chunk: Chunk = { index: 3, data: new Uint8Array([10, 20, 30]), size: 3 };
      const serialized = ChunkManager.serializeChunk(chunk);
      const result = ChunkManager.deserializeChunk(serialized.buffer as ArrayBuffer);

      expect(result.index).toBe(3);
      expect(result.data).toEqual(new Uint8Array([10, 20, 30]));
    });

    it('8バイト未満のデータでエラーになる', () => {
      expect(() => ChunkManager.deserializeChunk(new Uint8Array(4))).toThrow('too small');
    });
  });

  describe('split / merge ラウンドトリップ', () => {
    it('ファイルを分割して再結合すると元データと一致する', async () => {
      const content = 'Hello, World! '.repeat(10);
      const file = new File([content], 'test.txt', { type: 'text/plain' });

      const cm = new ChunkManager(16);
      const metadata = cm.createMetadata(file);
      cm.setMetadata(metadata);

      for await (const chunk of cm.split(file)) {
        cm.addChunk(chunk);
      }

      expect(cm.isComplete()).toBe(true);
      const result = await blobToArray(cm.toFile());
      const original = toArray(new TextEncoder().encode(content));
      expect(result).toEqual(original);
    });

    it('チャンクサイズより小さいファイルは1チャンクになる', async () => {
      const file = new File(['tiny'], 'tiny.txt');
      const cm = new ChunkManager(1024);
      const chunks: Chunk[] = [];
      for await (const chunk of cm.split(file)) chunks.push(chunk);

      expect(chunks).toHaveLength(1);
    });

    it('チャンクサイズの整数倍で正しく分割される', async () => {
      const data = new Uint8Array(32);
      const file = new File([data], 'exact.bin');
      const cm = new ChunkManager(16);
      const chunks: Chunk[] = [];
      for await (const chunk of cm.split(file)) chunks.push(chunk);

      expect(chunks).toHaveLength(2);
    });

    it('非整数倍で最後のチャンクが小さくなる', async () => {
      const data = new Uint8Array(50);
      const file = new File([data], 'uneven.bin');
      const cm = new ChunkManager(16);
      const chunks: Chunk[] = [];
      for await (const chunk of cm.split(file)) chunks.push(chunk);

      expect(chunks).toHaveLength(4); // 16+16+16+2
      expect(chunks[3].size).toBe(2);
    });
  });

  describe('createMetadata', () => {
    it('メタデータが正しく生成される', () => {
      const data = new Uint8Array(100);
      const file = new File([data], 'test.txt', { type: 'text/plain' });
      const metadata = manager.createMetadata(file);

      expect(metadata.fileName).toBe('test.txt');
      expect(metadata.fileType).toBe('text/plain');
      expect(metadata.totalSize).toBe(100);
      expect(metadata.chunkSize).toBe(16);
      expect(metadata.totalChunks).toBe(7); // ceil(100/16)
    });

    it('MIMEタイプがないファイルはapplication/octet-streamになる', () => {
      const file = new File([new Uint8Array(10)], 'noext');
      const metadata = manager.createMetadata(file);
      expect(metadata.fileType).toBe('application/octet-stream');
    });
  });

  describe('addChunk', () => {
    it('重複チャンクはfalseを返す', () => {
      manager.setMetadata({ totalChunks: 2, totalSize: 10, chunkSize: 16, fileName: 'a', fileType: 'text/plain' });
      const chunk: Chunk = { index: 0, data: new Uint8Array([1]), size: 1 };

      expect(manager.addChunk(chunk)).toBe(true);
      expect(manager.addChunk(chunk)).toBe(false);
    });
  });

  describe('isComplete / getMissingChunks', () => {
    beforeEach(() => {
      manager.setMetadata({ totalChunks: 3, totalSize: 30, chunkSize: 16, fileName: 'a', fileType: 'text/plain' });
    });

    it('メタデータ未設定時はfalseを返す', () => {
      const fresh = new ChunkManager();
      expect(fresh.isComplete()).toBe(false);
    });

    it('全チャンク受信でtrueを返す', () => {
      for (let i = 0; i < 3; i++) {
        manager.addChunk({ index: i, data: new Uint8Array(10), size: 10 });
      }
      expect(manager.isComplete()).toBe(true);
      expect(manager.getMissingChunks()).toEqual([]);
    });

    it('一部未受信でfalseを返す', () => {
      manager.addChunk({ index: 0, data: new Uint8Array(10), size: 10 });
      manager.addChunk({ index: 2, data: new Uint8Array(10), size: 10 });

      expect(manager.isComplete()).toBe(false);
      expect(manager.getMissingChunks()).toEqual([1]);
    });
  });

  describe('progress', () => {
    it('進捗率が正しく計算される', () => {
      manager.setMetadata({ totalChunks: 4, totalSize: 40, chunkSize: 16, fileName: 'a', fileType: 'text/plain' });
      manager.addChunk({ index: 0, data: new Uint8Array(10), size: 10 });
      manager.addChunk({ index: 1, data: new Uint8Array(10), size: 10 });

      expect(manager.progress).toBe(50);
    });
  });

  describe('reset', () => {
    it('リセット後に全状態がクリアされる', () => {
      manager.setMetadata({ totalChunks: 1, totalSize: 5, chunkSize: 16, fileName: 'a', fileType: 'text/plain' });
      manager.addChunk({ index: 0, data: new Uint8Array(5), size: 5 });

      manager.reset();

      expect(manager.isComplete()).toBe(false);
      expect(manager.receivedCount).toBe(0);
      expect(manager.getMetadata()).toBeNull();
    });
  });
});
