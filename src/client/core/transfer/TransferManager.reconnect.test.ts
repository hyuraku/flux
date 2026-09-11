import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TransferManager } from './TransferManager';

// SignalingClient / WebRTCConnection のハンドラを捕捉して、
// シグナリング断や WebRTC 接続をテストから起こせるようにする
const mocks = vi.hoisted(() => {
  type EventHandler = (event: { type: string; data?: unknown }) => void;

  const signalingHandlers = new Map<string, EventHandler>();
  const webrtcHandlers = new Map<string, EventHandler>();

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
    sendWithBackpressure: vi.fn().mockResolvedValue(undefined),
    waitForBufferedAmountLow: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    on: vi.fn((event: string, handler: EventHandler) => {
      webrtcHandlers.set(event, handler);
      return () => webrtcHandlers.delete(event);
    }),
    isConnected: false,
  };

  return { signalingHandlers, webrtcHandlers, signalingClient, webrtcConnection };
});

vi.mock('../connection/SignalingClient', () => ({
  SignalingClient: vi.fn(() => mocks.signalingClient),
}));

vi.mock('../connection/WebRTCConnection', () => ({
  WebRTCConnection: vi.fn(() => mocks.webrtcConnection),
}));

vi.mock('./CompressionService', () => {
  const CompressionServiceMock = vi.fn(() => ({
    shouldCompress: () => false,
    compress: (data: Uint8Array) => Promise.resolve(data),
    decompress: (data: Uint8Array) => Promise.resolve(data),
  }));
  (CompressionServiceMock as unknown as { isSupported: () => boolean }).isSupported = () => true;
  return { CompressionService: CompressionServiceMock };
});

function fireSignaling(event: string, data?: unknown): void {
  const handler = mocks.signalingHandlers.get(event);
  if (!handler) throw new Error(`${event} ハンドラが登録されていません`);
  handler({ type: event, data });
}

function fireWebRTC(event: string, data?: unknown): void {
  const handler = mocks.webrtcHandlers.get(event);
  if (!handler) throw new Error(`${event} ハンドラが登録されていません`);
  handler({ type: event, data });
}

describe('TransferManager の初期化失敗とシグナリング断', () => {
  let manager: TransferManager;
  let errorEvents: { message?: string }[];
  let statusChanges: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.signalingHandlers.clear();
    mocks.webrtcHandlers.clear();
    mocks.signalingClient.connect.mockResolvedValue(undefined);

    manager = new TransferManager();
    errorEvents = [];
    statusChanges = [];
    manager.on('error', (event) => errorEvents.push(event.data as { message?: string }));
    manager.on('status_change', (event) =>
      statusChanges.push((event.data as { status: string }).status)
    );
  });

  afterEach(() => {
    manager.cleanup();
  });

  describe('初期化失敗', () => {
    it('受信側: connect が失敗したら error を発火して再スローする', async () => {
      mocks.signalingClient.connect.mockRejectedValueOnce(
        new Error('Could not connect to the signaling server')
      );

      await expect(manager.initializeAsReceiver()).rejects.toThrow(
        'Could not connect to the signaling server'
      );

      expect(manager.currentStatus).toBe('error');
      expect(errorEvents).toEqual([{ message: 'Could not connect to the signaling server' }]);
      expect(statusChanges).toEqual(['connecting', 'error']);
    });

    it('送信側: connect が失敗したら error を発火して再スローする', async () => {
      mocks.signalingClient.connect.mockRejectedValueOnce(new Error('offline'));
      const files = [new File(['abc'], 'a.txt')];

      await expect(manager.initializeAsSender('123456', files)).rejects.toThrow('offline');

      expect(manager.currentStatus).toBe('error');
      expect(errorEvents).toEqual([{ message: 'offline' }]);
    });

    it('初期化失敗時に中途半端な接続を後始末する', async () => {
      mocks.signalingClient.connect.mockRejectedValueOnce(new Error('offline'));

      await expect(manager.initializeAsReceiver()).rejects.toThrow();

      expect(mocks.signalingClient.disconnect).toHaveBeenCalled();
      expect(mocks.webrtcConnection.destroy).toHaveBeenCalled();
    });
  });

  describe('データチャネルが開く前のシグナリング断', () => {
    beforeEach(async () => {
      await manager.initializeAsReceiver();
    });

    it('disconnected は転送失敗として表に出す', () => {
      fireSignaling('disconnected');

      expect(manager.currentStatus).toBe('error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].message).toContain('signaling server');
    });

    it('サーバからの PEER_DISCONNECTED も転送失敗として扱う', () => {
      fireSignaling('error', {
        type: 'error',
        code: 'PEER_DISCONNECTED',
        message: 'sender has disconnected',
      });

      expect(manager.currentStatus).toBe('error');
      expect(errorEvents).toEqual([{ message: 'sender has disconnected' }]);
    });

    it('error は 1 度だけ発火する', () => {
      fireSignaling('disconnected');
      fireSignaling('disconnected');
      fireSignaling('error', { message: 'boom' });

      expect(errorEvents).toHaveLength(1);
    });
  });

  describe('データチャネルが開いた後のシグナリング断', () => {
    beforeEach(async () => {
      await manager.initializeAsReceiver();
      fireSignaling('peer_joined', { role: 'sender', peerId: 'peer-1' });
      fireWebRTC('connected');
      expect(manager.currentStatus).toBe('transferring');
    });

    it('disconnected は転送を止めない', () => {
      fireSignaling('disconnected');

      expect(manager.currentStatus).toBe('transferring');
      expect(errorEvents).toHaveLength(0);
    });

    it('PEER_DISCONNECTED は無視する（相手のシグナリングが落ちただけ）', () => {
      fireSignaling('error', {
        type: 'error',
        code: 'PEER_DISCONNECTED',
        message: 'sender has disconnected',
      });

      expect(manager.currentStatus).toBe('transferring');
      expect(errorEvents).toHaveLength(0);
    });

    it('reconnected では再登録もリセットもしない', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      fireSignaling('reconnected');

      expect(mocks.signalingClient.generateCode).toHaveBeenCalledTimes(1);
      expect(mocks.signalingClient.joinRoom).not.toHaveBeenCalled();
      expect(manager.currentStatus).toBe('transferring');
      warn.mockRestore();
    });

    it('転送の成否は WebRTC 側の切断で決まる', () => {
      fireWebRTC('disconnected');

      expect(manager.currentStatus).toBe('error');
      expect(errorEvents).toEqual([{ message: 'Connection lost' }]);
    });
  });

  describe('connected の重複', () => {
    it('受信側: 能力通知は 1 度だけ送る', async () => {
      await manager.initializeAsReceiver();
      fireSignaling('peer_joined', { role: 'sender', peerId: 'peer-1' });

      fireWebRTC('connected');
      fireWebRTC('connected');
      fireWebRTC('connected');

      const capabilityMessages = mocks.webrtcConnection.sendJSON.mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === 'receiver_capabilities'
      );
      expect(capabilityMessages).toHaveLength(1);
    });

    it('送信側: startSending は 1 度しか走らない', async () => {
      await manager.initializeAsSender('123456', [new File(['abc'], 'a.txt')]);
      fireSignaling('webrtc_offer', {
        fromPeerId: 'peer-1',
        sdp: JSON.stringify({ type: 'offer' }),
      });

      fireWebRTC('connected');
      fireWebRTC('connected');

      const transferringChanges = statusChanges.filter(status => status === 'transferring');
      expect(transferringChanges).toHaveLength(1);
    });
  });
});
