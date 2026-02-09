import { describe, it, expect, beforeAll, vi } from 'vitest';
import { ChunkManager } from './ChunkManager';
import { CompressionService } from './CompressionService';

// jsdom環境ではCompressionStreamがない可能性があるため注入
beforeAll(async () => {
  if (typeof globalThis.CompressionStream === 'undefined') {
    const streamWeb = await import('stream/web');
    vi.stubGlobal('CompressionStream', (streamWeb as any).CompressionStream);
    vi.stubGlobal('DecompressionStream', (streamWeb as any).DecompressionStream);
  }
});

async function blobToArray(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

function toArray(data: Uint8Array): number[] {
  return Array.from(data);
}

/**
 * 送信パイプライン: File → split → (compress) → serialize
 */
async function senderPipeline(
  file: File,
  chunkSize: number,
  shouldCompress: boolean,
): Promise<{ serializedChunks: Uint8Array[]; compressed: boolean }> {
  const cm = new ChunkManager(chunkSize);
  const compression = new CompressionService();

  const serializedChunks: Uint8Array[] = [];
  for await (const chunk of cm.split(file)) {
    let data = chunk.data;
    if (shouldCompress) {
      data = await compression.compress(data);
    }
    serializedChunks.push(ChunkManager.serializeChunk({ ...chunk, data }));
  }

  return { serializedChunks, compressed: shouldCompress };
}

/**
 * 受信パイプライン: deserialize → (decompress) → addChunk → toFile
 */
async function receiverPipeline(
  serializedChunks: Uint8Array[],
  metadata: ReturnType<ChunkManager['createMetadata']>,
  isCompressed: boolean,
): Promise<File> {
  const cm = new ChunkManager(metadata.chunkSize);
  const compression = new CompressionService();
  cm.setMetadata(metadata);

  for (const serialized of serializedChunks) {
    const chunk = ChunkManager.deserializeChunk(serialized);
    if (isCompressed) {
      chunk.data = await compression.decompress(chunk.data);
    }
    cm.addChunk(chunk);
  }

  expect(cm.isComplete()).toBe(true);
  return cm.toFile();
}

describe('Transfer Pipeline 統合テスト', () => {
  const chunkSize = 1024; // 1KB chunks for faster tests

  describe('圧縮なし転送', () => {
    it('小さいファイル (< 10KB) のラウンドトリップ', async () => {
      const content = 'Hello, World!';
      const file = new File([content], 'small.txt', { type: 'text/plain' });
      const cm = new ChunkManager(chunkSize);
      const metadata = cm.createMetadata(file);

      const { serializedChunks } = await senderPipeline(file, chunkSize, false);
      const received = await receiverPipeline(serializedChunks, metadata, false);

      expect(received.name).toBe('small.txt');
      const receivedBytes = await blobToArray(received);
      const originalBytes = toArray(new TextEncoder().encode(content));
      expect(receivedBytes).toEqual(originalBytes);
    });

    it('複数チャンクのファイルのラウンドトリップ', async () => {
      const content = 'A'.repeat(3000); // 3KB > 1KB chunkSize
      const file = new File([content], 'multi.txt', { type: 'text/plain' });
      const cm = new ChunkManager(chunkSize);
      const metadata = cm.createMetadata(file);

      const { serializedChunks } = await senderPipeline(file, chunkSize, false);
      expect(serializedChunks.length).toBeGreaterThan(1);

      const received = await receiverPipeline(serializedChunks, metadata, false);
      const receivedBytes = await blobToArray(received);
      const originalBytes = toArray(new TextEncoder().encode(content));
      expect(receivedBytes).toEqual(originalBytes);
    });
  });

  describe('圧縮あり転送', () => {
    it('圧縮有効時に送受信するとデータが一致する（回帰テスト）', async () => {
      const content = 'CompressMe! '.repeat(1000); // ~12KB
      const file = new File([content], 'compressible.txt', { type: 'text/plain' });
      const cm = new ChunkManager(chunkSize);
      const metadata = cm.createMetadata(file);

      const { serializedChunks } = await senderPipeline(file, chunkSize, true);
      const received = await receiverPipeline(serializedChunks, metadata, true);

      const receivedBytes = await blobToArray(received);
      const originalBytes = toArray(new TextEncoder().encode(content));
      expect(receivedBytes).toEqual(originalBytes);
    });

    it('解凍せずに結合するとデータが一致しない（バグの再現）', async () => {
      const content = 'CompressMe! '.repeat(1000);
      const file = new File([content], 'broken.txt', { type: 'text/plain' });
      const cm = new ChunkManager(chunkSize);
      const metadata = cm.createMetadata(file);

      const { serializedChunks } = await senderPipeline(file, chunkSize, true);
      // 意図的に isCompressed=false で受信（解凍しない = バグの再現）
      const broken = await receiverPipeline(serializedChunks, metadata, false);

      const brokenBytes = await blobToArray(broken);
      const originalBytes = toArray(new TextEncoder().encode(content));
      expect(brokenBytes).not.toEqual(originalBytes);
    });

    it('compressed=falseなら解凍をスキップしても正常', async () => {
      const content = 'NoCompress '.repeat(500);
      const file = new File([content], 'nocomp.txt', { type: 'text/plain' });
      const cm = new ChunkManager(chunkSize);
      const metadata = cm.createMetadata(file);

      const { serializedChunks } = await senderPipeline(file, chunkSize, false);
      const received = await receiverPipeline(serializedChunks, metadata, false);

      const receivedBytes = await blobToArray(received);
      const originalBytes = toArray(new TextEncoder().encode(content));
      expect(receivedBytes).toEqual(originalBytes);
    });

    it('バイナリファイルの圧縮転送ラウンドトリップ', async () => {
      const data = new Uint8Array(3000);
      for (let i = 0; i < data.length; i++) data[i] = Math.floor(Math.random() * 256);
      const file = new File([data], 'random.bin', { type: 'application/octet-stream' });
      const cm = new ChunkManager(chunkSize);
      const metadata = cm.createMetadata(file);

      const { serializedChunks } = await senderPipeline(file, chunkSize, true);
      const received = await receiverPipeline(serializedChunks, metadata, true);

      const receivedBytes = await blobToArray(received);
      expect(receivedBytes).toEqual(toArray(data));
    });
  });

  describe('メタデータの圧縮フラグ', () => {
    it('shouldCompress=trueのとき圧縮パイプラインが有効になる', () => {
      const compression = new CompressionService();
      expect(compression.shouldCompress(12 * 1024)).toBe(true);
    });

    it('shouldCompress=falseのとき圧縮パイプラインが無効', () => {
      const compression = new CompressionService();
      expect(compression.shouldCompress(5 * 1024)).toBe(false);
    });
  });

  describe('エッジケース', () => {
    it('1バイトファイルの転送', async () => {
      const file = new File([new Uint8Array([42])], 'one.bin');
      const cm = new ChunkManager(chunkSize);
      const metadata = cm.createMetadata(file);

      const { serializedChunks } = await senderPipeline(file, chunkSize, false);
      const received = await receiverPipeline(serializedChunks, metadata, false);

      const receivedBytes = await blobToArray(received);
      expect(receivedBytes).toEqual([42]);
    });

    it('ちょうどチャンクサイズのファイル', async () => {
      const data = new Uint8Array(chunkSize).fill(99);
      const file = new File([data], 'exact.bin');
      const cm = new ChunkManager(chunkSize);
      const metadata = cm.createMetadata(file);

      const { serializedChunks } = await senderPipeline(file, chunkSize, false);
      expect(serializedChunks).toHaveLength(1);

      const received = await receiverPipeline(serializedChunks, metadata, false);
      const receivedBytes = await blobToArray(received);
      expect(receivedBytes).toEqual(toArray(data));
    });

    it('圧縮閾値ちょうど (10KB) のファイルの圧縮転送', async () => {
      const data = new Uint8Array(10 * 1024).fill(0);
      const file = new File([data], 'threshold.bin');
      const cm = new ChunkManager(chunkSize);
      const metadata = cm.createMetadata(file);
      const compression = new CompressionService();

      expect(compression.shouldCompress(file.size)).toBe(true);

      const { serializedChunks } = await senderPipeline(file, chunkSize, true);
      const received = await receiverPipeline(serializedChunks, metadata, true);

      const receivedBytes = await blobToArray(received);
      expect(receivedBytes).toEqual(toArray(data));
    });
  });
});
