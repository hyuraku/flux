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

  setMetadata(metadata: ChunkMetadata): void {
    this.metadata = metadata;
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

  addChunk(chunk: Chunk): boolean {
    if (this.receivedChunks.has(chunk.index)) {
      return false; // Duplicate chunk
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
    for (let i = 0; i < this.metadata.totalChunks; i++) {
      const chunk = this.receivedChunks.get(i);
      if (!chunk) {
        throw new Error(`Missing chunk ${i}`);
      }
      // Ensure we get a proper ArrayBuffer (not SharedArrayBuffer)
      const buffer = chunk.buffer instanceof ArrayBuffer
        ? chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
        : new Uint8Array(chunk).buffer;
      chunks.push(buffer as ArrayBuffer);
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
