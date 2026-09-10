import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TransferManager, PROTOCOL_VERSION, type TransferStatus } from './TransferManager';
import { MAX_TRANSFER_BYTES } from './ChunkManager';
import { BUFFERED_AMOUNT_HIGH_WATERMARK } from '../connection/WebRTCConnection';
import { FakeDataChannel, createFakePeerConnection } from '../../test/fakeDataChannel';

// SignalingClient だけをモックし、WebRTCConnection / ChunkManager は実物を使う。
// これにより「送信ループ -> バックプレッシャ -> 実データチャネル」まで通しで検証できる。
const mocks = vi.hoisted(() => {
  type EventHandler = (event: { type: string; data?: unknown }) => void;
  const signalingHandlers = new Map<string, EventHandler>();

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

  return { signalingHandlers, signalingClient };
});

vi.mock('../connection/SignalingClient', () => ({
  SignalingClient: vi.fn(() => mocks.signalingClient),
}));

const CHUNK_SIZE = 128 * 1024;
const FILE_SIZE = 2 * 1024 * 1024;
const TOTAL_CHUNKS = FILE_SIZE / CHUNK_SIZE;
/** 1 tick あたりに送信済みにするバイト数 */
const DRAIN_PER_TICK = 200 * 1024;

let channel: FakeDataChannel;

function capabilitiesMessage(): string {
  return JSON.stringify({
    type: 'receiver_capabilities',
    protocolVersion: PROTOCOL_VERSION,
    supportsDecompression: false,
    maxTransferBytes: MAX_TRANSFER_BYTES,
  });
}

function ackMessage(fileIndex: number, fileName: string, size: number): string {
  return JSON.stringify({ type: 'file_ack', fileIndex, fileName, size });
}

/** バイナリで送られたチャンクだけを取り出す */
function sentChunks(): ArrayBuffer[] {
  return channel.sent.filter((payload): payload is ArrayBuffer => typeof payload !== 'string');
}

function sentJson(): { type?: string }[] {
  return channel.sent
    .filter((payload): payload is string => typeof payload === 'string')
    .map(text => JSON.parse(text) as { type?: string });
}

/** イベントループを 1 周させる（Blob 読み込みなどのタスクを進める） */
function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/** 送信ループがバッファ空き待ちに入るまで進める */
async function waitUntilBlocked(): Promise<void> {
  for (let i = 0; i < 200 && channel.listenerCount('bufferedamountlow') === 0; i++) {
    await tick();
  }
  if (channel.listenerCount('bufferedamountlow') === 0) {
    throw new Error('送信ループがバッファ空き待ちに入らなかった');
  }
}

/** 送信側として接続完了（データチャネル open）まで進める */
async function connectAsSender(manager: TransferManager, files: File[]): Promise<void> {
  await manager.initializeAsSender('123456', files);

  mocks.signalingHandlers.get('webrtc_offer')?.({
    type: 'webrtc_offer',
    data: { fromPeerId: 'peer-1', sdp: JSON.stringify({ type: 'offer', sdp: 'remote' }) },
  });

  // 送信側は非 initiator なので、相手からデータチャネルを受け取る
  const pc = (globalThis.RTCPeerConnection as unknown as { lastInstance: ReturnType<typeof createFakePeerConnection> }).lastInstance;
  pc.ondatachannel?.({ channel });
  channel.open();
}

function stubPeerConnection(): void {
  const pc = createFakePeerConnection(channel);
  const ctor = vi.fn(() => pc) as unknown as { lastInstance: typeof pc };
  ctor.lastInstance = pc;

  vi.stubGlobal('RTCPeerConnection', ctor);
  vi.stubGlobal('RTCSessionDescription', vi.fn((init: unknown) => init));
  vi.stubGlobal('RTCIceCandidate', vi.fn((init: unknown) => init));
}

