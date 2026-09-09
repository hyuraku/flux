import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TransferManager } from './TransferManager';
import { ChunkManager, type ChunkMetadata } from './ChunkManager';
import { blobToArray } from '../../test/helpers';

// SignalingClient / WebRTCConnection のハンドラを捕捉し、
// テストから任意の受信データを注入できるようにする
const mocks = vi.hoisted(() => {
  type EventHandler = (event: { type: string; data?: unknown }) => void;
  type PendingDecompress = {
    resolve: (value: Uint8Array) => void;
    reject: (reason: unknown) => void;
  };

  const signalingHandlers = new Map<string, EventHandler>();
  const webrtcHandlers = new Map<string, EventHandler>();
  const pendingDecompress: PendingDecompress[] = [];

  // decompress の解決タイミングをテスト側から制御する
  const decompress = vi.fn(
    () =>
      new Promise<Uint8Array>((resolve, reject) => {
        pendingDecompress.push({ resolve, reject });
      })
  );

  const signalingClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    generateCode: vi.fn(),
    joinRoom: vi.fn(),
    sendOffer: vi.fn(),
    sendAnswer: vi.fn(),
    sendIceCandidate: vi.fn(),
    on: vi.fn((event: string, handler: EventHandler) => {
      signalingHandlers.set(event, handler);
      return () => signalingHandlers.delete(event);
    }),
    isConnected: true,
  };

  const webrtcConnection = {
    create: vi.fn(),
    signal: vi.fn(),
    send: vi.fn(),
    sendJSON: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn((event: string, handler: EventHandler) => {
      webrtcHandlers.set(event, handler);
      return () => webrtcHandlers.delete(event);
    }),
    isConnected: false,
  };

  return { signalingHandlers, webrtcHandlers, pendingDecompress, decompress, signalingClient, webrtcConnection };
});

vi.mock('../connection/SignalingClient', () => ({
  SignalingClient: vi.fn(() => mocks.signalingClient),
}));

vi.mock('../connection/WebRTCConnection', () => ({
  WebRTCConnection: vi.fn(() => mocks.webrtcConnection),
}));

// ChunkManager は実物を使う（受信経路の回帰テストのため）
vi.mock('./CompressionService', () => {
  const CompressionServiceMock = vi.fn(() => ({
    shouldCompress: () => false,
    compress: (data: Uint8Array) => Promise.resolve(data),
    decompress: mocks.decompress,
  }));
  (CompressionServiceMock as unknown as { isSupported: () => boolean }).isSupported = () => true;
  return { CompressionService: CompressionServiceMock };
});

const CHUNK_SIZE = 16 * 1024;

function metadataMessage(fileName: string, totalSize: number, compressed: boolean): string {
  const metadata: ChunkMetadata = {
    totalChunks: 1,
    totalSize,
    chunkSize: CHUNK_SIZE,
    fileName,
    fileType: 'text/plain',
  };
  return JSON.stringify({ type: 'file_metadata', metadata, compressed });
}

function chunkMessage(data: Uint8Array, size: number = data.byteLength): Uint8Array {
  return ChunkManager.serializeChunk({ index: 0, data, size });
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function arrayOf(text: string): number[] {
  return Array.from(bytesOf(text));
}

/** WebRTC の data イベントとして受信データを注入する */
function injectData(payload: Uint8Array | string): void {
  const handler = mocks.webrtcHandlers.get('data');
  if (!handler) throw new Error('data ハンドラが登録されていません');
  handler({ type: 'data', data: payload });
}

/** マイクロタスクを消化し、キューが解凍待ちで止まるところまで進める */
async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/** 受信キューに積まれた処理が全て終わるまで待つ */
async function drainReceiveQueue(manager: TransferManager): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await (manager as unknown as { receiveQueue: Promise<void> }).receiveQueue;
    await Promise.resolve();
  }
}

