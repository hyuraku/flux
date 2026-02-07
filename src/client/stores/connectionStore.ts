import { create } from 'zustand';
import type { ConnectionStore, ConnectionStatus, UserRole } from '@/types/connection.types';

const initialState = {
  status: 'idle' as ConnectionStatus,
  code: '',
  role: null as UserRole | null,
  peerId: '',
  error: null as string | null,
};

export const useConnectionStore = create<ConnectionStore>((set) => ({
  ...initialState,

  setCode: (code: string) => set({ code }),

  setRole: (role: UserRole) => set({ role }),

  setStatus: (status: ConnectionStatus) => set({ status }),

  setPeerId: (peerId: string) => set({ peerId }),

  setError: (error: string) => set({ error }),

  reset: () => set(initialState),
}));
