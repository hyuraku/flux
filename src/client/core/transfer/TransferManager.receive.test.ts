import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TransferManager,
  CAPABILITY_TIMEOUT_MS,
  INCOMPATIBLE_RECEIVER_MESSAGE,
  PROTOCOL_VERSION,
} from './TransferManager';
import { ChunkManager, MAX_TRANSFER_BYTES, type ChunkMetadata } from './ChunkManager';
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

  // CompressionService の振る舞いをテストごとに切り替える
  const compression = { isSupported: true, shouldCompress: false };

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

  return {
    signalingHandlers,
    webrtcHandlers,
    pendingDecompress,
    decompress,
    compression,
    signalingClient,
    webrtcConnection,
  };
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
    shouldCompress: () => mocks.compression.shouldCompress,
    compress: (data: Uint8Array) => Promise.resolve(data),
    decompress: mocks.decompress,
  }));
  (CompressionServiceMock as unknown as { isSupported: () => boolean }).isSupported = () =>
    mocks.compression.isSupported;
  return { CompressionService: CompressionServiceMock };
});

const CHUNK_SIZE = 16 * 1024;

function metadataMessage(
  fileName: string,
  totalSize: number,
  compressed: boolean,
  fileIndex = 0
): string {
  const metadata: ChunkMetadata = {
    totalChunks: 1,
    totalSize,
    chunkSize: CHUNK_SIZE,
    fileName,
    fileType: 'text/plain',
  };
  return JSON.stringify({ type: 'file_metadata', fileIndex, metadata, compressed });
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
    mocks.compression.isSupported = true;
    mocks.compression.shouldCompress = false;

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
    injectData(metadataMessage('second.txt', 3, false, 1));
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
    injectData(metadataMessage('later.txt', 3, false, 1));
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

/** sendJSON で送られた制御メッセージ一覧 */
function sentJson(): Array<Record<string, unknown>> {
  return mocks.webrtcConnection.sendJSON.mock.calls.map(
    (call: unknown[]) => call[0] as Record<string, unknown>
  );
}

function sentTypes(): string[] {
  return sentJson().map(message => message.type as string);
}

function capabilitiesMessage(
  supportsDecompression: boolean,
  protocolVersion: number = PROTOCOL_VERSION
): string {
  return JSON.stringify({
    type: 'receiver_capabilities',
    protocolVersion,
    supportsDecompression,
    maxTransferBytes: MAX_TRANSFER_BYTES,
  });
}

describe('受信側の能力通知・検証・ACK', () => {
  let manager: TransferManager;
  let receivedFiles: File[];
  let errorEvents: { message?: string }[];

  async function setupReceiver(): Promise<void> {
    await manager.initializeAsReceiver();
    mocks.signalingHandlers.get('peer_joined')?.({
      type: 'peer_joined',
      data: { role: 'sender', peerId: 'peer-1' },
    });
    mocks.webrtcHandlers.get('connected')?.({ type: 'connected' });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.signalingHandlers.clear();
    mocks.webrtcHandlers.clear();
    mocks.pendingDecompress.length = 0;
    mocks.compression.isSupported = true;
    mocks.compression.shouldCompress = false;

    manager = new TransferManager();
    receivedFiles = [];
    errorEvents = [];
    manager.on('file_received', (event) => receivedFiles.push(event.data as File));
    manager.on('error', (event) => errorEvents.push(event.data as { message?: string }));
  });

  afterEach(() => {
    manager.cleanup();
  });

  it('接続直後に receiver_capabilities を送る', async () => {
    await setupReceiver();

    expect(sentJson()[0]).toEqual({
      type: 'receiver_capabilities',
      protocolVersion: PROTOCOL_VERSION,
      supportsDecompression: true,
      maxTransferBytes: MAX_TRANSFER_BYTES,
    });
  });

  it('解凍非対応なら supportsDecompression: false を通知する', async () => {
    mocks.compression.isSupported = false;
    await setupReceiver();

    expect(sentJson()[0]).toMatchObject({ supportsDecompression: false });
  });

  it('解凍非対応なのに compressed の metadata が来るとエラーになり file_received は発火しない', async () => {
    mocks.compression.isSupported = false;
    await setupReceiver();

    injectData(metadataMessage('compressed.txt', 3, true));
    injectData(chunkMessage(bytesOf('AAA')));
    await drainReceiveQueue(manager);

    expect(manager.currentStatus).toBe('error');
    expect(receivedFiles).toHaveLength(0);
    expect(errorEvents[0]?.message).toContain('cannot decompress');
    // 送信側にも失敗を伝える
    expect(sentJson().find(m => m.type === 'transfer_error')).toMatchObject({
      type: 'transfer_error',
    });
  });

  it('検証が成功したファイルごとに file_ack を送ってから file_received を発火する', async () => {
    await setupReceiver();

    injectData(metadataMessage('ok.txt', 3, false));
    injectData(chunkMessage(bytesOf('BBB')));
    await drainReceiveQueue(manager);

    expect(sentJson()).toContainEqual({
      type: 'file_ack',
      fileIndex: 0,
      fileName: 'ok.txt',
      size: 3,
    });
    expect(receivedFiles).toHaveLength(1);
  });

  it('解凍後のサイズが宣言と違うとエラーになる', async () => {
    await setupReceiver();

    injectData(metadataMessage('lying.txt', 3, true));
    injectData(chunkMessage(new Uint8Array([1, 2]), 3));
    await flushMicrotasks();
    // 3 bytes と宣言されたチャンクが 100 bytes に解凍された
    mocks.pendingDecompress[0].resolve(new Uint8Array(100));
    await drainReceiveQueue(manager);

    expect(manager.currentStatus).toBe('error');
    expect(receivedFiles).toHaveLength(0);
    expect(errorEvents[0]?.message).toContain('size mismatch after decompression');
  });

  it('宣言サイズと実データ長が違うチャンクはエラーになる', async () => {
    await setupReceiver();

    injectData(metadataMessage('lying.txt', 3, false));
    injectData(chunkMessage(new Uint8Array(100), 3));
    await drainReceiveQueue(manager);

    expect(manager.currentStatus).toBe('error');
    expect(receivedFiles).toHaveLength(0);
    expect(errorEvents[0]?.message).toContain('declared 3 bytes, got 100 bytes');
  });

  it('転送全体の合計が上限を超えるとエラーになる', async () => {
    await setupReceiver();

    injectData(metadataMessage('small.txt', 3, false));
    injectData(chunkMessage(bytesOf('BBB')));
    await drainReceiveQueue(manager);
    expect(receivedFiles).toHaveLength(1);

    // 2 ファイル目で合計が上限を超える
    const metadata: ChunkMetadata = {
      totalChunks: Math.ceil(MAX_TRANSFER_BYTES / CHUNK_SIZE),
      totalSize: MAX_TRANSFER_BYTES,
      chunkSize: CHUNK_SIZE,
      fileName: 'huge.bin',
      fileType: 'application/octet-stream',
    };
    injectData(JSON.stringify({ type: 'file_metadata', fileIndex: 1, metadata, compressed: false }));
    await drainReceiveQueue(manager);

    expect(manager.currentStatus).toBe('error');
    expect(errorEvents[0]?.message).toContain('exceeds the receive limit');
  });

  it('未完了のファイルがある状態で transfer_complete が来るとエラーになる', async () => {
    await setupReceiver();

    injectData(metadataMessage('incomplete.txt', 3, false));
    injectData(JSON.stringify({ type: 'transfer_complete' }));
    await drainReceiveQueue(manager);

    expect(manager.currentStatus).toBe('error');
    expect(errorEvents[0]?.message).toContain('unfinished files: 0');
  });
});

