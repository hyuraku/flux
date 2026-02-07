export type Role = 'sender' | 'receiver';

export type TransferStatus = 'idle' | 'connecting' | 'transferring' | 'completed' | 'error';

export type ErrorCode =
  | 'ROOM_FULL'
  | 'INVALID_CODE'
  | 'PEER_DISCONNECTED'
  | 'LOCK_EXPIRED'
  | 'LOCK_NOT_FOUND'
  | 'RATE_LIMITED';

// クライアント → サーバー メッセージ

export interface GenerateCodeMessage {
  type: 'generate_code';
  role?: 'receiver';
}

export interface JoinRoomMessage {
  type: 'join_room';
  code: string;
  role: Role;
}

export interface WebRTCOfferMessage {
  type: 'webrtc_offer';
  targetPeerId: string;
  sdp: string;
}

export interface WebRTCAnswerMessage {
  type: 'webrtc_answer';
  targetPeerId: string;
  sdp: string;
}

export interface ICECandidateMessage {
  type: 'ice_candidate';
  targetPeerId: string;
  candidate: string;
}

export interface LockConnectionMessage {
  type: 'lock_connection';
  roomId: string;
  peerId: string;
}

export interface ReconnectWithLockMessage {
  type: 'reconnect_with_lock';
  lockId: string;
  roomId: string;
}

export interface TransferStatusMessage {
  type: 'transfer_status';
  status: TransferStatus;
  progress: number;
  speed: number; // bytes/sec
}

// サーバー → クライアント メッセージ

export interface CodeGeneratedMessage {
  type: 'code_generated';
  code: string;
  roomId: string;
  timestamp: number;
}

export interface PeerJoinedMessage {
  type: 'peer_joined';
  peerId: string;
  role: Role;
  timestamp: number;
}

export interface PeerLeftMessage {
  type: 'peer_left';
  peerId: string;
  timestamp: number;
}

export interface ConnectionLockedMessage {
  type: 'connection_locked';
  lockId: string;
  expiresAt: number;
}

export interface PeerStatusMessage {
  type: 'peer_status';
  fromPeerId: string;
  status: TransferStatus;
  progress: number;
  speed: number;
}

export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  message: string;
}

// ユニオン型

export type ClientMessage =
  | GenerateCodeMessage
  | JoinRoomMessage
  | WebRTCOfferMessage
  | WebRTCAnswerMessage
  | ICECandidateMessage
  | LockConnectionMessage
  | ReconnectWithLockMessage
  | TransferStatusMessage;

export type ServerMessage =
  | CodeGeneratedMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | ConnectionLockedMessage
  | PeerStatusMessage
  | WebRTCOfferMessage
  | WebRTCAnswerMessage
  | ICECandidateMessage
  | ErrorMessage;

// Combined type for all signaling messages
export type SignalingMessage = ClientMessage | ServerMessage;

// ルーム状態

export interface RoomState {
  code: string;
  createdAt: number;
  receiver?: string; // connection id
  sender?: string;   // connection id
  locks: Map<string, ConnectionLock>;
}

export interface ConnectionLock {
  lockId: string;
  peerId: string;
  expiresAt: number;
}