describe('TransferManager 受信処理の直列化', () => {
  let manager: TransferManager;
  let receivedFiles: File[];
  let eventOrder: string[];
  let errorEvents: unknown[];

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.signalingHandlers.clear();
    mocks.webrtcHandlers.clear();
    mocks.pendingDecompress.length = 0;

    manager = new TransferManager();
    receivedFiles = [];
    eventOrder = [];
    errorEvents = [];

    manager.on('file_received', (event) => {
      receivedFiles.push(event.data as File);
      eventOrder.push('file_received');
    });
    manager.on('transfer_complete', () => {
      eventOrder.push('transfer_complete');
    });
    manager.on('error', (event) => {
      errorEvents.push(event.data);
      eventOrder.push('error');
    });

    await manager.initializeAsReceiver();

    // peer_joined -> WebRTC ハンドラ登録、connected -> transferring
    mocks.signalingHandlers.get('peer_joined')?.({
      type: 'peer_joined',
      data: { role: 'sender', peerId: 'peer-1' },
    });
    mocks.webrtcHandlers.get('connected')?.({ type: 'connected' });
  });

  afterEach(() => {
    manager.cleanup();
  });

  it('解凍待ちの間に届いた次ファイルの metadata が前ファイルのチャンクを追い越さない', async () => {
    // first.txt は圧縮済み: 解凍は保留のままにする
    injectData(metadataMessage('first.txt', 3, true));
    injectData(chunkMessage(new Uint8Array([1, 2, 3, 4]), 3));
    // 解凍完了を待たずに second.txt と transfer_complete が到着
    injectData(metadataMessage('second.txt', 3, false));
    injectData(chunkMessage(bytesOf('BBB')));
    injectData(JSON.stringify({ type: 'transfer_complete' }));

    // ここまでで解凍待ちは first.txt の 1 件だけのはず
    await flushMicrotasks();
    expect(mocks.pendingDecompress).toHaveLength(1);

    mocks.pendingDecompress[0].resolve(bytesOf('AAA'));
    await drainReceiveQueue(manager);

    expect(receivedFiles).toHaveLength(2);
    expect(receivedFiles[0].name).toBe('first.txt');
    expect(await blobToArray(receivedFiles[0])).toEqual(arrayOf('AAA'));
    expect(receivedFiles[1].name).toBe('second.txt');
    expect(await blobToArray(receivedFiles[1])).toEqual(arrayOf('BBB'));

    expect(eventOrder).toEqual(['file_received', 'file_received', 'transfer_complete']);
    expect(manager.currentStatus).toBe('completed');
  });

  it('単一ファイルの解凍待ち中に transfer_complete が届いても file_received が先に発火する', async () => {
    injectData(metadataMessage('only.txt', 3, true));
    injectData(chunkMessage(new Uint8Array([9, 9]), 3));
    injectData(JSON.stringify({ type: 'transfer_complete' }));

    await flushMicrotasks();
    expect(manager.currentStatus).toBe('transferring');

    mocks.pendingDecompress[0].resolve(bytesOf('AAA'));
    await drainReceiveQueue(manager);

    expect(eventOrder).toEqual(['file_received', 'transfer_complete']);
    expect(receivedFiles).toHaveLength(1);
    expect(await blobToArray(receivedFiles[0])).toEqual(arrayOf('AAA'));
    expect(manager.currentStatus).toBe('completed');
  });

  it('キュー処理中のエラーで error は 1 回だけ発火し、後続データは処理されない', async () => {
    injectData(metadataMessage('broken.txt', 3, true));
    injectData(chunkMessage(new Uint8Array([1, 2, 3]), 3));

    await flushMicrotasks();
    mocks.pendingDecompress[0].reject(new Error('decompress failed'));
    await drainReceiveQueue(manager);

    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toEqual({ message: 'decompress failed' });
    expect(manager.currentStatus).toBe('error');

    // エラー後に届いたデータは無視される
    injectData(metadataMessage('later.txt', 3, false));
    injectData(chunkMessage(bytesOf('BBB')));
    injectData(JSON.stringify({ type: 'transfer_complete' }));
    await drainReceiveQueue(manager);

    expect(receivedFiles).toHaveLength(0);
    expect(errorEvents).toHaveLength(1);
    expect(eventOrder).toEqual(['error']);
    expect(manager.currentStatus).toBe('error');
  });

  it('cancel 後に解凍が完了しても file_received / transfer_complete は発火しない', async () => {
    injectData(metadataMessage('cancelled.txt', 3, true));
    injectData(chunkMessage(new Uint8Array([1, 2, 3]), 3));
    injectData(JSON.stringify({ type: 'transfer_complete' }));

    await flushMicrotasks();
    expect(mocks.pendingDecompress).toHaveLength(1);

    manager.cancel();
    mocks.pendingDecompress[0].resolve(bytesOf('AAA'));
    await drainReceiveQueue(manager);

    expect(eventOrder).toEqual([]);
    expect(receivedFiles).toHaveLength(0);
    expect(manager.currentStatus).toBe('cancelled');
  });
});