describe('送信側の能力交換と ACK 待ち', () => {
  let manager: TransferManager;
  let errorEvents: { message?: string }[];

  async function connectAsSender(files: File[]): Promise<void> {
    await manager.initializeAsSender('1234', files);
    mocks.signalingHandlers.get('webrtc_offer')?.({
      type: 'webrtc_offer',
      data: { fromPeerId: 'peer-1', sdp: JSON.stringify({ type: 'offer' }) },
    });
    mocks.webrtcHandlers.get('connected')?.({ type: 'connected' });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.signalingHandlers.clear();
    mocks.webrtcHandlers.clear();
    mocks.pendingDecompress.length = 0;
    mocks.compression.isSupported = true;
    mocks.compression.shouldCompress = false;

    manager = new TransferManager();
    errorEvents = [];
    manager.on('error', (event) => errorEvents.push(event.data as { message?: string }));
  });

  afterEach(() => {
    manager.cleanup();
    vi.useRealTimers();
  });

  it('receiver_capabilities が届くまで file_metadata を送らない', async () => {
    await connectAsSender([new File(['abc'], 'a.txt', { type: 'text/plain' })]);

    await vi.advanceTimersByTimeAsync(500);
    expect(sentTypes()).not.toContain('file_metadata');

    injectData(capabilitiesMessage(true));
    await vi.advanceTimersByTimeAsync(500);
    expect(sentTypes()).toContain('file_metadata');
  });

  it('受信側が解凍非対応なら compressed: false で送る', async () => {
    mocks.compression.shouldCompress = true;
    await connectAsSender([new File(['abc'], 'a.txt', { type: 'text/plain' })]);

    injectData(capabilitiesMessage(false));
    await vi.advanceTimersByTimeAsync(500);

    expect(sentJson().find(m => m.type === 'file_metadata')).toMatchObject({ compressed: false });
  });

  it('双方が対応していれば compressed: true で送る', async () => {
    mocks.compression.shouldCompress = true;
    await connectAsSender([new File(['abc'], 'a.txt', { type: 'text/plain' })]);

    injectData(capabilitiesMessage(true));
    await vi.advanceTimersByTimeAsync(500);

    expect(sentJson().find(m => m.type === 'file_metadata')).toMatchObject({ compressed: true });
  });

  it('capabilities が届かないままタイムアウトするとエラーになる', async () => {
    await connectAsSender([new File(['abc'], 'a.txt', { type: 'text/plain' })]);

    await vi.advanceTimersByTimeAsync(CAPABILITY_TIMEOUT_MS + 100);

    expect(manager.currentStatus).toBe('error');
    expect(errorEvents).toContainEqual({ message: INCOMPATIBLE_RECEIVER_MESSAGE });
    expect(sentTypes()).not.toContain('file_metadata');
  });

  it('プロトコルバージョンが違うとエラーになる', async () => {
    await connectAsSender([new File(['abc'], 'a.txt', { type: 'text/plain' })]);

    injectData(capabilitiesMessage(true, 1));
    await vi.advanceTimersByTimeAsync(100);

    expect(manager.currentStatus).toBe('error');
    expect(errorEvents).toContainEqual({ message: INCOMPATIBLE_RECEIVER_MESSAGE });
    expect(sentTypes()).not.toContain('file_metadata');
  });

  it('file_ack を受け取るまで次のファイルを送らず、全 ACK 後にのみ完了する', async () => {
    await connectAsSender([
      new File(['abc'], 'a.txt', { type: 'text/plain' }),
      new File(['de'], 'b.txt', { type: 'text/plain' }),
    ]);

    injectData(capabilitiesMessage(true));
    await vi.advanceTimersByTimeAsync(500);

    const metadataCount = () => sentJson().filter(m => m.type === 'file_metadata').length;
    expect(metadataCount()).toBe(1);
    expect(sentTypes()).not.toContain('transfer_complete');
    expect(manager.currentStatus).toBe('transferring');

    injectData(JSON.stringify({ type: 'file_ack', fileIndex: 0, fileName: 'a.txt', size: 3 }));
    await vi.advanceTimersByTimeAsync(500);

    expect(metadataCount()).toBe(2);
    expect(sentTypes()).not.toContain('transfer_complete');
    expect(manager.currentStatus).toBe('transferring');

    injectData(JSON.stringify({ type: 'file_ack', fileIndex: 1, fileName: 'b.txt', size: 2 }));
    await vi.advanceTimersByTimeAsync(500);

    expect(sentTypes()).toContain('transfer_complete');
    expect(manager.currentStatus).toBe('completed');
  });

  it('受信側から transfer_error が来ると error になり完了扱いにならない', async () => {
    await connectAsSender([new File(['abc'], 'a.txt', { type: 'text/plain' })]);

    injectData(capabilitiesMessage(true));
    await vi.advanceTimersByTimeAsync(500);

    injectData(JSON.stringify({ type: 'transfer_error', message: 'Chunk 0 size mismatch' }));
    await vi.advanceTimersByTimeAsync(100);

    expect(manager.currentStatus).toBe('error');
    expect(errorEvents).toContainEqual({ message: 'Chunk 0 size mismatch' });
    expect(sentTypes()).not.toContain('transfer_complete');
  });

  it('ACK 待ちのまま切断されても待機が解放される', async () => {
    await connectAsSender([new File(['abc'], 'a.txt', { type: 'text/plain' })]);

    injectData(capabilitiesMessage(true));
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.currentStatus).toBe('transferring');

    mocks.webrtcHandlers.get('disconnected')?.({ type: 'disconnected' });
    await vi.advanceTimersByTimeAsync(100);

    expect(manager.currentStatus).toBe('error');
    expect(errorEvents).toContainEqual({ message: 'Connection lost' });
    expect(sentTypes()).not.toContain('transfer_complete');
  });
});
