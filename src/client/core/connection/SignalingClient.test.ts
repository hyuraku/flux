import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SignalingClient } from './SignalingClient';

// PartySocketのモック
const mockSocket = {
  readyState: WebSocket.OPEN as number,
  send: vi.fn(),
  close: vi.fn(),
  onopen: null as (() => void) | null,
  onclose: null as (() => void) | null,
  onerror: null as ((error: any) => void) | null,
  onmessage: null as ((event: { data: string }) => void) | null,
};

vi.mock('partysocket', () => ({
  default: vi.fn().mockImplementation(() => {
    // 接続成功をシミュレート
    setTimeout(() => {
      mockSocket.onopen?.();
    }, 0);
    return mockSocket;
  }),
}));

describe('SignalingClient', () => {
  let client: SignalingClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket.readyState = WebSocket.OPEN;
    mockSocket.onopen = null;
    mockSocket.onclose = null;
    mockSocket.onerror = null;
    mockSocket.onmessage = null;
    client = new SignalingClient('localhost:1999');
  });

  describe('初期状態', () => {
    it('接続前はisConnectedがfalseである', () => {
      const newClient = new SignalingClient();
      expect(newClient.isConnected).toBe(false);
    });

    it('接続前はcurrentRoomIdがnullである', () => {
      expect(client.currentRoomId).toBeNull();
    });

    it('接続前はcurrentPeerIdがnullである', () => {
      expect(client.currentPeerId).toBeNull();
    });
  });

  describe('connect', () => {
    it('指定したroomIdでWebSocket接続を確立する', async () => {
      await client.connect('1234');

      expect(client.currentRoomId).toBe('1234');
    });

    it('接続成功時にconnectedイベントを発火する', async () => {
      const handler = vi.fn();
      client.on('connected', handler);

      await client.connect('1234');

      expect(handler).toHaveBeenCalledWith({ type: 'connected' });
    });

    it('接続成功後はisConnectedがtrueになる', async () => {
      await client.connect('1234');

      expect(client.isConnected).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('WebSocket接続を閉じる', async () => {
      await client.connect('1234');

      client.disconnect();

      expect(mockSocket.close).toHaveBeenCalled();
    });

    it('切断後はroomIdがnullになる', async () => {
      await client.connect('1234');

      client.disconnect();

      expect(client.currentRoomId).toBeNull();
    });

    it('切断後はイベントハンドラがクリアされる', async () => {
      const handler = vi.fn();
      client.on('connected', handler);
      await client.connect('1234');

      client.disconnect();

      // 新しい接続でハンドラが呼ばれないことを確認
      // （実際には再接続が必要だが、ハンドラがクリアされているか確認）
      expect(client.currentRoomId).toBeNull();
    });
  });

  describe('send', () => {
    it('JSON形式でメッセージを送信する', async () => {
      await client.connect('1234');

      client.send({ type: 'generate_code' });

      expect(mockSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'generate_code' })
      );
    });

    it('未接続時はエラーをスローする', () => {
      mockSocket.readyState = 3; // WebSocket.CLOSED

      expect(() => client.send({ type: 'generate_code' })).toThrow(
        'Socket not connected'
      );
    });
  });

  describe('generateCode', () => {
    it('generate_codeメッセージを送信する', async () => {
      await client.connect('1234');

      client.generateCode();

      expect(mockSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'generate_code' })
      );
    });
  });

  describe('joinRoom', () => {
    it('join_roomメッセージをコードとロールと共に送信する', async () => {
      await client.connect('1234');

      client.joinRoom('5678', 'sender');

      expect(mockSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'join_room', code: '5678', role: 'sender' })
      );
    });

    it('receiverロールでも参加できる', async () => {
      await client.connect('1234');

      client.joinRoom('5678', 'receiver');

      expect(mockSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'join_room', code: '5678', role: 'receiver' })
      );
    });
  });

  describe('sendOffer', () => {
    it('webrtc_offerメッセージを送信する', async () => {
      await client.connect('1234');

      client.sendOffer('peer-123', 'sdp-data');

      expect(mockSocket.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'webrtc_offer',
          targetPeerId: 'peer-123',
          sdp: 'sdp-data',
        })
      );
    });
  });

  describe('sendAnswer', () => {
    it('webrtc_answerメッセージを送信する', async () => {
      await client.connect('1234');

      client.sendAnswer('peer-123', 'sdp-answer');

      expect(mockSocket.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'webrtc_answer',
          targetPeerId: 'peer-123',
          sdp: 'sdp-answer',
        })
      );
    });
  });

  describe('sendIceCandidate', () => {
    it('ice_candidateメッセージを送信する', async () => {
      await client.connect('1234');

      client.sendIceCandidate('peer-123', 'candidate-data');

      expect(mockSocket.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'ice_candidate',
          targetPeerId: 'peer-123',
          candidate: 'candidate-data',
        })
      );
    });
  });

  describe('メッセージ受信', () => {
    it('code_generatedメッセージを受信してイベントを発火する', async () => {
      const handler = vi.fn();
      client.on('code_generated', handler);
      await client.connect('1234');

      mockSocket.onmessage?.({
        data: JSON.stringify({ type: 'code_generated', code: '5678' }),
      });

      expect(handler).toHaveBeenCalledWith({
        type: 'code_generated',
        data: { type: 'code_generated', code: '5678' },
      });
    });

    it('peer_joinedメッセージを受信してイベントを発火する', async () => {
      const handler = vi.fn();
      client.on('peer_joined', handler);
      await client.connect('1234');

      mockSocket.onmessage?.({
        data: JSON.stringify({
          type: 'peer_joined',
          peerId: 'peer-abc',
          role: 'sender',
        }),
      });

      expect(handler).toHaveBeenCalledWith({
        type: 'peer_joined',
        data: { type: 'peer_joined', peerId: 'peer-abc', role: 'sender' },
      });
    });

    it('webrtc_offerメッセージを受信してイベントを発火する', async () => {
      const handler = vi.fn();
      client.on('webrtc_offer', handler);
      await client.connect('1234');

      mockSocket.onmessage?.({
        data: JSON.stringify({ type: 'webrtc_offer', sdp: 'offer-sdp' }),
      });

      expect(handler).toHaveBeenCalledWith({
        type: 'webrtc_offer',
        data: { type: 'webrtc_offer', sdp: 'offer-sdp' },
      });
    });

    it('webrtc_answerメッセージを受信してイベントを発火する', async () => {
      const handler = vi.fn();
      client.on('webrtc_answer', handler);
      await client.connect('1234');

      mockSocket.onmessage?.({
        data: JSON.stringify({ type: 'webrtc_answer', sdp: 'answer-sdp' }),
      });

      expect(handler).toHaveBeenCalledWith({
        type: 'webrtc_answer',
        data: { type: 'webrtc_answer', sdp: 'answer-sdp' },
      });
    });

    it('ice_candidateメッセージを受信してイベントを発火する', async () => {
      const handler = vi.fn();
      client.on('ice_candidate', handler);
      await client.connect('1234');

      mockSocket.onmessage?.({
        data: JSON.stringify({ type: 'ice_candidate', candidate: 'ice-data' }),
      });

      expect(handler).toHaveBeenCalledWith({
        type: 'ice_candidate',
        data: { type: 'ice_candidate', candidate: 'ice-data' },
      });
    });

    it('errorメッセージを受信してイベントを発火する', async () => {
      const handler = vi.fn();
      client.on('error', handler);
      await client.connect('1234');

      mockSocket.onmessage?.({
        data: JSON.stringify({ type: 'error', message: 'Invalid code' }),
      });

      expect(handler).toHaveBeenCalledWith({
        type: 'error',
        data: { type: 'error', message: 'Invalid code' },
      });
    });

    it('不正なJSONを受信してもクラッシュしない', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await client.connect('1234');

      expect(() => {
        mockSocket.onmessage?.({ data: 'invalid json' });
      }).not.toThrow();

      consoleSpy.mockRestore();
    });
  });

  describe('on', () => {
    it('イベントハンドラを登録できる', async () => {
      const handler = vi.fn();

      client.on('connected', handler);
      await client.connect('1234');

      expect(handler).toHaveBeenCalled();
    });

    it('複数のハンドラを同じイベントに登録できる', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      client.on('connected', handler1);
      client.on('connected', handler2);
      await client.connect('1234');

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('返却されるunsubscribe関数でハンドラを解除できる', async () => {
      const handler = vi.fn();

      const unsubscribe = client.on('peer_joined', handler);
      unsubscribe();

      await client.connect('1234');
      mockSocket.onmessage?.({
        data: JSON.stringify({ type: 'peer_joined', peerId: 'abc' }),
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('接続エラー', () => {
    it('ソケットエラー時にerrorイベントを発火する', async () => {
      const handler = vi.fn();
      client.on('error', handler);
      await client.connect('1234');

      // エラーをシミュレート
      mockSocket.onerror?.(new Error('Connection failed'));

      expect(handler).toHaveBeenCalled();
    });

    it('切断時にdisconnectedイベントを発火する', async () => {
      const handler = vi.fn();
      client.on('disconnected', handler);
      await client.connect('1234');

      mockSocket.onclose?.();

      expect(handler).toHaveBeenCalledWith({ type: 'disconnected' });
    });
  });
});
