import { describe, it, expect, beforeEach } from 'vitest';
import { ChunkManager, MAX_CHUNK_SIZE, MAX_TRANSFER_BYTES, type Chunk } from './ChunkManager';
import { blobToArray, toArray } from '../../test/helpers';

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

    it('ペイロードは入力バッファから独立したコピーになる', () => {
      const chunk: Chunk = { index: 7, data: new Uint8Array([1, 2, 3, 4]), size: 4 };
      const serialized = ChunkManager.serializeChunk(chunk);

      const result = ChunkManager.deserializeChunk(serialized);

      // データチャネルや解凍器が入力バッファを再利用しても壊れないこと。
      expect(result.data.buffer).not.toBe(serialized.buffer);
      expect(result.data.byteOffset).toBe(0);
      expect(result.data.byteLength).toBe(4);

      serialized.fill(0xff);
      expect(toArray(result.data)).toEqual([1, 2, 3, 4]);
    });

    it('部分 view を入力してもヘッダとペイロードを正しく読む', () => {
      const chunk: Chunk = { index: 9, data: new Uint8Array([5, 6, 7]), size: 3 };
      const serialized = ChunkManager.serializeChunk(chunk);

      // 前後にパディングを付けた大きなバッファ上の部分 view を渡す。
      const padded = new Uint8Array(serialized.byteLength + 8);
      padded.set(serialized, 4);
      const view = padded.subarray(4, 4 + serialized.byteLength);

      const result = ChunkManager.deserializeChunk(view);

      expect(result.index).toBe(9);
      expect(result.size).toBe(3);
      expect(result.data.byteOffset).toBe(0);
      expect(toArray(result.data)).toEqual([5, 6, 7]);
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

    it('toFile() 後に reset() してもファイルの中身は壊れない', async () => {
      const content = 'Blob owns the bytes. '.repeat(20);
      const file = new File([content], 'detached.txt', { type: 'text/plain' });

      const cm = new ChunkManager(16);
      cm.setMetadata(cm.createMetadata(file));
      for await (const chunk of cm.split(file)) {
        cm.addChunk(chunk);
      }

      const received = cm.toFile();
      // Blob 側がすでにバイト列を持っているので、Map を捨てても読み出せる。
      cm.reset();

      expect(cm.receivedCount).toBe(0);
      expect(cm.getMetadata()).toBeNull();

      const result = await blobToArray(received);
      expect(result).toEqual(toArray(new TextEncoder().encode(content)));
      expect(received.name).toBe('detached.txt');
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

  describe('setMetadata の検証', () => {
    it('totalChunks が totalSize/chunkSize と一致しないと例外', () => {
      expect(() =>
        manager.setMetadata({ totalChunks: 2, totalSize: 10, chunkSize: 16, fileName: 'a', fileType: 'text/plain' })
      ).toThrow('totalChunks');
    });

    it('fileName が空だと例外', () => {
      expect(() =>
        manager.setMetadata({ totalChunks: 1, totalSize: 5, chunkSize: 16, fileName: '', fileType: 'text/plain' })
      ).toThrow('fileName');
    });

    it('totalSize が負だと例外', () => {
      expect(() =>
        manager.setMetadata({ totalChunks: 0, totalSize: -1, chunkSize: 16, fileName: 'a', fileType: 'text/plain' })
      ).toThrow('totalSize');
    });

    it('totalSize が上限を超えると例外', () => {
      const totalSize = MAX_TRANSFER_BYTES + 1;
      expect(() =>
        manager.setMetadata({
          totalChunks: Math.ceil(totalSize / 16),
          totalSize,
          chunkSize: 16,
          fileName: 'huge.bin',
          fileType: 'application/octet-stream',
        })
      ).toThrow('exceeds the limit');
    });

    it('chunkSize が 0 だと例外', () => {
      expect(() =>
        manager.setMetadata({ totalChunks: 1, totalSize: 5, chunkSize: 0, fileName: 'a', fileType: 'text/plain' })
      ).toThrow('chunkSize');
    });

    it('chunkSize が上限を超えると例外', () => {
      expect(() =>
        manager.setMetadata({
          totalChunks: 1,
          totalSize: 5,
          chunkSize: MAX_CHUNK_SIZE + 1,
          fileName: 'a',
          fileType: 'text/plain',
        })
      ).toThrow('chunkSize');
    });

    it('空ファイル (totalSize 0, totalChunks 0) は許容される', () => {
      expect(() =>
        manager.setMetadata({ totalChunks: 0, totalSize: 0, chunkSize: 16, fileName: 'empty.txt', fileType: 'text/plain' })
      ).not.toThrow();
    });
  });

  describe('addChunk の検証', () => {
    beforeEach(() => {
      // 3 バイト × 1 チャンク + 最終 1 チャンク（chunkSize 3, totalSize 5）
      manager.setMetadata({ totalChunks: 2, totalSize: 5, chunkSize: 3, fileName: 'a', fileType: 'text/plain' });
    });

    it('正しいチャンクは true を返す', () => {
      expect(manager.addChunk({ index: 0, data: new Uint8Array(3), size: 3 })).toBe(true);
    });

    it('重複チャンクは例外', () => {
      const chunk: Chunk = { index: 0, data: new Uint8Array(3), size: 3 };

      expect(manager.addChunk(chunk)).toBe(true);
      expect(() => manager.addChunk(chunk)).toThrow('Duplicate chunk 0');
    });

    it('範囲外の index は例外', () => {
      expect(() => manager.addChunk({ index: 2, data: new Uint8Array(3), size: 3 })).toThrow(
        'Invalid chunk index 2'
      );
      expect(() => manager.addChunk({ index: -1, data: new Uint8Array(3), size: 3 })).toThrow(
        'Invalid chunk index -1'
      );
    });

    it('宣言サイズと実データ長が違うと例外', () => {
      expect(() => manager.addChunk({ index: 0, data: new Uint8Array(100), size: 3 })).toThrow(
        'declared 3 bytes, got 100 bytes'
      );
    });

    it('メタデータから期待されるサイズと違うと例外', () => {
      // index 0 は chunkSize (3) ちょうどのはずだが 2 バイトで届いた
      expect(() => manager.addChunk({ index: 0, data: new Uint8Array(2), size: 2 })).toThrow(
        'expected 3 bytes from metadata'
      );
    });

    it('メタデータ未設定なら例外', () => {
      const fresh = new ChunkManager(16);
      expect(() => fresh.addChunk({ index: 0, data: new Uint8Array(1), size: 1 })).toThrow(
        'no metadata set'
      );
    });
  });

  describe('isComplete / getMissingChunks', () => {
    beforeEach(() => {
      manager.setMetadata({ totalChunks: 3, totalSize: 30, chunkSize: 10, fileName: 'a', fileType: 'text/plain' });
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
      manager.setMetadata({ totalChunks: 4, totalSize: 40, chunkSize: 10, fileName: 'a', fileType: 'text/plain' });
      manager.addChunk({ index: 0, data: new Uint8Array(10), size: 10 });
      manager.addChunk({ index: 1, data: new Uint8Array(10), size: 10 });

      expect(manager.progress).toBe(50);
    });
  });

  describe('reset', () => {
    it('リセット後に全状態がクリアされる', () => {
      manager.setMetadata({ totalChunks: 1, totalSize: 5, chunkSize: 5, fileName: 'a', fileType: 'text/plain' });
      manager.addChunk({ index: 0, data: new Uint8Array(5), size: 5 });

      manager.reset();

      expect(manager.isComplete()).toBe(false);
      expect(manager.receivedCount).toBe(0);
      expect(manager.getMetadata()).toBeNull();
    });
  });
});
