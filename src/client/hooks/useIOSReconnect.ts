import { useEffect, useRef, useCallback, useState } from 'react';

interface IOSReconnectState {
  lockId: string | null;
  isLocked: boolean;
  needsReconnect: boolean;
}

interface UseIOSReconnectOptions {
  onReconnect?: () => Promise<void>;
  lockTimeout?: number; // milliseconds
}

export function useIOSReconnect(options: UseIOSReconnectOptions = {}) {
  const { onReconnect, lockTimeout = 5 * 60 * 1000 } = options; // 5 minutes default

  const [state, setState] = useState<IOSReconnectState>({
    lockId: null,
    isLocked: false,
    needsReconnect: false,
  });

  const lockTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasHiddenRef = useRef(false);

  // Detect iOS Safari
  const isIOSSafari = useCallback(() => {
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream;
    const isSafari = /Safari/.test(ua) && !/Chrome/.test(ua) && !/CriOS/.test(ua);
    return isIOS && isSafari;
  }, []);

  // Generate a lock ID
  const generateLockId = useCallback(() => {
    return `lock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }, []);

  // Lock the connection before potentially backgrounding
  const lockConnection = useCallback(() => {
    if (!isIOSSafari()) return null;

    const lockId = generateLockId();

    setState(prev => ({
      ...prev,
      lockId,
      isLocked: true,
    }));

    // Set timeout to clear lock
    if (lockTimeoutRef.current) {
      clearTimeout(lockTimeoutRef.current);
    }

    lockTimeoutRef.current = setTimeout(() => {
      setState(prev => ({
        ...prev,
        lockId: null,
        isLocked: false,
      }));
    }, lockTimeout);

    return lockId;
  }, [isIOSSafari, generateLockId, lockTimeout]);

  // Unlock and potentially reconnect
  const unlockConnection = useCallback(async () => {
    if (lockTimeoutRef.current) {
      clearTimeout(lockTimeoutRef.current);
      lockTimeoutRef.current = null;
    }

    if (state.needsReconnect && onReconnect) {
      await onReconnect();
    }

    setState({
      lockId: null,
      isLocked: false,
      needsReconnect: false,
    });
  }, [state.needsReconnect, onReconnect]);

  // Handle visibility change (iOS backgrounds the app when file picker opens)
  useEffect(() => {
    if (!isIOSSafari()) return;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        wasHiddenRef.current = true;
        if (state.isLocked) {
          setState(prev => ({ ...prev, needsReconnect: true }));
        }
      } else {
        if (wasHiddenRef.current && state.needsReconnect) {
          unlockConnection();
        }
        wasHiddenRef.current = false;
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isIOSSafari, state.isLocked, state.needsReconnect, unlockConnection]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (lockTimeoutRef.current) {
        clearTimeout(lockTimeoutRef.current);
      }
    };
  }, []);

  // Wrapper for file input that handles iOS reconnection
  const wrapFileInputClick = useCallback((inputElement: HTMLInputElement | null) => {
    if (!inputElement) return;

    const lockId = lockConnection();

    // On iOS, clicking file input may background the app
    inputElement.click();

    // Return a function to handle the file selection completion
    return () => {
      if (lockId) {
        unlockConnection();
      }
    };
  }, [lockConnection, unlockConnection]);

  return {
    isIOSSafari: isIOSSafari(),
    isLocked: state.isLocked,
    lockId: state.lockId,
    lockConnection,
    unlockConnection,
    wrapFileInputClick,
  };
}
