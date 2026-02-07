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
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
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
    if (value && index < 5) {
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
    setDigits(['', '', '', '', '', '']);
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
    if (enteredCode.length !== 6 || selectedFiles.length === 0) return;

    try {
      await initializeAsSender(enteredCode, selectedFiles);
    } catch (err) {
      console.error('Failed to start transfer:', err);
    }
  };

  const totalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0);
  const enteredCode = digits.join('');

  return (
    <>
      <div className="cosmic-bg" />

      <div className="relative min-h-screen flex flex-col">
        <header className="pt-12 pb-8 text-center animate-in">
          <h1 className="text-display text-4xl md:text-5xl text-white mb-2">
            flux
          </h1>
          <p className="text-muted text-sm tracking-wide">
            peer-to-peer file transfer
          </p>
        </header>

        <main className={`flex-1 px-6 pb-12 ${mode === 'home' ? 'overflow-y-auto' : 'flex items-center justify-center'}`}>

          {/* Home Screen */}
          {mode === 'home' && (
            <div className="w-full max-w-2xl mx-auto py-8 space-y-16 animate-scale-in">
              <div className="max-w-sm mx-auto space-y-6">
                <button
                  onClick={handleReceiveMode}
                  className="btn-cosmic w-full py-5 text-lg"
                  aria-label="Receive files"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
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
                  className="btn-cosmic-alt w-full py-5 text-lg"
                  aria-label="Send files"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
                  </svg>
                  <span>Send</span>
                </button>
              </div>

              <section className="text-center space-y-6">
                <h2 className="text-display text-2xl text-white">What's flux?</h2>
                <p className="text-muted text-sm leading-relaxed max-w-md mx-auto">
                  A fast, privacy-focused file transfer tool. Files are sent directly between devices using WebRTC peer-to-peer technology — no server storage, no upload limits.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4">
                  <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                    <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-indigo-500/20 flex items-center justify-center">
                      <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                    </div>
                    <h3 className="text-white text-sm font-medium mb-1">End-to-End Encrypted</h3>
                    <p className="text-dim text-xs">Your files stay private</p>
                  </div>
                  <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                    <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-cyan-500/20 flex items-center justify-center">
                      <svg className="w-5 h-5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    </div>
                    <h3 className="text-white text-sm font-medium mb-1">Blazingly Fast</h3>
                    <p className="text-dim text-xs">Direct P2P transfer</p>
                  </div>
                  <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                    <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-emerald-500/20 flex items-center justify-center">
                      <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                      </svg>
                    </div>
                    <h3 className="text-white text-sm font-medium mb-1">No Server Storage</h3>
                    <p className="text-dim text-xs">Data never touches our servers</p>
                  </div>
                </div>
              </section>

              <section className="text-center space-y-6">
                <h2 className="text-display text-2xl text-white">How to use</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="p-5 rounded-xl bg-white/5 border border-white/10 text-left">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="w-8 h-8 rounded-full bg-indigo-500/30 text-indigo-300 flex items-center justify-center text-sm font-bold">1</span>
                      <h3 className="text-white text-sm font-medium">Open flux on both devices</h3>
                    </div>
                    <p className="text-dim text-xs pl-11">Visit this site on the device you want to send from and the device you want to receive on.</p>
                  </div>
                  <div className="p-5 rounded-xl bg-white/5 border border-white/10 text-left">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="w-8 h-8 rounded-full bg-indigo-500/30 text-indigo-300 flex items-center justify-center text-sm font-bold">2</span>
                      <h3 className="text-white text-sm font-medium">Get code on receiver</h3>
                    </div>
                    <p className="text-dim text-xs pl-11">Click "Receive" on the receiving device to get a 6-digit code.</p>
                  </div>
                  <div className="p-5 rounded-xl bg-white/5 border border-white/10 text-left">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="w-8 h-8 rounded-full bg-indigo-500/30 text-indigo-300 flex items-center justify-center text-sm font-bold">3</span>
                      <h3 className="text-white text-sm font-medium">Enter code & select files</h3>
                    </div>
                    <p className="text-dim text-xs pl-11">Click "Send" on the sending device, enter the code, and choose your files.</p>
                  </div>
                  <div className="p-5 rounded-xl bg-white/5 border border-white/10 text-left">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="w-8 h-8 rounded-full bg-indigo-500/30 text-indigo-300 flex items-center justify-center text-sm font-bold">4</span>
                      <h3 className="text-white text-sm font-medium">Transfer!</h3>
                    </div>
                    <p className="text-dim text-xs pl-11">Files transfer directly between devices at maximum speed.</p>
                  </div>
                </div>
              </section>

              <section className="space-y-8">
                <h2 className="text-display text-2xl text-white text-center">FAQ</h2>
                <div className="space-y-4">
                  <div className="group relative pl-5 py-3 border-l-2 border-transparent hover:border-l-0 transition-all duration-300"
                       style={{ borderImage: 'linear-gradient(180deg, #a78bfa, #22d3ee) 1' }}>
                    <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-gradient-to-b from-violet-400 to-cyan-400 opacity-60 group-hover:opacity-100 transition-opacity" />
                    <h3 className="text-white/90 text-sm font-medium mb-1 group-hover:text-white transition-colors">Is there a file size limit?</h3>
                    <p className="text-zinc-500 text-xs leading-relaxed">Up to 2GB per transfer. Files go directly between devices.</p>
                  </div>
                  <div className="group relative pl-5 py-3">
                    <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-gradient-to-b from-violet-400 to-cyan-400 opacity-60 group-hover:opacity-100 transition-opacity" />
                    <h3 className="text-white/90 text-sm font-medium mb-1 group-hover:text-white transition-colors">Are my files stored on a server?</h3>
                    <p className="text-zinc-500 text-xs leading-relaxed">No. Files go directly from sender to receiver via P2P.</p>
                  </div>
                  <div className="group relative pl-5 py-3">
                    <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-gradient-to-b from-violet-400 to-cyan-400 opacity-60 group-hover:opacity-100 transition-opacity" />
                    <h3 className="text-white/90 text-sm font-medium mb-1 group-hover:text-white transition-colors">Is it secure?</h3>
                    <p className="text-zinc-500 text-xs leading-relaxed">Yes. All transfers are end-to-end encrypted.</p>
                  </div>
                  <div className="group relative pl-5 py-3">
                    <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-gradient-to-b from-violet-400 to-cyan-400 opacity-60 group-hover:opacity-100 transition-opacity" />
                    <h3 className="text-white/90 text-sm font-medium mb-1 group-hover:text-white transition-colors">Does it work on mobile?</h3>
                    <p className="text-zinc-500 text-xs leading-relaxed">Yes. Works on any modern browser.</p>
                  </div>
                  <div className="group relative pl-5 py-3">
                    <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-gradient-to-b from-violet-400 to-cyan-400 opacity-60 group-hover:opacity-100 transition-opacity" />
                    <h3 className="text-white/90 text-sm font-medium mb-1 group-hover:text-white transition-colors">What happens if the connection drops?</h3>
                    <p className="text-zinc-500 text-xs leading-relaxed">The transfer will stop. You'll need to start again.</p>
                  </div>
                </div>
              </section>
            </div>
          )}

          {/* Receive Screen - Giant Code Display */}
          {mode === 'receive' && (
            <div className="text-center space-y-12 animate-in">
              <ConnectionStatus status={connectionStatus} error={error} />

              <div
                className="code-giant select-all cursor-pointer"
                onClick={handleCopyCode}
                role="button"
                tabIndex={0}
                aria-label={`Transfer code ${code || 'generating'}. Click to copy`}
                onKeyDown={(e) => e.key === 'Enter' && handleCopyCode()}
              >
                {code || '----'}
              </div>

              <div className="flex items-center justify-center gap-3" role="status" aria-live="polite">
                <div className="status-pulse" aria-hidden="true" />
                <span className="text-muted text-sm">
                  {transferStatus === 'waiting' ? 'waiting for sender...' : 'connecting...'}
                </span>
              </div>

              <p className="text-dim text-xs">
                click code to copy
              </p>

              <button onClick={handleBack} className="btn-ghost" aria-label="Cancel receiving">
                Cancel
              </button>
            </div>
          )}

          {/* Send Screen - Code Input + File Select */}
          {mode === 'send' && (
            <div className="w-full max-w-md space-y-10 animate-in">
              <div className="text-center space-y-6">
                <div>
                  <h2 className="text-display text-2xl text-white mb-2">Enter Code</h2>
                  <p className="text-muted text-sm">from the receiving device</p>
                </div>

                <div className="flex justify-center gap-3" role="group" aria-label="6-digit transfer code input">
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
                      aria-label={`Digit ${i + 1}`}
                    />
                  ))}
                </div>
              </div>

              <div
                className={`drop-zone ${isDragging ? 'active' : ''}`}
                onDragEnter={() => setIsDragging(true)}
                onDragLeave={() => setIsDragging(false)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleFileDrop}
                onClick={handleFileInputClick}
                role="button"
                tabIndex={0}
                aria-label={selectedFiles.length > 0 ? `${selectedFiles.length} file(s) selected` : 'Drop files or click to select'}
                onKeyDown={(e) => e.key === 'Enter' && handleFileInputClick()}
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

              {error && (
                <div className="text-center text-red-400 text-sm">
                  {error}
                </div>
              )}

              {selectedFiles.length > 0 && enteredCode.length === 6 && (
                <button
                  onClick={handleTransfer}
                  disabled={transferStatus === 'connecting'}
                  className="btn-cosmic w-full py-5 text-lg animate-scale-in disabled:opacity-50"
                  aria-label="Transfer files"
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

              <div className="text-center">
                <button onClick={handleBack} className="btn-ghost" aria-label="Back to home">
                  Back
                </button>
              </div>
            </div>
          )}

          {/* Transferring Screen */}
          {mode === 'transferring' && (
            <div className="w-full max-w-md text-center space-y-10 animate-in" role="status" aria-live="polite">
              <div className="space-y-4">
                <h2 className="text-display text-2xl text-white">
                  {transferStatus === 'connecting' ? 'Connecting...' : 'Transferring...'}
                </h2>
                <p className="text-muted text-sm">
                  {selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''} · {formatFileSize(totalSize)}
                </p>
              </div>

              <TransferProgress
                progress={progress.progress}
                speed={progress.speed}
                eta={progress.eta}
                bytesTransferred={progress.bytesTransferred}
                totalBytes={progress.totalBytes || totalSize}
              />

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

              <button onClick={handleBack} className="btn-ghost" aria-label="Cancel transfer">
                Cancel
              </button>
            </div>
          )}

          {/* Completed Screen */}
          {mode === 'completed' && (
            <div className="text-center space-y-10 animate-scale-in" role="status" aria-live="polite">
              <div className="w-24 h-24 mx-auto rounded-full bg-gradient-to-br from-green-500/20 to-emerald-500/20 flex items-center justify-center">
                <svg className="w-12 h-12 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>

              <div className="space-y-3">
                <h2 className="text-display text-3xl text-white">Transfer Complete!</h2>
                <p className="text-muted">
                  {selectedFiles.length > 0
                    ? `${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''} sent successfully`
                    : `${receivedFiles.length} file${receivedFiles.length > 1 ? 's' : ''} received`
                  }
                </p>
              </div>

              <button onClick={handleBack} className="btn-cosmic px-12" aria-label="Done, back to home">
                <span>Done</span>
              </button>
            </div>
          )}
        </main>

        <footer className="pb-8 text-center space-y-3">
          <p className="text-dim text-xs tracking-wide">
            end-to-end encrypted
          </p>
          <a
            href="https://github.com/hyuraku/flux"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-dim text-xs hover:text-white/70 transition-colors"
            aria-label="View source on GitHub"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
            </svg>
            <span>GitHub</span>
          </a>
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
