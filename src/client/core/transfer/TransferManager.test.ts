import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TransferManager, type TransferStatus } from './TransferManager';
import type { Chunk, ChunkMetadata } from './ChunkManager';

// SignalingClientのモック
const mockSignalingClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  generateCode: vi.fn(),
  joinRoom: vi.fn(),
  sendOffer: vi.fn(),
  sendAnswer: vi.fn(),
  sendIceCandidate: vi.fn(),
  on: vi.fn().mockReturnValue(() => {}),
  isConnected: true,
};

// WebRTCConnectionのモック
const mockWebRTCConnection = {
  create: vi.fn(),
  signal: vi.fn(),
  send: vi.fn(),
  sendJSON: vi.fn(),
  sendWithBackpressure: vi.fn().mockResolvedValue(undefined),
  waitForBufferedAmountLow: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn(),
  on: vi.fn().mockReturnValue(() => {}),
  isConnected: false,
};

// ChunkManagerのモック。
// 実物（ChunkManager.ts）の公開 API と形・戻り値をそろえる:
//   setMetadata -> void（不正なメタデータでは throw）
//   addChunk    -> boolean（不正なチャンクでは throw）
//   merge       -> Blob / toFile -> File（メタデータ未設定では throw）
// 入力検証そのものの網羅は、実物を使う ChunkManager.test.ts と
// TransferManager.receive.test.ts が担当する。ここでは「前提条件を満たさない
// 呼び出しは例外になる」ことだけ同じにして、成功時の戻り値を実物にそろえる。
const mockChunkManagerState: { metadata: ChunkMetadata | null } = { metadata: null };

const mockChunkManager = {
  // 実物では getter。値として同じ名前を生やしておく。
  currentChunkSize: 16384,
  receivedCount: 0,
  totalChunks: 1,
  progress: 0,

  createMetadata: vi.fn().mockReturnValue({
    fileName: 'test.txt',
    fileType: 'text/plain',
    totalSize: 100,
    totalChunks: 1,
    chunkSize: 16384,
  }),
  split: vi.fn().mockImplementation(async function* (): AsyncGenerator<Chunk> {
    yield {
      index: 0,
      data: new Uint8Array([1, 2, 3]),
      size: 3,
      hash: 'abc123',
    };
  }),
  setMetadata: vi.fn((metadata: ChunkMetadata): void => {
    if (!metadata || typeof metadata !== 'object') {
      throw new Error('Invalid metadata: not an object');
    }
    mockChunkManagerState.metadata = metadata;
  }),
  getMetadata: vi.fn((): ChunkMetadata | null => mockChunkManagerState.metadata),
  addChunk: vi.fn((): boolean => {
    if (!mockChunkManagerState.metadata) {
      throw new Error('Cannot add chunk: no metadata set');
    }
    return true;
  }),
  isComplete: vi.fn().mockReturnValue(false),
  getMissingChunks: vi.fn().mockReturnValue([]),
  merge: vi.fn((): Blob => {
    if (!mockChunkManagerState.metadata) {
      throw new Error('No metadata set');
    }
    return new Blob(['test']);
  }),
  toFile: vi.fn((): File => {
    if (!mockChunkManagerState.metadata) {
      throw new Error('No metadata set');
    }
    return new File(['test'], mockChunkManagerState.metadata.fileName);
  }),
  reset: vi.fn((): void => {
    mockChunkManagerState.metadata = null;
  }),
};

// モジュールモック
vi.mock('../connection/SignalingClient', () => ({
  SignalingClient: vi.fn().mockImplementation(() => mockSignalingClient),
}));

vi.mock('../connection/WebRTCConnection', () => ({
  WebRTCConnection: vi.fn().mockImplementation(() => mockWebRTCConnection),
}));

// インスタンスだけ差し替え、静的メソッドと定数（MAX_TRANSFER_BYTES など）は
// 実物のまま残す。TransferManager はどちらも使うので、モジュール全体を
// 置き換えると実物と形が変わってしまう。
vi.mock('./ChunkManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ChunkManager')>();
  const MockedChunkManager = vi.fn().mockImplementation(() => mockChunkManager);
  Object.assign(MockedChunkManager, {
    serializeChunk: actual.ChunkManager.serializeChunk,
    deserializeChunk: actual.ChunkManager.deserializeChunk,
  });

  return { ...actual, ChunkManager: MockedChunkManager };
});

