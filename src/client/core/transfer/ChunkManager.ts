import { MAX_FILE_SIZE } from '../../utils/validators';

export interface Chunk {
  index: number;
  data: Uint8Array;
  size: number;
  hash?: string;
}

export interface ChunkMetadata {
  totalChunks: number;
  totalSize: number;
  chunkSize: number;
  fileName: string;
  fileType: string;
}

/**
 * 受信側が受け入れる転送の上限。送信 UI の検証（validators.MAX_FILE_SIZE）と
 * 同じ値を使い、受信境界でも同じ上限を強制する。
 */
export const MAX_TRANSFER_BYTES = MAX_FILE_SIZE;

/** 受信側が受け入れる chunkSize の上限（16 MiB） */
export const MAX_CHUNK_SIZE = 16 * 1024 * 1024;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export class ChunkManager {
  private chunkSize: number;
  private receivedChunks: Map<number, Uint8Array> = new Map();
  private metadata: ChunkMetadata | null = null;

  constructor(chunkSize: number = 16 * 1024) { // 16KB default
    this.chunkSize = chunkSize;
  }

  get currentChunkSize(): number {
    return this.chunkSize;
  }

  get receivedCount(): number {
    return this.receivedChunks.size;
  }

  get totalChunks(): number {
    return this.metadata?.totalChunks ?? 0;
  }

  get progress(): number {
    if (!this.metadata) return 0;
    return (this.receivedChunks.size / this.metadata.totalChunks) * 100;
  }

  /**
   * メタデータを設定する。メタデータは送信者が完全に制御する未信頼入力なので、
   * ここで内部整合性と上限を検証する。違反時は例外を投げる。
   */
  setMetadata(metadata: ChunkMetadata): void {
    if (!metadata || typeof metadata !== 'object') {
      throw new Error('Invalid metadata: not an object');
    }

    if (typeof metadata.fileName !== 'string' || metadata.fileName.length === 0) {
      throw new Error('Invalid metadata: fileName must be a non-empty string');
    }

    if (!isNonNegativeInteger(metadata.totalSize)) {
      throw new Error('Invalid metadata: totalSize must be a non-negative integer');
    }

    if (metadata.totalSize > MAX_TRANSFER_BYTES) {
      throw new Error(
        `Invalid metadata: totalSize ${metadata.totalSize} exceeds the limit of ${MAX_TRANSFER_BYTES} bytes`
      );
    }

    if (!isNonNegativeInteger(metadata.chunkSize) || metadata.chunkSize === 0) {
      throw new Error('Invalid metadata: chunkSize must be a positive integer');
    }

    if (metadata.chunkSize > MAX_CHUNK_SIZE) {
      throw new Error(
        `Invalid metadata: chunkSize ${metadata.chunkSize} exceeds the limit of ${MAX_CHUNK_SIZE} bytes`
      );
    }

    if (!isNonNegativeInteger(metadata.totalChunks)) {
      throw new Error('Invalid metadata: totalChunks must be a non-negative integer');
    }

    const expectedChunks = Math.ceil(metadata.totalSize / metadata.chunkSize);
    if (metadata.totalChunks !== expectedChunks) {
      throw new Error(
        `Invalid metadata: totalChunks ${metadata.totalChunks} does not match totalSize/chunkSize (expected ${expectedChunks})`
      );
    }

    this.metadata = metadata;
  }

  /** index 番目のチャンクが持つべきバイト数 */
  private expectedChunkSize(index: number): number {
    const metadata = this.metadata!;
    const isLast = index === metadata.totalChunks - 1;
    return isLast
      ? metadata.totalSize - (metadata.totalChunks - 1) * metadata.chunkSize
      : metadata.chunkSize;
  }

  getMetadata(): ChunkMetadata | null {
    return this.metadata;
  }

  async *split(file: File): AsyncGenerator<Chunk> {
    const totalChunks = Math.ceil(file.size / this.chunkSize);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * this.chunkSize;
      const end = Math.min(start + this.chunkSize, file.size);
      const slice = file.slice(start, end);
      const buffer = await slice.arrayBuffer();
      const data = new Uint8Array(buffer);

      yield {
        index: i,
        data,
        size: data.byteLength,
      };
    }
  }

  createMetadata(file: File): ChunkMetadata {
    const totalChunks = Math.ceil(file.size / this.chunkSize);

    return {
      totalChunks,
      totalSize: file.size,
      chunkSize: this.chunkSize,
      fileName: file.name,
      fileType: file.type || 'application/octet-stream',
    };
  }

  /**
   * 受信チャンクを取り込む。index・サイズはいずれも未信頼入力なので、
   * メタデータから導かれる期待値と突き合わせる。違反時は例外を投げる。
   *
   * データチャネルは順序保証付きなので、重複到着は異常として扱う。
   */
  addChunk(chunk: Chunk): boolean {
    if (!this.metadata) {
      throw new Error('Cannot add chunk: no metadata set');
    }

    if (!isNonNegativeInteger(chunk.index) || chunk.index >= this.metadata.totalChunks) {
      throw new Error(
        `Invalid chunk index ${chunk.index}: expected 0..${this.metadata.totalChunks - 1}`
      );
    }

    if (this.receivedChunks.has(chunk.index)) {
      throw new Error(`Duplicate chunk ${chunk.index}`);
    }

    if (!isNonNegativeInteger(chunk.size)) {
      throw new Error(`Invalid chunk size ${chunk.size}: must be a non-negative integer`);
    }

    if (chunk.data.byteLength !== chunk.size) {
      throw new Error(
        `Chunk ${chunk.index} size mismatch: declared ${chunk.size} bytes, got ${chunk.data.byteLength} bytes`
      );
    }

    const expected = this.expectedChunkSize(chunk.index);
    if (chunk.size !== expected) {
      throw new Error(
        `Chunk ${chunk.index} size mismatch: expected ${expected} bytes from metadata, got ${chunk.size} bytes`
      );
    }

    this.receivedChunks.set(chunk.index, chunk.data);
    return true;
  }

  isComplete(): boolean {
    if (!this.metadata) return false;
    return this.receivedChunks.size === this.metadata.totalChunks;
  }

  getMissingChunks(): number[] {
    if (!this.metadata) return [];

    const missing: number[] = [];
    for (let i = 0; i < this.metadata.totalChunks; i++) {
      if (!this.receivedChunks.has(i)) {
        missing.push(i);
      }
    }
    return missing;
  }

  merge(): Blob {
    if (!this.metadata) {
      throw new Error('No metadata set');
    }

    if (!this.isComplete()) {
      throw new Error(`Missing chunks: ${this.getMissingChunks().join(', ')}`);
    }

    // Collect chunks in order
    const chunks: ArrayBuffer[] = [];
    let mergedBytes = 0;
    for (let i = 0; i < this.metadata.totalChunks; i++) {
      const chunk = this.receivedChunks.get(i);
      if (!chunk) {
        throw new Error(`Missing chunk ${i}`);
      }
      mergedBytes += chunk.byteLength;
      // Ensure we get a proper ArrayBuffer (not SharedArrayBuffer)
      const buffer = chunk.buffer instanceof ArrayBuffer
        ? chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
        : new Uint8Array(chunk).buffer;
      chunks.push(buffer as ArrayBuffer);
    }

    // 各チャンクは addChunk で検証済みだが、File 化の直前に合計も突き合わせる。
    if (mergedBytes !== this.metadata.totalSize) {
      throw new Error(
        `Received size mismatch: expected ${this.metadata.totalSize} bytes, got ${mergedBytes} bytes`
      );
    }

    return new Blob(chunks, { type: this.metadata.fileType });
  }

  toFile(): File {
    if (!this.metadata) {
      throw new Error('No metadata set');
    }

    const blob = this.merge();
    return new File([blob], this.metadata.fileName, { type: this.metadata.fileType });
  }

  reset(): void {
    this.receivedChunks.clear();
    this.metadata = null;
  }

  // Serialize chunk for transmission
  static serializeChunk(chunk: Chunk): Uint8Array {
    // Format: [4 bytes index][4 bytes size][data]
    const header = new ArrayBuffer(8);
    const view = new DataView(header);
    view.setUint32(0, chunk.index, true);
    view.setUint32(4, chunk.size, true);

    const result = new Uint8Array(8 + chunk.data.byteLength);
    result.set(new Uint8Array(header), 0);
    result.set(chunk.data, 8);

    return result;
  }

  // Deserialize chunk from transmission
  static deserializeChunk(data: Uint8Array | ArrayBuffer): Chunk {
    // Ensure we have a Uint8Array
    let uint8Data: Uint8Array;
    if (data instanceof ArrayBuffer) {
      uint8Data = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      uint8Data = data;
    } else {
      // Handle any other array-like object
      uint8Data = new Uint8Array(data as ArrayLike<number>);
    }

    // Ensure minimum size for header (8 bytes)
    if (uint8Data.byteLength < 8) {
      throw new Error(`Invalid chunk data: too small (${uint8Data.byteLength} bytes)`);
    }

    // Create a fresh ArrayBuffer copy to avoid any offset issues
    const buffer = new ArrayBuffer(uint8Data.byteLength);
    const bufferView = new Uint8Array(buffer);
    for (let i = 0; i < uint8Data.byteLength; i++) {
      bufferView[i] = uint8Data[i];
    }

    const view = new DataView(buffer);
    const index = view.getUint32(0, true);
    const size = view.getUint32(4, true);
    const chunkData = new Uint8Array(buffer.slice(8));

    return { index, data: chunkData, size };
  }
}
