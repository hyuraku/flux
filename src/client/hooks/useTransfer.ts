import { useState, useCallback, useEffect, useRef } from 'react';
import { TransferManager, type TransferStatus, type TransferProgress, type TransferOptions } from '../core/transfer/TransferManager';

export interface UseTransferReturn {
  status: TransferStatus;
  progress: TransferProgress;
  code: string | null;
  error: string | null;
  receivedFiles: File[];
  initializeAsReceiver: () => Promise<string>;
  initializeAsSender: (code: string, files: File[]) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

export function useTransfer(options: TransferOptions = {}): UseTransferReturn {
  const [status, setStatus] = useState<TransferStatus>('idle');
  const [progress, setProgress] = useState<TransferProgress>({
    status: 'idle',
    progress: 0,
    speed: 0,
    eta: 0,
    bytesTransferred: 0,
    totalBytes: 0,
  });
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<File[]>([]);

  const managerRef = useRef<TransferManager | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      managerRef.current?.cleanup();
    };
  }, []);

  const createManager = useCallback(() => {
    // Cleanup existing manager
    managerRef.current?.cleanup();

    const manager = new TransferManager(options);

    manager.on('status_change', (event) => {
      setStatus(event.data.status);
    });

    manager.on('progress', (event) => {
      setProgress(event.data);
    });

    manager.on('file_received', (event) => {
      setReceivedFiles(prev => [...prev, event.data]);
    });

    manager.on('error', (event) => {
      setError(event.data?.message || 'Unknown error');
    });

    manager.on('transfer_complete', () => {
      setStatus('completed');
    });

    managerRef.current = manager;
    return manager;
  }, [options]);

  /**
   * 初期化失敗を必ず UI に出す。TransferManager 側も error イベントを出すので
   * 二重に呼ばれ得るが、同じ値を入れるだけなので冪等。呼び出し側が await して
   * いる場合のために再スローする。
   */
  const failInit = useCallback((err: unknown, fallback: string): never => {
    setStatus('error');
    setError(err instanceof Error && err.message.length > 0 ? err.message : fallback);
    throw err;
  }, []);

  const initializeAsReceiver = useCallback(async (): Promise<string> => {
    setError(null);
    setReceivedFiles([]);

    const manager = createManager();
    try {
      const generatedCode = await manager.initializeAsReceiver();
      setCode(generatedCode);
      return generatedCode;
    } catch (err) {
      return failInit(err, 'Could not start receiving.');
    }
  }, [createManager, failInit]);

  const initializeAsSender = useCallback(async (targetCode: string, files: File[]): Promise<void> => {
    setError(null);
    setCode(targetCode);

    const manager = createManager();
    try {
      await manager.initializeAsSender(targetCode, files);
    } catch (err) {
      failInit(err, 'Could not start the transfer.');
    }
  }, [createManager, failInit]);

  const cancel = useCallback(() => {
    managerRef.current?.cancel();
    setStatus('cancelled');
  }, []);

  const reset = useCallback(() => {
    managerRef.current?.cleanup();
    managerRef.current = null;
    setStatus('idle');
    setProgress({
      status: 'idle',
      progress: 0,
      speed: 0,
      eta: 0,
      bytesTransferred: 0,
      totalBytes: 0,
    });
    setCode(null);
    setError(null);
    setReceivedFiles([]);
  }, []);

  return {
    status,
    progress,
    code,
    error,
    receivedFiles,
    initializeAsReceiver,
    initializeAsSender,
    cancel,
    reset,
  };
}
