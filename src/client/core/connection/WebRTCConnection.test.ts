import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebRTCConnection } from './WebRTCConnection';

// RTCPeerConnection モック
const mockPeerConnection = {
  createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'mock-offer-sdp' }),
  createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'mock-answer-sdp' }),
  setLocalDescription: vi.fn().mockResolvedValue(undefined),
  setRemoteDescription: vi.fn().mockResolvedValue(undefined),
  addIceCandidate: vi.fn().mockResolvedValue(undefined),
  createDataChannel: vi.fn(),
  close: vi.fn(),
  getStats: vi.fn().mockResolvedValue(new Map()),
  localDescription: null as RTCSessionDescription | null,
  remoteDescription: null as RTCSessionDescription | null,
  connectionState: 'new' as RTCPeerConnectionState,
  iceConnectionState: 'new' as RTCIceConnectionState,
  onicecandidate: null as ((event: RTCPeerConnectionIceEvent) => void) | null,
  onconnectionstatechange: null as (() => void) | null,
  oniceconnectionstatechange: null as (() => void) | null,
  ondatachannel: null as ((event: RTCDataChannelEvent) => void) | null,
};

// RTCDataChannel モック
const mockDataChannel = {
  label: 'flux-transfer',
  readyState: 'connecting' as RTCDataChannelState,
  binaryType: 'arraybuffer' as BinaryType,
  send: vi.fn(),
  close: vi.fn(),
  onopen: null as (() => void) | null,
  onclose: null as (() => void) | null,
  onerror: null as ((event: Event) => void) | null,
  onmessage: null as ((event: MessageEvent) => void) | null,
};

// グローバルモック設定
vi.stubGlobal('RTCPeerConnection', vi.fn().mockImplementation(() => {
  mockPeerConnection.createDataChannel.mockReturnValue(mockDataChannel);
  return mockPeerConnection;
}));

vi.stubGlobal('RTCSessionDescription', vi.fn().mockImplementation((init) => init));
vi.stubGlobal('RTCIceCandidate', vi.fn().mockImplementation((init) => init));

