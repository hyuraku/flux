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

  const initializeAsReceiver = useCallback(async (): Promise<string> => {
    setError(null);
    setReceivedFiles([]);

    const manager = createManager();
    const generatedCode = await manager.initializeAsReceiver();
    setCode(generatedCode);
    return generatedCode;
  }, [createManager]);

  const initializeAsSender = useCallback(async (targetCode: string, files: File[]): Promise<void> => {
    setError(null);
    setCode(targetCode);

    const manager = createManager();
    await manager.initializeAsSender(targetCode, files);
  }, [createManager]);

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
