import { useState, useEffect } from 'react';
import { useTransfer } from './hooks/useTransfer';
import { useIOSReconnect } from './hooks/useIOSReconnect';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ConnectionStatus } from './components/ConnectionStatus';
import { TransferProgress } from './components/TransferProgress';
import { formatFileSize } from './utils/validators';
import { saveAs } from 'file-saver';

type AppMode = 'home' | 'send' | 'receive' | 'transferring' | 'completed';

function AppContent() {
  const [mode, setMode] = useState<AppMode>('home');
  const [digits, setDigits] = useState(['', '', '', '']);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const {
    status: transferStatus,
    progress,
    code,
    error,
    receivedFiles,
    initializeAsReceiver,
    initializeAsSender,
    cancel,
    reset,
  } = useTransfer();

  const { isIOSSafari, wrapFileInputClick } = useIOSReconnect({
    onReconnect: async () => {
      // Handle reconnection if needed
      console.log('iOS reconnect triggered');
    },
  });

  // Map transfer status to connection status for UI
  const connectionStatus = transferStatus === 'connecting' ? 'connecting'
    : transferStatus === 'waiting' ? 'connecting'
    : transferStatus === 'transferring' || transferStatus === 'completed' ? 'connected'
    : transferStatus === 'error' ? 'error'
    : 'disconnected';

  // Auto-transition to transferring mode when transfer starts
  useEffect(() => {
    if (transferStatus === 'transferring' && mode !== 'transferring') {
      setMode('transferring');
    } else if (transferStatus === 'completed' && mode !== 'completed') {
      setMode('completed');
    }
  }, [transferStatus, mode]);

  // Auto-download received files
  useEffect(() => {
    if (receivedFiles.length > 0 && transferStatus === 'completed') {
      receivedFiles.forEach(file => {
        saveAs(file, file.name);
      });
    }
  }, [receivedFiles, transferStatus]);

  const handleReceiveMode = async () => {
    setMode('receive');
    try {
      await initializeAsReceiver();
    } catch (err) {
      console.error('Failed to initialize receiver:', err);
    }
  };

  const handleSendMode = () => {
    setMode('send');
  };

  const handleDigitChange = (index: number, value: string) => {
    if (value && !/^\d$/.test(value)) return;

    const newDigits = [...digits];
    newDigits[index] = value;
    setDigits(newDigits);

    // Auto-focus next
    if (value && index < 3) {
      const next = document.getElementById(`digit-${index + 1}`);
      next?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      const prev = document.getElementById(`digit-${index - 1}`);
      prev?.focus();
    }
  };

  const handleBack = () => {
    cancel();
    reset();
    setMode('home');
    setDigits(['', '', '', '']);
    setSelectedFiles([]);
  };

  const handleCopyCode = async () => {
    if (code) {
      await navigator.clipboard.writeText(code);
    }
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    setSelectedFiles(files);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setSelectedFiles(files);
  };

  const handleFileInputClick = () => {
    const input = document.getElementById('file-input') as HTMLInputElement;
    if (isIOSSafari) {
      wrapFileInputClick(input);
    } else {
      input?.click();
    }
  };

  const handleTransfer = async () => {
    const enteredCode = digits.join('');
    if (enteredCode.length !== 4 || selectedFiles.length === 0) return;

    try {
      await initializeAsSender(enteredCode, selectedFiles);
    } catch (err) {
      console.error('Failed to start transfer:', err);
    }
  };

  // Calculate total file size
  const totalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0);
  const enteredCode = digits.join('');

  return (
    <>
      {/* Animated cosmic background */}
      <div className="cosmic-bg" />

      <div className="relative min-h-screen flex flex-col">
        {/* Header */}
        <header className="pt-12 pb-8 text-center animate-in">
          <h1 className="text-display text-4xl md:text-5xl text-white mb-2">
            flux
          </h1>
          <p className="text-muted text-sm tracking-wide">
            peer-to-peer file transfer
          </p>
        </header>

        {/* Main Content */}
        <main className="flex-1 flex items-center justify-center px-6 pb-12">

          {/* Home Screen */}
          {mode === 'home' && (
            <div className="w-full max-w-sm space-y-6 animate-scale-in">
              <button
                onClick={handleReceiveMode}
                className="btn-cosmic w-full py-5 text-lg"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                </svg>
                <span>Receive</span>
              </button>

              <div className="flex items-center gap-4">
                <div className="flex-1 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                <span className="text-dim text-xs uppercase tracking-widest">or</span>
                <div className="flex-1 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
              </div>

              <button
                onClick={handleSendMode}
                className="btn-ghost w-full py-4"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
                </svg>
                <span>Send</span>
              </button>
            </div>
          )}

          {/* Receive Screen - Giant Code Display */}
          {mode === 'receive' && (
            <div className="text-center space-y-12 animate-in">
              {/* Connection Status */}
              <ConnectionStatus status={connectionStatus} error={error} />

              {/* Giant glowing code */}
              <div className="code-giant select-all cursor-pointer" onClick={handleCopyCode}>
                {code || '----'}
              </div>

              {/* Status */}
              <div className="flex items-center justify-center gap-3">
                <div className="status-pulse" />
                <span className="text-muted text-sm">
                  {transferStatus === 'waiting' ? 'waiting for sender...' : 'connecting...'}
                </span>
              </div>

              {/* Copy hint */}
              <p className="text-dim text-xs">
                click code to copy
              </p>

              {/* Cancel */}
              <button onClick={handleBack} className="btn-ghost">
                Cancel
              </button>
            </div>
          )}

          {/* Send Screen - Code Input + File Select */}
          {mode === 'send' && (
            <div className="w-full max-w-md space-y-10 animate-in">
              {/* Code Input Section */}
              <div className="text-center space-y-6">
                <div>
                  <h2 className="text-display text-2xl text-white mb-2">Enter Code</h2>
                  <p className="text-muted text-sm">from the receiving device</p>
                </div>

                {/* 4-Digit Input */}
                <div className="flex justify-center gap-3">
                  {digits.map((digit, i) => (
                    <input
                      key={i}
                      id={`digit-${i}`}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={(e) => handleDigitChange(i, e.target.value)}
                      onKeyDown={(e) => handleKeyDown(i, e)}
                      className="digit-input"
                      autoFocus={i === 0}
                    />
                  ))}
                </div>
              </div>

              {/* File Drop Zone */}
              <div
                className={`drop-zone ${isDragging ? 'active' : ''}`}
                onDragEnter={() => setIsDragging(true)}
                onDragLeave={() => setIsDragging(false)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleFileDrop}
                onClick={handleFileInputClick}
              >
                <input
                  id="file-input"
                  type="file"
                  multiple
                  onChange={handleFileSelect}
                  className="hidden"
                />

                {selectedFiles.length === 0 ? (
                  <div className="text-center space-y-3">
                    <div className="w-14 h-14 mx-auto rounded-full bg-white/5 flex items-center justify-center">
                      <svg className="w-6 h-6 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-white text-sm font-medium">Drop files here</p>
                      <p className="text-dim text-xs mt-1">or click to browse</p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {selectedFiles.map((file, i) => (
                      <div key={i} className="file-item">
                        <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                          <svg className="w-5 h-5 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                          </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-white text-sm font-medium truncate">{file.name}</p>
                          <p className="text-dim text-xs">{formatFileSize(file.size)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Error Message */}
              {error && (
                <div className="text-center text-red-400 text-sm">
                  {error}
                </div>
              )}

              {/* Transfer Button */}
              {selectedFiles.length > 0 && enteredCode.length === 4 && (
                <button
                  onClick={handleTransfer}
                  disabled={transferStatus === 'connecting'}
                  className="btn-cosmic w-full py-5 text-lg animate-scale-in disabled:opacity-50"
                >
                  {transferStatus === 'connecting' ? (
                    <>
                      <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      <span>Connecting...</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                      </svg>
                      <span>Transfer</span>
                    </>
                  )}
                </button>
              )}

              {/* Back Button */}
              <div className="text-center">
                <button onClick={handleBack} className="btn-ghost">
                  Back
                </button>
              </div>
            </div>
          )}

          {/* Transferring Screen */}
          {mode === 'transferring' && (
            <div className="w-full max-w-md text-center space-y-10 animate-in">
              {/* Status */}
              <div className="space-y-4">
                <h2 className="text-display text-2xl text-white">
                  {transferStatus === 'connecting' ? 'Connecting...' : 'Transferring...'}
                </h2>
                <p className="text-muted text-sm">
                  {selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''} · {formatFileSize(totalSize)}
                </p>
              </div>

              {/* Progress */}
              <TransferProgress
                progress={progress.progress}
                speed={progress.speed}
                eta={progress.eta}
                bytesTransferred={progress.bytesTransferred}
                totalBytes={progress.totalBytes || totalSize}
              />

              {/* File list */}
              <div className="space-y-2">
                {selectedFiles.map((file, i) => (
                  <div key={i} className="file-item opacity-60">
                    <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                      <svg className="w-4 h-4 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm truncate">{file.name}</p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Cancel */}
              <button onClick={handleBack} className="btn-ghost">
                Cancel
              </button>
            </div>
          )}

          {/* Completed Screen */}
          {mode === 'completed' && (
            <div className="text-center space-y-10 animate-scale-in">
              {/* Success Icon */}
              <div className="w-24 h-24 mx-auto rounded-full bg-gradient-to-br from-green-500/20 to-emerald-500/20 flex items-center justify-center">
                <svg className="w-12 h-12 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>

              {/* Message */}
              <div className="space-y-3">
                <h2 className="text-display text-3xl text-white">Transfer Complete!</h2>
                <p className="text-muted">
                  {selectedFiles.length > 0
                    ? `${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''} sent successfully`
                    : `${receivedFiles.length} file${receivedFiles.length > 1 ? 's' : ''} received`
                  }
                </p>
              </div>

              {/* File summary */}
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 border border-white/10">
                <svg className="w-4 h-4 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <span className="text-sm text-muted">
                  {formatFileSize(totalSize || receivedFiles.reduce((sum, f) => sum + f.size, 0))}
                </span>
              </div>

              {/* Done button */}
              <button onClick={handleBack} className="btn-cosmic px-12">
                <span>Done</span>
              </button>
            </div>
          )}
        </main>

        {/* Footer */}
        <footer className="pb-8 text-center">
          <p className="text-dim text-xs tracking-wide">
            end-to-end encrypted
          </p>
        </footer>
      </div>
    </>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}
