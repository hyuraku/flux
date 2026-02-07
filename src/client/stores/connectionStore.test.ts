import { describe, it, expect, beforeEach } from 'vitest';
import { useConnectionStore } from './connectionStore';

describe('connectionStore', () => {
  beforeEach(() => {
    useConnectionStore.getState().reset();
  });

  describe('初期状態', () => {
    it('statusはidleである', () => {
      const { status } = useConnectionStore.getState();
      expect(status).toBe('idle');
    });

    it('codeは空文字列である', () => {
      const { code } = useConnectionStore.getState();
      expect(code).toBe('');
    });

    it('roleはnullである', () => {
      const { role } = useConnectionStore.getState();
      expect(role).toBeNull();
    });

    it('peerIdは空文字列である', () => {
      const { peerId } = useConnectionStore.getState();
      expect(peerId).toBe('');
    });

    it('errorはnullである', () => {
      const { error } = useConnectionStore.getState();
      expect(error).toBeNull();
    });
  });

  describe('setCode', () => {
    it('コードを設定できる', () => {
      const { setCode } = useConnectionStore.getState();
      setCode('1234');

      const { code } = useConnectionStore.getState();
      expect(code).toBe('1234');
    });
  });

  describe('setRole', () => {
    it('roleをsenderに設定できる', () => {
      const { setRole } = useConnectionStore.getState();
      setRole('sender');

      const { role } = useConnectionStore.getState();
      expect(role).toBe('sender');
    });

    it('roleをreceiverに設定できる', () => {
      const { setRole } = useConnectionStore.getState();
      setRole('receiver');

      const { role } = useConnectionStore.getState();
      expect(role).toBe('receiver');
    });
  });

  describe('setStatus', () => {
    it('ステータスを更新できる', () => {
      const { setStatus } = useConnectionStore.getState();
      setStatus('connecting');

      const { status } = useConnectionStore.getState();
      expect(status).toBe('connecting');
    });

    it('複数のステータス遷移が可能', () => {
      const { setStatus } = useConnectionStore.getState();

      setStatus('waiting');
      expect(useConnectionStore.getState().status).toBe('waiting');

      setStatus('connecting');
      expect(useConnectionStore.getState().status).toBe('connecting');

      setStatus('connected');
      expect(useConnectionStore.getState().status).toBe('connected');
    });
  });

  describe('setPeerId', () => {
    it('peerIdを設定できる', () => {
      const { setPeerId } = useConnectionStore.getState();
      setPeerId('peer_abc123');

      const { peerId } = useConnectionStore.getState();
      expect(peerId).toBe('peer_abc123');
    });
  });

  describe('setError', () => {
    it('エラーメッセージを設定できる', () => {
      const { setError } = useConnectionStore.getState();
      setError('Connection failed');

      const { error } = useConnectionStore.getState();
      expect(error).toBe('Connection failed');
    });
  });

  describe('reset', () => {
    it('すべての状態を初期値にリセットする', () => {
      const store = useConnectionStore.getState();

      store.setCode('1234');
      store.setRole('sender');
      store.setStatus('connected');
      store.setPeerId('peer_xyz');
      store.setError('Test error');

      store.reset();

      const state = useConnectionStore.getState();
      expect(state.status).toBe('idle');
      expect(state.code).toBe('');
      expect(state.role).toBeNull();
      expect(state.peerId).toBe('');
      expect(state.error).toBeNull();
    });
  });
});
