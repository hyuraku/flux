import '@testing-library/jest-dom';
import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

// jsdom の Blob に arrayBuffer() / stream() がない場合のポリフィル
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function (): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

if (typeof Blob.prototype.stream !== 'function') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Blob.prototype.stream = function (): any {
    const blob = this;
    return new ReadableStream({
      async start(controller) {
        const buffer = await blob.arrayBuffer();
        controller.enqueue(new Uint8Array(buffer));
        controller.close();
      },
    });
  };
}

// jsdom には CompressionStream / DecompressionStream がないため Node.js から注入
if (typeof globalThis.CompressionStream === 'undefined') {
  // @ts-expect-error -- stream/web は Node.js 内部モジュールで型定義がない
  const streamWeb = await import('stream/web');
  globalThis.CompressionStream = streamWeb.CompressionStream;
  globalThis.DecompressionStream = streamWeb.DecompressionStream;
}

afterEach(() => {
  cleanup();
});