describe('WebRTCConnection', () => {
  let connection: WebRTCConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock states
    mockPeerConnection.localDescription = null;
    mockPeerConnection.remoteDescription = null;
    mockPeerConnection.connectionState = 'new';
    mockPeerConnection.iceConnectionState = 'new';
    mockPeerConnection.onicecandidate = null;
    mockPeerConnection.onconnectionstatechange = null;
    mockPeerConnection.oniceconnectionstatechange = null;
    mockPeerConnection.ondatachannel = null;
    mockDataChannel.readyState = 'connecting';
    mockDataChannel.onopen = null;
    mockDataChannel.onclose = null;
    mockDataChannel.onerror = null;
    mockDataChannel.onmessage = null;
    connection = new WebRTCConnection();
  });

  describe('初期状態', () => {
    it('作成直後はisConnectedがfalseである', () => {
      expect(connection.isConnected).toBe(false);
    });
  });

  describe('create', () => {
    it('initiatorモードでピアを作成できる', () => {
      connection.create({ initiator: true });

      expect(RTCPeerConnection).toHaveBeenCalled();
      expect(mockPeerConnection.createDataChannel).toHaveBeenCalledWith('flux-transfer', { ordered: true });
    });

    it('non-initiatorモードでピアを作成できる', () => {
      connection.create({ initiator: false });

      expect(RTCPeerConnection).toHaveBeenCalled();
      expect(mockPeerConnection.createDataChannel).not.toHaveBeenCalled();
    });

    it('カスタムICEサーバーを設定できる', () => {
      const customIceServers = [{ urls: 'stun:custom.stun.server:3478' }];

      connection.create({
        initiator: true,
        config: { iceServers: customIceServers },
      });

      expect(RTCPeerConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          iceServers: customIceServers,
        })
      );
    });

    it('initiatorはオファーを作成する', async () => {
      connection.create({ initiator: true });

      // 非同期処理を待つ
      await vi.waitFor(() => {
        expect(mockPeerConnection.createOffer).toHaveBeenCalled();
      });
    });

    it('ICE候補イベントハンドラが設定される', () => {
      connection.create({ initiator: true });

      expect(mockPeerConnection.onicecandidate).not.toBeNull();
    });

    it('接続状態変更イベントハンドラが設定される', () => {
      connection.create({ initiator: true });

      expect(mockPeerConnection.onconnectionstatechange).not.toBeNull();
    });
  });

  describe('signal', () => {
    it('オファーを受信してアンサーを作成する', async () => {
      connection.create({ initiator: false });

      await connection.signal({ type: 'offer', sdp: 'remote-offer-sdp' });

      expect(mockPeerConnection.setRemoteDescription).toHaveBeenCalled();
      expect(mockPeerConnection.createAnswer).toHaveBeenCalled();
    });

    it('アンサーを受信してリモート記述を設定する', async () => {
      connection.create({ initiator: true });

      await connection.signal({ type: 'answer', sdp: 'remote-answer-sdp' });

      expect(mockPeerConnection.setRemoteDescription).toHaveBeenCalled();
    });

    it('ICE候補を受信して追加する', async () => {
      connection.create({ initiator: true });
      // リモート記述を設定
      mockPeerConnection.remoteDescription = { type: 'answer', sdp: 'sdp' } as RTCSessionDescription;

      await connection.signal({
        type: 'candidate',
        candidate: { candidate: 'mock-candidate', sdpMid: '0', sdpMLineIndex: 0 },
      });

      expect(mockPeerConnection.addIceCandidate).toHaveBeenCalled();
    });

    it('リモート記述なしでICE候補を受信した場合はキューに追加する', async () => {
      connection.create({ initiator: true });
      mockPeerConnection.remoteDescription = null;

      await connection.signal({
        type: 'candidate',
        candidate: { candidate: 'mock-candidate', sdpMid: '0', sdpMLineIndex: 0 },
      });

      // キューに追加されるが、まだaddIceCandidateは呼ばれない
      expect(mockPeerConnection.addIceCandidate).not.toHaveBeenCalled();
    });

    it('ピア未作成時はエラーをスローする', async () => {
      await expect(connection.signal({ type: 'offer', sdp: 'test' })).rejects.toThrow(
        'Peer not created'
      );
    });
  });

  describe('send', () => {
    beforeEach(() => {
      connection.create({ initiator: true });
      mockDataChannel.readyState = 'open';
    });

    it('文字列を送信できる', () => {
      connection.send('hello');

      expect(mockDataChannel.send).toHaveBeenCalledWith('hello');
    });

    it('ArrayBufferを送信できる', () => {
      const buffer = new ArrayBuffer(4);

      connection.send(buffer);

      expect(mockDataChannel.send).toHaveBeenCalled();
    });

    it('Uint8Arrayを送信できる', () => {
      const data = new Uint8Array([1, 2, 3, 4]);

      connection.send(data);

      expect(mockDataChannel.send).toHaveBeenCalled();
    });

    it('未接続時はエラーをスローする', () => {
      mockDataChannel.readyState = 'connecting';

      expect(() => connection.send('test')).toThrow('Peer not connected');
    });

    it('16MBを超えるデータはエラーになる', () => {
      const largeData = new Uint8Array(17 * 1024 * 1024); // 17MB

      expect(() => connection.send(largeData)).toThrow('Data too large');
    });
  });

  describe('sendJSON', () => {
    beforeEach(() => {
      connection.create({ initiator: true });
      mockDataChannel.readyState = 'open';
    });

    it('オブジェクトをJSON文字列に変換して送信する', () => {
      connection.sendJSON({ type: 'test', value: 123 });

      expect(mockDataChannel.send).toHaveBeenCalledWith('{"type":"test","value":123}');
    });
  });

  describe('イベント発火', () => {
    it('データチャネルopen時にconnectedイベントを発火する', () => {
      const handler = vi.fn();
      connection.on('connected', handler);
      connection.create({ initiator: true });

      // DataChannel open をシミュレート
      mockDataChannel.onopen?.();

      expect(handler).toHaveBeenCalledWith({ type: 'connected' });
      expect(connection.isConnected).toBe(true);
    });

    it('データチャネルclose時にdisconnectedイベントを発火する', () => {
      const handler = vi.fn();
      connection.on('disconnected', handler);
      connection.create({ initiator: true });

      mockDataChannel.onclose?.();

      expect(handler).toHaveBeenCalledWith({ type: 'disconnected' });
      expect(connection.isConnected).toBe(false);
    });

    it('データ受信時にdataイベントを発火する', () => {
      const handler = vi.fn();
      connection.on('data', handler);
      connection.create({ initiator: true });

      const receivedData = new ArrayBuffer(3);
      mockDataChannel.onmessage?.({ data: receivedData } as MessageEvent);

      expect(handler).toHaveBeenCalledWith({
        type: 'data',
        data: expect.any(Uint8Array),
      });
    });

    it('ICE候補発見時にsignalイベントを発火する', () => {
      const handler = vi.fn();
      connection.on('signal', handler);
      connection.create({ initiator: true });

      const mockCandidate = {
        candidate: 'mock-candidate',
        toJSON: () => ({ candidate: 'mock-candidate' }),
      };
      mockPeerConnection.onicecandidate?.({ candidate: mockCandidate } as RTCPeerConnectionIceEvent);

      expect(handler).toHaveBeenCalledWith({
        type: 'signal',
        data: {
          type: 'candidate',
          candidate: { candidate: 'mock-candidate' },
        },
      });
    });

    it('接続状態がfailedになったらerrorイベントを発火する', () => {
      const handler = vi.fn();
      connection.on('error', handler);
      connection.create({ initiator: true });

      mockPeerConnection.connectionState = 'failed';
      mockPeerConnection.onconnectionstatechange?.();

      expect(handler).toHaveBeenCalledWith({
        type: 'error',
        data: expect.any(Error),
      });
    });
  });

  describe('on', () => {
    it('イベントハンドラを登録できる', () => {
      const handler = vi.fn();

      connection.on('connected', handler);
      connection.create({ initiator: true });
      mockDataChannel.onopen?.();

      expect(handler).toHaveBeenCalled();
    });

    it('複数のハンドラを同じイベントに登録できる', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      connection.on('connected', handler1);
      connection.on('connected', handler2);
      connection.create({ initiator: true });
      mockDataChannel.onopen?.();

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('返却されるunsubscribe関数でハンドラを解除できる', () => {
      const handler = vi.fn();

      const unsubscribe = connection.on('connected', handler);
      unsubscribe();

      connection.create({ initiator: true });
      mockDataChannel.onopen?.();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('destroy', () => {
    it('データチャネルを閉じる', () => {
      connection.create({ initiator: true });

      connection.destroy();

      expect(mockDataChannel.close).toHaveBeenCalled();
    });

    it('PeerConnectionを閉じる', () => {
      connection.create({ initiator: true });

      connection.destroy();

      expect(mockPeerConnection.close).toHaveBeenCalled();
    });

    it('破棄後はisConnectedがfalseになる', () => {
      connection.create({ initiator: true });
      mockDataChannel.onopen?.();
      expect(connection.isConnected).toBe(true);

      connection.destroy();

      expect(connection.isConnected).toBe(false);
    });

    it('破棄後はイベントハンドラがクリアされる', () => {
      const handler = vi.fn();
      connection.on('connected', handler);
      connection.create({ initiator: true });

      connection.destroy();

      // 新しい接続を作成しても古いハンドラは呼ばれない
      connection.create({ initiator: true });
      mockDataChannel.onopen?.();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('ピア未作成時はnullを返す', async () => {
      const stats = await connection.getStats();

      expect(stats).toBeNull();
    });

    it('ピア作成後は統計情報を取得できる', async () => {
      connection.create({ initiator: true });

      await connection.getStats();

      expect(mockPeerConnection.getStats).toHaveBeenCalled();
    });
  });

  describe('non-initiator (receiver)', () => {
    it('ondatachannelイベントでデータチャネルを受け取る', () => {
      const handler = vi.fn();
      connection.on('connected', handler);
      connection.create({ initiator: false });

      // Receiver側でdatachannelイベントを受け取る
      mockPeerConnection.ondatachannel?.({ channel: mockDataChannel } as unknown as RTCDataChannelEvent);
      mockDataChannel.onopen?.();

      expect(handler).toHaveBeenCalledWith({ type: 'connected' });
    });
  });
});