vi.mock('./CompressionService', () => ({
  CompressionService: vi.fn().mockImplementation(() => ({
    shouldCompress: vi.fn().mockReturnValue(false),
    compress: vi.fn().mockImplementation((data) => Promise.resolve(data)),
    decompress: vi.fn().mockImplementation((data) => Promise.resolve(data)),
  })),
}));

describe('TransferManager', () => {
  let manager: TransferManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    manager = new TransferManager();
  });

  afterEach(() => {
    manager.cleanup();
    vi.useRealTimers();
  });

  describe('初期状態', () => {
    it('ステータスはidleである', () => {
      expect(manager.currentStatus).toBe('idle');
    });

    it('進捗は0%である', () => {
      expect(manager.currentProgress.progress).toBe(0);
    });

    it('転送バイト数は0である', () => {
      expect(manager.currentProgress.bytesTransferred).toBe(0);
    });
  });

  describe('initializeAsReceiver', () => {
    it('6桁のコードを生成して返す', async () => {
      const code = await manager.initializeAsReceiver();

      expect(code).toMatch(/^\d{6}$/);
    });

    it('ステータスがwaitingに変わる', async () => {
      await manager.initializeAsReceiver();

      expect(manager.currentStatus).toBe('waiting');
    });

    it('SignalingClientのconnectが呼ばれる', async () => {
      await manager.initializeAsReceiver();

      expect(mockSignalingClient.connect).toHaveBeenCalled();
    });

    it('SignalingClientのgenerateCodeが呼ばれる', async () => {
      await manager.initializeAsReceiver();

      expect(mockSignalingClient.generateCode).toHaveBeenCalled();
    });

    it('status_changeイベントが発火する', async () => {
      const handler = vi.fn();
      manager.on('status_change', handler);

      await manager.initializeAsReceiver();

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status_change',
          data: expect.objectContaining({ status: 'waiting' }),
        })
      );
    });
  });

  describe('initializeAsSender', () => {
    const testFiles = [new File(['test content'], 'test.txt', { type: 'text/plain' })];

    it('ステータスがconnectingに変わる', async () => {
      const statusHandler = vi.fn();
      manager.on('status_change', statusHandler);

      // 非同期処理を開始（完了を待たない）
      manager.initializeAsSender('1234', testFiles);

      // 最初のステータス変更を確認
      expect(statusHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status_change',
          data: { status: 'connecting' },
        })
      );
    });

    it('SignalingClientのconnectが正しいコードで呼ばれる', async () => {
      await manager.initializeAsSender('5678', testFiles);

      expect(mockSignalingClient.connect).toHaveBeenCalledWith('5678');
    });

    it('SignalingClientのjoinRoomがsenderロールで呼ばれる', async () => {
      await manager.initializeAsSender('5678', testFiles);

      expect(mockSignalingClient.joinRoom).toHaveBeenCalledWith('5678', 'sender');
    });

    it('合計バイト数が設定される', async () => {
      const files = [
        new File(['12345'], 'test1.txt'),
        new File(['67890'], 'test2.txt'),
      ];

      await manager.initializeAsSender('1234', files);

      expect(manager.currentProgress.totalBytes).toBe(10);
    });
  });

  describe('cancel', () => {
    it('ステータスがcancelledに変わる', async () => {
      await manager.initializeAsReceiver();

      manager.cancel();

      expect(manager.currentStatus).toBe('cancelled');
    });

    it('cleanup処理が実行される', async () => {
      await manager.initializeAsReceiver();

      manager.cancel();

      expect(mockSignalingClient.disconnect).toHaveBeenCalled();
      expect(mockWebRTCConnection.destroy).toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('SignalingClientを切断する', async () => {
      await manager.initializeAsReceiver();

      manager.cleanup();

      expect(mockSignalingClient.disconnect).toHaveBeenCalled();
    });

    it('WebRTCConnectionを破棄する', async () => {
      await manager.initializeAsReceiver();

      manager.cleanup();

      expect(mockWebRTCConnection.destroy).toHaveBeenCalled();
    });

    it('ChunkManagerをリセットする', async () => {
      await manager.initializeAsReceiver();

      manager.cleanup();

      expect(mockChunkManager.reset).toHaveBeenCalled();
    });
  });

  describe('on', () => {
    it('イベントハンドラを登録できる', async () => {
      const handler = vi.fn();
      manager.on('status_change', handler);

      await manager.initializeAsReceiver();

      expect(handler).toHaveBeenCalled();
    });

    it('返却されるunsubscribe関数でハンドラを解除できる', async () => {
      const handler = vi.fn();
      const unsubscribe = manager.on('status_change', handler);

      unsubscribe();
      await manager.initializeAsReceiver();

      // connecting -> waiting で2回呼ばれるはずだが、解除されているので0回
      expect(handler).not.toHaveBeenCalled();
    });

    it('複数のイベントタイプにハンドラを登録できる', async () => {
      const statusHandler = vi.fn();
      const progressHandler = vi.fn();

      manager.on('status_change', statusHandler);
      manager.on('progress', progressHandler);

      await manager.initializeAsReceiver();

      expect(statusHandler).toHaveBeenCalled();
    });
  });

  describe('currentProgress', () => {
    it('進捗率を計算する', () => {
      // 内部状態を直接設定
      (manager as any).totalBytes = 100;
      (manager as any).bytesTransferred = 50;

      expect(manager.currentProgress.progress).toBe(50);
    });

    it('totalBytesが0の場合は進捗率0を返す', () => {
      (manager as any).totalBytes = 0;
      (manager as any).bytesTransferred = 0;

      expect(manager.currentProgress.progress).toBe(0);
    });

    it('転送速度を計算する', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      (manager as any).lastProgressTime = now - 1000; // 1秒前
      (manager as any).lastBytesTransferred = 0;
      (manager as any).bytesTransferred = 1000;

      const progress = manager.currentProgress;

      expect(progress.speed).toBe(1000); // 1000 bytes/sec
    });

    it('ETAを計算する', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      (manager as any).totalBytes = 2000;
      (manager as any).bytesTransferred = 1000;
      (manager as any).lastProgressTime = now - 1000;
      (manager as any).lastBytesTransferred = 0;

      const progress = manager.currentProgress;

      expect(progress.eta).toBe(1); // 1秒後に完了
    });
  });

  describe('getReceivedFile', () => {
    it('転送未完了時はnullを返す', () => {
      mockChunkManager.isComplete.mockReturnValue(false);

      expect(manager.getReceivedFile()).toBeNull();
    });

    it('転送完了時はファイルを返す', () => {
      mockChunkManager.isComplete.mockReturnValue(true);
      const mockFile = new File(['test'], 'test.txt');
      mockChunkManager.toFile.mockReturnValue(mockFile);

      expect(manager.getReceivedFile()).toBe(mockFile);
    });
  });

  describe('TransferOptions', () => {
    it('デフォルトで圧縮が有効', () => {
      const mgr = new TransferManager();
      expect((mgr as any).options.enableCompression).toBe(true);
    });

    it('デフォルトチャンクサイズは16KB', () => {
      const mgr = new TransferManager();
      expect((mgr as any).options.chunkSize).toBe(16 * 1024);
    });

    it('オプションをカスタマイズできる', () => {
      const mgr = new TransferManager({
        enableCompression: false,
        chunkSize: 32 * 1024,
      });

      expect((mgr as any).options.enableCompression).toBe(false);
      expect((mgr as any).options.chunkSize).toBe(32 * 1024);
    });
  });

  describe('ステータス遷移', () => {
    it('receiver: idle -> connecting -> waiting', async () => {
      const statuses: TransferStatus[] = [];
      manager.on('status_change', (event) => {
        statuses.push(event.data.status);
      });

      await manager.initializeAsReceiver();

      expect(statuses).toContain('connecting');
      expect(statuses).toContain('waiting');
    });

    it('cancel時: 任意のステータス -> cancelled', async () => {
      await manager.initializeAsReceiver();

      manager.cancel();

      expect(manager.currentStatus).toBe('cancelled');
    });
  });
});