describe('送信バックプレッシャ (TransferManager -> WebRTCConnection)', () => {
  let manager: TransferManager;
  let statuses: TransferStatus[];
  let errors: { message?: string }[];

  beforeEach(() => {
    mocks.signalingHandlers.clear();
    vi.clearAllMocks();
    mocks.signalingClient.connect.mockResolvedValue(undefined);

    channel = new FakeDataChannel();
    stubPeerConnection();

    manager = new TransferManager({ enableCompression: false, chunkSize: CHUNK_SIZE });
    statuses = [];
    errors = [];
    manager.on('status_change', event => statuses.push(event.data.status));
    manager.on('error', event => errors.push(event.data as { message?: string }));
  });

  afterEach(() => {
    manager.cleanup();
    vi.unstubAllGlobals();
  });

  it('ドレインの遅い回線でも複数チャンクのファイルを送り切り、バッファは高水位+1チャンクを超えない', async () => {
    const file = new File([new Uint8Array(FILE_SIZE)], 'big.bin', {
      type: 'application/octet-stream',
    });

    await connectAsSender(manager, [file]);
    channel.receive(capabilitiesMessage());

    let acked = false;
    for (let i = 0; i < 2000 && manager.currentStatus === 'transferring'; i++) {
      // 遅い回線の再現: 送信側が詰まっている間だけ、1 tick あたり一定量を捌く
      if (channel.listenerCount('bufferedamountlow') > 0) {
        channel.drain(DRAIN_PER_TICK);
      }

      if (!acked && sentChunks().length === TOTAL_CHUNKS) {
        acked = true;
        channel.receive(ackMessage(0, 'big.bin', FILE_SIZE));
      }

      await tick();
    }

    expect(errors).toEqual([]);
    expect(manager.currentStatus).toBe('completed');
    expect(sentChunks()).toHaveLength(TOTAL_CHUNKS);
    expect(sentJson().map(m => m.type)).toContain('transfer_complete');

    // 一度は高水位に達している = バックプレッシャが実際に効いた
    expect(channel.maxBufferedAmount).toBeGreaterThanOrEqual(BUFFERED_AMOUNT_HIGH_WATERMARK);

    // それでも「高水位 + 1 チャンク」を超えて積まれることはない
    const largestPayload = Math.max(...sentChunks().map(chunk => chunk.byteLength));
    expect(channel.maxBufferedAmount).toBeLessThanOrEqual(
      BUFFERED_AMOUNT_HIGH_WATERMARK + largestPayload
    );

    // 待機リスナーは残らない
    expect(channel.listenerCount('bufferedamountlow')).toBe(0);
  });

  it('バッファ空き待ちの最中に cancel すると即座に停止する', async () => {
    const file = new File([new Uint8Array(FILE_SIZE)], 'big.bin');

    await connectAsSender(manager, [file]);
    channel.receive(capabilitiesMessage());

    // ドレインしないので、すぐ高水位で詰まる
    await waitUntilBlocked();
    expect(channel.bufferedAmount).toBeGreaterThanOrEqual(BUFFERED_AMOUNT_HIGH_WATERMARK);

    const sentBeforeCancel = channel.sent.length;
    manager.cancel();

    expect(manager.currentStatus).toBe('cancelled');
    expect(channel.listenerCount('bufferedamountlow')).toBe(0);

    // 解放後も送信ループが再開しないこと（unhandled rejection も出ない）
    channel.drain();
    for (let i = 0; i < 10; i++) await tick();

    expect(channel.sent.length).toBe(sentBeforeCancel);
    expect(manager.currentStatus).toBe('cancelled');
    expect(statuses).not.toContain('error');
  });

  it('バッファ空き待ちの最中に切断されると転送がエラーになる', async () => {
    const file = new File([new Uint8Array(FILE_SIZE)], 'big.bin');

    await connectAsSender(manager, [file]);
    channel.receive(capabilitiesMessage());

    await waitUntilBlocked();
    const sentBeforeClose = channel.sent.length;

    // データチャネルが閉じる = 待機は解放され、転送はエラーになる
    channel.close();
    for (let i = 0; i < 10; i++) await tick();

    expect(manager.currentStatus).toBe('error');
    expect(errors).toContainEqual({ message: 'Connection lost' });
    expect(channel.sent.length).toBe(sentBeforeClose);
    expect(channel.listenerCount('bufferedamountlow')).toBe(0);
    expect(sentJson().map(m => m.type)).not.toContain('transfer_complete');
  });

  it('destroy 相当の cleanup でもバッファ空き待ちが解放される', async () => {
    const file = new File([new Uint8Array(FILE_SIZE)], 'big.bin');

    await connectAsSender(manager, [file]);
    channel.receive(capabilitiesMessage());

    await waitUntilBlocked();

    manager.cleanup();
    for (let i = 0; i < 10; i++) await tick();

    expect(channel.listenerCount('bufferedamountlow')).toBe(0);
  });
});

describe('metadata 送信後の固定待ち', () => {
  let manager: TransferManager;

  beforeEach(() => {
    mocks.signalingHandlers.clear();
    vi.clearAllMocks();
    mocks.signalingClient.connect.mockResolvedValue(undefined);
    vi.useFakeTimers();

    channel = new FakeDataChannel();
    stubPeerConnection();
    manager = new TransferManager({ enableCompression: false, chunkSize: CHUNK_SIZE });
  });

  afterEach(() => {
    manager.cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('metadata の直後にチャンクを送り始める（100ms 待たない）', async () => {
    const file = new File([new Uint8Array(1024)], 'small.bin');

    await connectAsSender(manager, [file]);
    channel.receive(capabilitiesMessage());

    // 100ms 未満しか進めなくてもチャンクが送られている
    await vi.advanceTimersByTimeAsync(10);

    expect(sentJson().map(m => m.type)).toContain('file_metadata');
    expect(sentChunks()).toHaveLength(1);
  });
});
