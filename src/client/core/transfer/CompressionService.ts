export type CompressionFormat = 'gzip' | 'deflate' | 'deflate-raw';

export class CompressionService {
  private format: CompressionFormat;
  private minSizeForCompression = 10 * 1024; // 10KB
  private maxSizeForCompression = 100 * 1024 * 1024; // 100MB

  constructor(format: CompressionFormat = 'gzip') {
    this.format = format;
  }

  static isSupported(): boolean {
    return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
  }

  shouldCompress(size: number): boolean {
    return size >= this.minSizeForCompression && size <= this.maxSizeForCompression;
  }

  async compress(data: Uint8Array): Promise<Uint8Array> {
    if (!CompressionService.isSupported()) {
      console.warn('CompressionStream not supported, returning uncompressed data');
      return data;
    }

    // Create a copy to ensure we have a proper ArrayBuffer
    const buffer = new Uint8Array(data).buffer as ArrayBuffer;
    const stream = new Blob([buffer]).stream();
    const compressedStream = stream.pipeThrough(new CompressionStream(this.format) as any);
    const compressedBlob = await new Response(compressedStream).blob();
    const compressedBuffer = await compressedBlob.arrayBuffer();

    return new Uint8Array(compressedBuffer);
  }

  async decompress(data: Uint8Array): Promise<Uint8Array> {
    if (!CompressionService.isSupported()) {
      console.warn('DecompressionStream not supported, returning data as-is');
      return data;
    }

    // Create a copy to ensure we have a proper ArrayBuffer
    const buffer = new Uint8Array(data).buffer as ArrayBuffer;
    const stream = new Blob([buffer]).stream();
    const decompressedStream = stream.pipeThrough(new DecompressionStream(this.format) as any);
    const decompressedBlob = await new Response(decompressedStream).blob();
    const decompressedBuffer = await decompressedBlob.arrayBuffer();

    return new Uint8Array(decompressedBuffer);
  }

  compressStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    if (!CompressionService.isSupported()) {
      return stream;
    }
    return stream.pipeThrough(new CompressionStream(this.format) as any);
  }

  decompressStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    if (!CompressionService.isSupported()) {
      return stream;
    }
    return stream.pipeThrough(new DecompressionStream(this.format) as any);
  }

  async compressFile(file: File): Promise<Blob> {
    if (!CompressionService.isSupported() || !this.shouldCompress(file.size)) {
      return file;
    }

    const compressedStream = (file.stream() as any).pipeThrough(new CompressionStream(this.format));
    return new Response(compressedStream).blob();
  }

  async decompressBlob(blob: Blob): Promise<Blob> {
    if (!CompressionService.isSupported()) {
      return blob;
    }

    const decompressedStream = (blob.stream() as any).pipeThrough(new DecompressionStream(this.format));
    return new Response(decompressedStream).blob();
  }

  // Get compression ratio for a given input/output
  static getCompressionRatio(originalSize: number, compressedSize: number): number {
    if (originalSize === 0) return 0;
    return ((originalSize - compressedSize) / originalSize) * 100;
  }
}
