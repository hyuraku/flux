import PartySocket from 'partysocket';
import type { SignalingMessage } from '../../../party/types';

export type SignalingEventType =
  | 'connected'
  | 'reconnected'
  | 'disconnected'
  | 'code_generated'
  | 'peer_joined'
  | 'peer_left'
  | 'webrtc_offer'
  | 'webrtc_answer'
  | 'ice_candidate'
  | 'error';

export interface SignalingEvent {
  type: SignalingEventType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

export type SignalingEventHandler = (event: SignalingEvent) => void;

/**
 * PartyKit シグナリングサーバのホストを解決する。
 *
 * 本番ビルドでホストが未設定のまま `localhost:1999` に黙ってフォールバック
 * すると、接続できないのにエラーも出ない状態になる。そのため本番では明示的に
 * 例外を投げて「気づける」ようにする（dev のみ localhost をデフォルトにする）。
 */
function resolvePartyKitHost(): string {
  const env = (import.meta as ImportMeta & {
    env?: { VITE_PARTYKIT_HOST?: string; DEV?: boolean };
  }).env;

  const configured = env?.VITE_PARTYKIT_HOST?.trim();
  if (configured) {
    return configured;
  }

  if (env?.DEV) {
    // ローカル開発用デフォルト（npx partykit dev）
    return 'localhost:1999';
  }

  throw new Error(
    'VITE_PARTYKIT_HOST is not set. The signaling server host must be ' +
      'configured at build time for production deployments.'
  );
}

/**
 * 再接続は PartySocket（ReconnectingWebSocket）だけに任せる。以前はここでも
 * setTimeout で connect() を張り直していたため、PartySocket 自身の再接続と
 * 二重になり、古いソケットへの参照を失って disconnect() でも閉じられない
 * 状態になっていた。所有者を 1 つにし、上限付きのリトライだけを設定する。
 */
const RECONNECT_OPTIONS = {
  maxRetries: 3,
  minReconnectionDelay: 1000,
  maxReconnectionDelay: 8000,
} as const;

export class SignalingClient {
  private socket: PartySocket | null = null;
  private eventHandlers: Map<SignalingEventType, Set<SignalingEventHandler>> = new Map();
  private roomId: string | null = null;
  private peerId: string | null = null;
  /** 現在のソケットが一度でも open したか（2 回目以降の open は reconnected） */
  private hasOpened = false;
  /** 決着前の connect()。決着後は null なので二重に resolve / reject しない。 */
  private pendingConnect: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private host: string;

  constructor(host?: string) {
    this.host = host ?? resolvePartyKitHost();
  }

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get currentRoomId(): string | null {
    return this.roomId;
  }

  get currentPeerId(): string | null {
    return this.peerId;
  }

  /**
   * シグナリングサーバへ接続する。返す Promise はちょうど 1 回だけ決着する:
   * 最初の open で resolve、初回 open 前の失敗（error / close）で reject。
   * 決着後の close / error はイベントを流すだけで Promise には触れない。
   */
  async connect(roomId: string): Promise<void> {
    // 張り直す前に必ず閉じる。閉じずに上書きすると古いソケットが再接続を
    // 続けたまま参照だけ失われる。
    this.closeSocket();

    return new Promise<void>((resolve, reject) => {
      this.roomId = roomId;

      const socket = new PartySocket({
        host: this.host,
        room: roomId,
        ...RECONNECT_OPTIONS,
      });
      this.socket = socket;
      // 決着させる手段を保持しておく。決着済みなら null。
      this.pendingConnect = { resolve, reject };

      /** このソケットが現役かどうか。disconnect 後の残響イベントは捨てる。 */
      const isCurrent = () => this.socket === socket;

      /** 初回 open 前の失敗。リトライを続けさせず、ソケットも残さない。 */
      const failBeforeOpen = (message: string) => {
        const pending = this.pendingConnect;
        this.pendingConnect = null;
        this.closeSocket();
        pending?.reject(new Error(message));
      };

      socket.onopen = () => {
        if (!isCurrent()) return;
        const isFirstOpen = !this.hasOpened;
        this.hasOpened = true;
        this.emit({ type: isFirstOpen ? 'connected' : 'reconnected' });

        const pending = this.pendingConnect;
        this.pendingConnect = null;
        pending?.resolve();
      };

      socket.onclose = () => {
        if (!isCurrent()) return;
        if (this.hasOpened) {
          this.emit({ type: 'disconnected' });
          return;
        }
        // 一度も open していないまま閉じた＝接続失敗。
        failBeforeOpen('Signaling connection closed before it opened');
        this.emit({ type: 'disconnected' });
      };

      socket.onerror = (error) => {
        if (!isCurrent()) return;
        if (!this.hasOpened) {
          failBeforeOpen('Could not connect to the signaling server');
        }
        this.emit({ type: 'error', data: { message: 'Connection error', error } });
      };

      socket.onmessage = (event) => {
        if (!isCurrent()) return;
        this.handleMessage(event.data);
      };
    });
  }

  /**
   * 現在のソケットを閉じて参照を捨てる。close() は PartySocket の
   * 自動再接続も止める（内部の _shouldReconnect が false になる）。
   * 接続待ちの Promise が残っていれば、宙吊りにせず reject する。
   */
  private closeSocket(): void {
    const socket = this.socket;
    const pending = this.pendingConnect;
    this.socket = null;
    this.pendingConnect = null;
    this.hasOpened = false;

    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }

    pending?.reject(new Error('Signaling connection was closed'));
  }

  private handleMessage(data: string) {
    try {
      const message: SignalingMessage = JSON.parse(data);

      switch (message.type) {
        case 'code_generated':
          this.emit({ type: 'code_generated', data: message });
          break;

        case 'peer_joined':
          this.emit({ type: 'peer_joined', data: message });
          break;

        case 'peer_left':
          this.emit({ type: 'peer_left', data: message });
          break;

        case 'webrtc_offer':
          this.emit({ type: 'webrtc_offer', data: message });
          break;

        case 'webrtc_answer':
          this.emit({ type: 'webrtc_answer', data: message });
          break;

        case 'ice_candidate':
          this.emit({ type: 'ice_candidate', data: message });
          break;

        case 'error':
          this.emit({ type: 'error', data: message });
          break;
      }
    } catch (error) {
      console.error('Failed to parse signaling message:', error);
    }
  }

  send(message: SignalingMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Socket not connected');
    }
    this.socket.send(JSON.stringify(message));
  }

  generateCode(): void {
    this.send({ type: 'generate_code' });
  }

  joinRoom(code: string, role: 'sender' | 'receiver'): void {
    this.send({ type: 'join_room', code, role });
  }

  sendOffer(targetPeerId: string, sdp: string): void {
    this.send({ type: 'webrtc_offer', targetPeerId, sdp });
  }

  sendAnswer(targetPeerId: string, sdp: string): void {
    this.send({ type: 'webrtc_answer', targetPeerId, sdp });
  }

  sendIceCandidate(targetPeerId: string, candidate: string): void {
    this.send({ type: 'ice_candidate', targetPeerId, candidate });
  }

  on(event: SignalingEventType, handler: SignalingEventHandler): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);

    return () => {
      this.eventHandlers.get(event)?.delete(handler);
    };
  }

  private emit(event: SignalingEvent): void {
    this.eventHandlers.get(event.type)?.forEach(handler => handler(event));
  }

  disconnect(): void {
    this.closeSocket();
    this.roomId = null;
    this.peerId = null;
    this.eventHandlers.clear();
  }
}
