export type ConnectionStatus =
  | 'idle'
  | 'generating'
  | 'waiting'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export type UserRole = 'sender' | 'receiver';

export interface ConnectionState {
  status: ConnectionStatus;
  code: string;
  role: UserRole | null;
  peerId: string;
  error: string | null;
}

export interface ConnectionActions {
  setCode: (code: string) => void;
  setRole: (role: UserRole) => void;
  setStatus: (status: ConnectionStatus) => void;
  setPeerId: (peerId: string) => void;
  setError: (error: string) => void;
  reset: () => void;
}

export type ConnectionStore = ConnectionState & ConnectionActions;
