import PartySocket from 'partysocket';
import type { SignalingMessage } from '../../../party/types';

export type SignalingEventType =
  | 'connected'
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

export class SignalingClient {
  private socket: PartySocket | null = null;
  private eventHandlers: Map<SignalingEventType, Set<SignalingEventHandler>> = new Map();
  private roomId: string | null = null;
  private peerId: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;

  constructor(
    private host: string = (import.meta as ImportMeta & { env?: { VITE_PARTYKIT_HOST?: string } }).env?.VITE_PARTYKIT_HOST ?? 'localhost:1999'
  ) {}

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get currentRoomId(): string | null {
    return this.roomId;
  }

  get currentPeerId(): string | null {
    return this.peerId;
  }

  async connect(roomId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.roomId = roomId;

        this.socket = new PartySocket({
          host: this.host,
          room: roomId,
        });

        this.socket.onopen = () => {
          this.reconnectAttempts = 0;
          this.emit({ type: 'connected' });
          resolve();
        };

        this.socket.onclose = () => {
          this.emit({ type: 'disconnected' });
          this.handleReconnect();
        };

        this.socket.onerror = (error) => {
          this.emit({ type: 'error', data: { message: 'Connection error', error } });
          reject(error);
        };

        this.socket.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      } catch (error) {
        reject(error);
      }
    });
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

  private handleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts && this.roomId) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);

      setTimeout(() => {
        if (this.roomId) {
          this.connect(this.roomId).catch(console.error);
        }
      }, delay);
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
    this.socket?.close();
    this.socket = null;
    this.roomId = null;
    this.peerId = null;
    this.eventHandlers.clear();
  }
}
