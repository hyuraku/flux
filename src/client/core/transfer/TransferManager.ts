import { SignalingClient } from '../connection/SignalingClient';
import { WebRTCConnection } from '../connection/WebRTCConnection';
import { ChunkManager, type ChunkMetadata } from './ChunkManager';
import { CompressionService } from './CompressionService';

export type TransferStatus =
  | 'idle'
  | 'connecting'
  | 'waiting'
  | 'transferring'
  | 'completed'
  | 'error'
  | 'cancelled';

export type TransferRole = 'sender' | 'receiver';

export interface TransferProgress {
  status: TransferStatus;
  progress: number;
  speed: number; // bytes per second
  eta: number; // seconds remaining
  bytesTransferred: number;
  totalBytes: number;
  currentFile?: string;
}

export interface TransferOptions {
  enableCompression?: boolean;
  enableEncryption?: boolean;
  chunkSize?: number;
}

export type TransferEventType =
  | 'status_change'
  | 'progress'
  | 'file_received'
  | 'transfer_complete'
  | 'error';

export interface TransferEvent {
  type: TransferEventType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

export type TransferEventHandler = (event: TransferEvent) => void;

interface FileMetadataMessage {
  type: 'file_metadata';
  metadata: ChunkMetadata;
  compressed: boolean;
  encrypted: boolean;
  publicKey?: JsonWebKey;
}

interface TransferCompleteMessage {
  type: 'transfer_complete';
}

export class TransferManager {
  private signaling: SignalingClient;
  private webrtc: WebRTCConnection;
  private chunkManager: ChunkManager;
  private compression: CompressionService;

  private status: TransferStatus = 'idle';
  private role: TransferRole | null = null;
  private _roomId: string | null = null;
  private targetPeerId: string | null = null;
  private files: File[] = [];

  private bytesTransferred = 0;
  private totalBytes = 0;
  private _transferStartTime = 0;
  private lastProgressTime = 0;
  private lastBytesTransferred = 0;

  private options: Required<TransferOptions>;
  private eventHandlers: Map<TransferEventType, Set<TransferEventHandler>> = new Map();
  private cleanupFunctions: (() => void)[] = [];
  private webrtcCreated = false;
  private isCurrentFileCompressed = false;

  constructor(options: TransferOptions = {}) {
    this.options = {
      enableCompression: options.enableCompression ?? true,
      enableEncryption: options.enableEncryption ?? true,
      chunkSize: options.chunkSize ?? 16 * 1024,
    };

    this.signaling = new SignalingClient();
    this.webrtc = new WebRTCConnection();
    this.chunkManager = new ChunkManager(this.options.chunkSize);
    this.compression = new CompressionService();
  }

  get currentStatus(): TransferStatus {
    return this.status;
  }

  get currentProgress(): TransferProgress {
    const now = Date.now();
    const elapsed = (now - this.lastProgressTime) / 1000;
    const bytesDelta = this.bytesTransferred - this.lastBytesTransferred;
    const speed = elapsed > 0 ? bytesDelta / elapsed : 0;
    const remaining = this.totalBytes - this.bytesTransferred;
    const eta = speed > 0 ? remaining / speed : 0;

    return {
      status: this.status,
      progress: this.totalBytes > 0 ? (this.bytesTransferred / this.totalBytes) * 100 : 0,
      speed,
      eta,
      bytesTransferred: this.bytesTransferred,
      totalBytes: this.totalBytes,
    };
  }

  async initializeAsReceiver(): Promise<string> {
    this.role = 'receiver';
    this.setStatus('connecting');

    const code = String(Math.floor(100000 + Math.random() * 900000));
    this._roomId = code;

    await this.signaling.connect(code);
    this.setupSignalingHandlers();

    this.signaling.generateCode();

    this.setStatus('waiting');
    return code;
  }

