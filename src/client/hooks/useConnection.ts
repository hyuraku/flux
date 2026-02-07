import { useState, useCallback, useEffect, useRef } from 'react';
import { SignalingClient } from '../core/connection/SignalingClient';
import { WebRTCConnection } from '../core/connection/WebRTCConnection';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface UseConnectionReturn {
  status: ConnectionStatus;
  isConnected: boolean;
  error: string | null;
  connect: (roomId: string) => Promise<void>;
  disconnect: () => void;
  signaling: SignalingClient | null;
  webrtc: WebRTCConnection | null;
}

export function useConnection(): UseConnectionReturn {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);

  const signalingRef = useRef<SignalingClient | null>(null);
  const webrtcRef = useRef<WebRTCConnection | null>(null);

  useEffect(() => {
    return () => {
      signalingRef.current?.disconnect();
      webrtcRef.current?.destroy();
    };
  }, []);

  const connect = useCallback(async (roomId: string) => {
    setStatus('connecting');
    setError(null);

    try {
      // Create signaling client
      const signaling = new SignalingClient();
      signalingRef.current = signaling;

      signaling.on('connected', () => {
        setStatus('connected');
      });

      signaling.on('disconnected', () => {
        setStatus('disconnected');
      });

      signaling.on('error', (event) => {
        setStatus('error');
        setError(event.data?.message || 'Connection error');
      });

      await signaling.connect(roomId);

      // Create WebRTC connection
      const webrtc = new WebRTCConnection();
      webrtcRef.current = webrtc;

      webrtc.on('connected', () => {
        setStatus('connected');
      });

      webrtc.on('disconnected', () => {
        setStatus('disconnected');
      });

      webrtc.on('error', (event) => {
        setStatus('error');
        const errorData = event.data as Error | { message?: string } | undefined;
        const message = errorData instanceof Error
          ? errorData.message
          : errorData?.message || 'WebRTC error';
        setError(message);
      });

    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Failed to connect');
    }
  }, []);

  const disconnect = useCallback(() => {
    signalingRef.current?.disconnect();
    webrtcRef.current?.destroy();
    signalingRef.current = null;
    webrtcRef.current = null;
    setStatus('disconnected');
    setError(null);
  }, []);

  return {
    status,
    isConnected: status === 'connected',
    error,
    connect,
    disconnect,
    signaling: signalingRef.current,
    webrtc: webrtcRef.current,
  };
}