  async initializeAsSender(code: string, files: File[]): Promise<void> {
    this.role = 'sender';
    this.files = files;
    this._roomId = code;
    this.totalBytes = files.reduce((sum, f) => sum + f.size, 0);

    this.setStatus('connecting');

    await this.signaling.connect(code);
    this.setupSignalingHandlers();

    this.signaling.joinRoom(code, 'sender');
  }

  private setupSignalingHandlers(): void {
    const cleanup1 = this.signaling.on('peer_joined', (event) => {
      const peerRole = event.data.role;
      if (peerRole === this.role) {
        return;
      }

      this.targetPeerId = event.data.peerId;

      if (this.role === 'receiver') {
        this.webrtc.create({ initiator: true });
        this.setupWebRTCHandlers();
        this.webrtcCreated = true;
      }
    });

    const cleanup2 = this.signaling.on('webrtc_offer', (event) => {
      if (this.role === 'sender') {
        if (event.data.fromPeerId) {
          this.targetPeerId = event.data.fromPeerId;
        }
        if (!this.webrtcCreated) {
          this.webrtc.create({ initiator: false });
          this.setupWebRTCHandlers();
          this.webrtcCreated = true;
        }
        this.webrtc.signal(JSON.parse(event.data.sdp));
      }
    });

    const cleanup3 = this.signaling.on('webrtc_answer', (event) => {
      if (this.role === 'receiver') {
        this.webrtc.signal(JSON.parse(event.data.sdp));
      }
    });

    const cleanup4 = this.signaling.on('ice_candidate', (event) => {
      if (!this.targetPeerId && event.data.fromPeerId) {
        this.targetPeerId = event.data.fromPeerId;
      }
      this.webrtc.signal(JSON.parse(event.data.candidate));
    });

    const cleanup5 = this.signaling.on('error', (event) => {
      this.setStatus('error');
      this.emit({ type: 'error', data: event.data });
    });

    this.cleanupFunctions.push(cleanup1, cleanup2, cleanup3, cleanup4, cleanup5);
  }

  private setupWebRTCHandlers(): void {
    const cleanup1 = this.webrtc.on('signal', (event) => {
      if (!this.targetPeerId) return;

      const signalData = event.data as { type?: string; candidate?: unknown };
      const signalStr = JSON.stringify(signalData);

      if (signalData.type === 'offer') {
        this.signaling.sendOffer(this.targetPeerId, signalStr);
      } else if (signalData.type === 'answer') {
        this.signaling.sendAnswer(this.targetPeerId, signalStr);
      } else if (signalData.candidate) {
        this.signaling.sendIceCandidate(this.targetPeerId, signalStr);
      }
    });

    const cleanup2 = this.webrtc.on('connected', () => {
      if (this.role === 'sender') {
        this.startSending();
      } else {
        this.setStatus('transferring');
      }
    });

    const cleanup3 = this.webrtc.on('data', (event) => {
      this.handleReceivedData(event.data as Uint8Array | string);
    });

    const cleanup4 = this.webrtc.on('error', (event) => {
      this.setStatus('error');
      this.emit({ type: 'error', data: event.data });
    });

    const cleanup5 = this.webrtc.on('disconnected', () => {
      if (this.status !== 'completed' && this.status !== 'cancelled') {
        this.setStatus('error');
        this.emit({ type: 'error', data: { message: 'Connection lost' } });
      }
    });

    this.cleanupFunctions.push(cleanup1, cleanup2, cleanup3, cleanup4, cleanup5);
  }

  private async startSending(): Promise<void> {
    this.setStatus('transferring');
    this._transferStartTime = Date.now();
    this.lastProgressTime = Date.now();

    for (const file of this.files) {
      await this.sendFile(file);
    }

    this.webrtc.sendJSON({ type: 'transfer_complete' } as TransferCompleteMessage);
    this.setStatus('completed');
    this.emit({ type: 'transfer_complete' });
  }

  private async sendFile(file: File): Promise<void> {
    const metadata = this.chunkManager.createMetadata(file);
    const shouldCompress = this.options.enableCompression &&
      CompressionService.isSupported() &&
      this.compression.shouldCompress(file.size);

    const metadataMsg: FileMetadataMessage = {
      type: 'file_metadata',
      metadata,
      compressed: shouldCompress,
      encrypted: this.options.enableEncryption,
    };
    this.webrtc.sendJSON(metadataMsg);

    await new Promise(resolve => setTimeout(resolve, 100));

    for await (const chunk of this.chunkManager.split(file)) {
      let data = chunk.data;

      if (shouldCompress) {
        data = await this.compression.compress(data);
      }

      const serialized = ChunkManager.serializeChunk({ ...chunk, data });
      this.webrtc.send(serialized);

      this.bytesTransferred += chunk.size;
      this.updateProgress();

      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }

  private handleReceivedData(data: Uint8Array | string): void {
    if (typeof data === 'string') {
      this.tryDispatchJsonMessage(data);
      return;
    }

    // Binary data may be a JSON control message or a chunk
    const text = new TextDecoder().decode(data);
    if (this.tryDispatchJsonMessage(text)) {
      return;
    }

    this.handleChunkData(data).catch((err) => {
      this.setStatus('error');
      this.emit({ type: 'error', data: { message: err?.message || 'Chunk processing failed' } });
    });
  }

  /** Attempt to parse JSON and dispatch a control message. Returns true if handled. */
  private tryDispatchJsonMessage(text: string): boolean {
    try {
      const message = JSON.parse(text);
      if (message.type === 'file_metadata') {
        this.handleFileMetadata(message as FileMetadataMessage);
        return true;
      }
      if (message.type === 'transfer_complete') {
        this.handleTransferComplete();
        return true;
      }
    } catch {
      // Not valid JSON -- caller decides what to do next
    }
    return false;
  }

  private handleFileMetadata(message: FileMetadataMessage): void {
    this.chunkManager.reset();
    this.chunkManager.setMetadata(message.metadata);
    this.isCurrentFileCompressed = message.compressed;
    this.totalBytes = message.metadata.totalSize;
    this.bytesTransferred = 0;
    this._transferStartTime = Date.now();
    this.lastProgressTime = Date.now();
  }

  private async handleChunkData(data: Uint8Array): Promise<void> {
    const chunk = ChunkManager.deserializeChunk(data);

    if (this.isCurrentFileCompressed) {
      chunk.data = await this.compression.decompress(chunk.data);
    }

    this.chunkManager.addChunk(chunk);
    this.bytesTransferred += chunk.size;
    this.updateProgress();

    if (this.chunkManager.isComplete()) {
      const file = this.chunkManager.toFile();
      this.emit({ type: 'file_received', data: file });
    }
  }

  private handleTransferComplete(): void {
    this.setStatus('completed');
    this.emit({ type: 'transfer_complete' });
  }

  private updateProgress(): void {
    const now = Date.now();
    if (now - this.lastProgressTime >= 100) { // Update every 100ms
      this.emit({ type: 'progress', data: this.currentProgress });
      this.lastBytesTransferred = this.bytesTransferred;
      this.lastProgressTime = now;
    }
  }

  private setStatus(status: TransferStatus): void {
    this.status = status;
    this.emit({ type: 'status_change', data: { status } });
  }

  on(event: TransferEventType, handler: TransferEventHandler): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);

    return () => {
      this.eventHandlers.get(event)?.delete(handler);
    };
  }

  private emit(event: TransferEvent): void {
    this.eventHandlers.get(event.type)?.forEach(handler => handler(event));
  }

  cancel(): void {
    this.setStatus('cancelled');
    this.cleanup();
  }

  cleanup(): void {
    this.cleanupFunctions.forEach(fn => fn());
    this.cleanupFunctions = [];
    this.webrtc.destroy();
    this.signaling.disconnect();
    this.chunkManager.reset();
    this.eventHandlers.clear();
    this.webrtcCreated = false;
  }

  getReceivedFile(): File | null {
    if (this.chunkManager.isComplete()) {
      return this.chunkManager.toFile();
    }
    return null;
  }
}
