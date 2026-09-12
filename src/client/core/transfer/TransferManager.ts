import { SignalingClient } from '../connection/SignalingClient';
import { WebRTCConnection } from '../connection/WebRTCConnection';
import { ChunkManager, MAX_TRANSFER_BYTES, type ChunkMetadata } from './ChunkManager';
import { CompressionService } from './CompressionService';
import { generateCode } from '../../utils/codeGenerator';
import { sanitizeFileName } from '../../utils/validators';

/**
 * 転送プロトコルのバージョン。受信側が能力を通知しない、または別バージョンを
 * 名乗る場合は互換性がないものとして明示的に失敗させる。
 */
export const PROTOCOL_VERSION = 2;

/** 接続後、receiver_capabilities を待つ時間 */
export const CAPABILITY_TIMEOUT_MS = 5000;

export const INCOMPATIBLE_RECEIVER_MESSAGE = 'Receiver is running an incompatible version';

/**
 * 最後のチャンクを送り終えてから file_ack を待つ時間の基準値。
 * 受信側は ACK の前に検証・解凍・File 化を行うので、ファイルサイズに比例した
 * 猶予を上乗せする（下記 ACK_TIMEOUT_MS_PER_BYTE）。
 */
export const ACK_TIMEOUT_BASE_MS = 10_000;

/** サイズに比例して伸ばす分。10 MiB あたり 1 秒。 */
export const ACK_TIMEOUT_MS_PER_BYTE = 1000 / (10 * 1024 * 1024);

/** どれだけ大きなファイルでもこれ以上は待たない。 */
export const ACK_TIMEOUT_MAX_MS = 120_000;

/** ファイルサイズから ACK 待ちのタイムアウト（ms）を求める。 */
export function ackTimeoutMs(fileSize: number): number {
  const size = Number.isFinite(fileSize) && fileSize > 0 ? fileSize : 0;
  return Math.min(
    ACK_TIMEOUT_BASE_MS + Math.ceil(size * ACK_TIMEOUT_MS_PER_BYTE),
    ACK_TIMEOUT_MAX_MS
  );
}

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

export interface ReceiverCapabilities {
  protocolVersion: number;
  supportsDecompression: boolean;
  maxTransferBytes: number;
}

interface ReceiverCapabilitiesMessage extends ReceiverCapabilities {
  type: 'receiver_capabilities';
}

interface FileMetadataMessage {
  type: 'file_metadata';
  fileIndex: number;
  metadata: ChunkMetadata;
  compressed: boolean;
}

interface FileAckMessage {
  type: 'file_ack';
  fileIndex: number;
  fileName: string;
  size: number;
}

interface TransferErrorMessage {
  type: 'transfer_error';
  message: string;
}

interface TransferCompleteMessage {
  type: 'transfer_complete';
}

type ControlMessage = { type: string } & Record<string, unknown>;

/**
 * 制御メッセージとして解釈できれば返す。JSON でない、あるいは type を持たない
 * 場合は null（呼び出し側でチャンクとして扱う）。
 */
function parseControlMessage(text: string): ControlMessage | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
      return parsed as ControlMessage;
    }
  } catch {
    // Not valid JSON -- caller decides what to do next
  }
  return null;
}

/** タイマー付きの待機。cancel / cleanup / 切断 / エラーで必ず解放する。 */
interface PendingWaiter<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * ACK 待ちのハンドル。登録（= ACK を取りこぼさない）とタイムアウト開始を
 * 分けているのは、大きなファイルの送信時間そのものをタイムアウトに
 * 含めないため。最後のチャンクを送信バッファに積んでから armTimeout() を呼ぶ。
 */
interface AckHandle {
  received: Promise<void>;
  armTimeout: () => void;
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
  /** データチャネルが開いているか。シグナリング切断の扱いをこれで切り替える。 */
  private webrtcConnected = false;
  /** 転送開始（送信ループ / 能力通知）を 1 回に限定するためのフラグ。 */
  private transferStarted = false;
  private isCurrentFileCompressed = false;

  // --- 送信側: 能力交換と ACK 待ち ---
  private receiverCapabilities: ReceiverCapabilities | null = null;
  private capabilityWaiter: PendingWaiter<ReceiverCapabilities> | null = null;
  private ackWaiter: (PendingWaiter<void> & { fileIndex: number }) | null = null;
  // 送信ループのキャンセル。バッファ空き待ちに渡し、rejectPendingWaiters から
  // abort することで待機中のループを即座に解放する。送信中のみ非 null。
  private sendAbort: AbortController | null = null;

  // --- 受信側: ファイル単位の進行状況 ---
  private currentFileIndex: number | null = null;
  private announcedFiles: Set<number> = new Set();
  private ackedFiles: Set<number> = new Set();
  private receivedTotalSize = 0;

  // Received messages are processed one at a time, in arrival order. Control
  // messages (file_metadata / transfer_complete) are async-serialized together
  // with chunks so a later message can never overtake a pending decompression.
  private receiveQueue: Promise<void> = Promise.resolve();
  // Bumped on cancel/cleanup so queued or in-flight work from a previous
  // lifetime cannot mutate state or emit events afterwards.
  private receiveGeneration = 0;
  // Set once the queue hits an error, so only one error event is emitted and
  // everything arriving after it is ignored.
  private receiveFailed = false;

  constructor(options: TransferOptions = {}) {
    this.options = {
      enableCompression: options.enableCompression ?? true,
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

    const code = generateCode();
    this._roomId = code;

    try {
      await this.signaling.connect(code);
      this.setupSignalingHandlers();
      this.signaling.generateCode();
    } catch (error) {
      this.failInitialization(error, 'Could not start receiving. Check your connection and try again.');
      throw error;
    }

    this.setStatus('waiting');
    return code;
  }

  async initializeAsSender(code: string, files: File[]): Promise<void> {
    this.role = 'sender';
    this.files = files;
    this._roomId = code;
    this.totalBytes = files.reduce((sum, f) => sum + f.size, 0);

    this.setStatus('connecting');

    try {
      await this.signaling.connect(code);
      this.setupSignalingHandlers();
      this.signaling.joinRoom(code, 'sender');
    } catch (error) {
      this.failInitialization(error, 'Could not start the transfer. Check your connection and try again.');
      throw error;
    }
  }

  /**
   * 初期化に失敗したときの後始末。connecting のまま止まって UI が
   * 「Connecting...」を出し続けるのを防ぐため、必ず error を表に出す。
   * cleanup() はイベントハンドラも消すので、通知を済ませてから呼ぶ。
   */
  private failInitialization(error: unknown, fallbackMessage: string): void {
    const message =
      error instanceof Error && error.message.length > 0 ? error.message : fallbackMessage;

    this.rejectPendingWaiters(new Error(message));
    this.setStatus('error');
    this.emit({ type: 'error', data: { message } });
    // cleanup() は status を触らないので error のまま残る。
    this.cleanup();
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
      if (this.role !== 'sender') return;
      if (this.isFromUnknownPeer(event.data?.fromPeerId)) return;

      if (event.data.fromPeerId) {
        this.targetPeerId = event.data.fromPeerId;
      }
      if (!this.webrtcCreated) {
        this.webrtc.create({ initiator: false });
        this.setupWebRTCHandlers();
        this.webrtcCreated = true;
      }
      this.webrtc.signal(JSON.parse(event.data.sdp));
    });

    const cleanup3 = this.signaling.on('webrtc_answer', (event) => {
      if (this.role !== 'receiver') return;
      if (this.isFromUnknownPeer(event.data?.fromPeerId)) return;

      this.webrtc.signal(JSON.parse(event.data.sdp));
    });

    const cleanup4 = this.signaling.on('ice_candidate', (event) => {
      if (this.isFromUnknownPeer(event.data?.fromPeerId)) return;

      if (!this.targetPeerId && event.data.fromPeerId) {
        this.targetPeerId = event.data.fromPeerId;
      }
      this.webrtc.signal(JSON.parse(event.data.candidate));
    });

    const cleanup5 = this.signaling.on('error', (event) => {
      // サーバからの PEER_DISCONNECTED もここに来る。相手の「シグナリング」が
      // 落ちただけなので、データチャネルが開いた後なら転送には関係ない。
      this.handleSignalingFailure('Signaling error', event.data);
    });

    const cleanup6 = this.signaling.on('disconnected', () => {
      this.handleSignalingFailure(
        'Lost the connection to the signaling server before pairing finished. Please try again.'
      );
    });

    const cleanup7 = this.signaling.on('reconnected', () => {
      // 再接続しても部屋への再登録はしない（理由は handleSignalingFailure 参照）。
      console.warn('[flux] Signaling reconnected, but the room registration is gone.');
    });

    this.cleanupFunctions.push(
      cleanup1,
      cleanup2,
      cleanup3,
      cleanup4,
      cleanup5,
      cleanup6,
      cleanup7
    );
  }

  /**
   * 相手として確定済みの peer 以外から届いたシグナリングは無視する。
   * サーバ側でも中継先を検証しているが、クライアントでも同じ前提を確認する。
   * 不正扱いでエラーにはせず、単に捨てる。
   */
  private isFromUnknownPeer(fromPeerId: unknown): boolean {
    return (
      typeof fromPeerId === 'string' &&
      fromPeerId.length > 0 &&
      this.targetPeerId !== null &&
      fromPeerId !== this.targetPeerId
    );
  }

  /**
   * シグナリングの切断・エラーの扱いはフェーズで変わる。
   *
   * - データチャネルが開く前（ペアリング中）: 致命的として扱う。サーバは
   *   onClose で peer を削除し相手にも PEER_DISCONNECTED を送っているので、
   *   同じ部屋に戻る手段がない。receiver は generate_code で新しいコードしか
   *   取れず、sender が join_room し直しても receiver 側は既に
   *   RTCPeerConnection を作っている（webrtcCreated ガード）ため 2 度目の
   *   offer を作らず、古い ICE のまま噛み合わない。そのため再登録は試みず、
   *   ペアリング失敗としてユーザーにやり直してもらう。
   * - データチャネルが開いた後: 転送自体はシグナリングを使わない。相手の
   *   シグナリングが落ちて届く PEER_DISCONNECTED も含めて無視し、転送の
   *   成否は WebRTC 側の disconnected / error だけで決める。
   *   （ソケットを能動的に閉じないのは、接続確立後も trickle ICE が
   *   続く可能性があるため。）
   */
  private handleSignalingFailure(fallbackMessage: string, data?: { message?: string }): void {
    if (this.webrtcConnected) {
      console.warn('[flux] Ignoring signaling failure after the data channel opened.');
      return;
    }

    const message =
      typeof data?.message === 'string' && data.message.length > 0 ? data.message : fallbackMessage;

    this.rejectPendingWaiters(new Error(message));
    this.failTransfer(message);
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

    // Data is encrypted in transit by WebRTC's DTLS layer; no app-level
    // key exchange is performed. Once the data channel is open we can
    // transfer immediately.
    const cleanup2 = this.webrtc.on('connected', () => {
      this.webrtcConnected = true;

      // connected が複数回届いても転送の開始は 1 度だけ。
      if (this.transferStarted) return;
      this.transferStarted = true;

      if (this.role === 'sender') {
        this.startSending().catch((err: unknown) => {
          this.failTransfer(err instanceof Error ? err.message : 'Transfer failed');
        });
      } else {
        this.setStatus('transferring');
        this.sendCapabilities();
      }
    });

    const cleanup3 = this.webrtc.on('data', (event) => {
      this.handleReceivedData(event.data as Uint8Array | string);
    });

    const cleanup4 = this.webrtc.on('error', (event) => {
      this.webrtcConnected = false;
      this.rejectPendingWaiters(new Error('Connection error'));
      this.setStatus('error');
      this.emit({ type: 'error', data: event.data });
    });

    const cleanup5 = this.webrtc.on('disconnected', () => {
      this.webrtcConnected = false;
      this.rejectPendingWaiters(new Error('Connection lost'));
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

    const abort = new AbortController();
    this.sendAbort = abort;

    try {
      // 受信側の能力が分かるまでは 1 バイトも送らない。旧クライアントは
      // capabilities を送らないので、ここでタイムアウトして明示的に失敗する。
      const capabilities = await this.waitForCapabilities();

      if (this.totalBytes > capabilities.maxTransferBytes) {
        throw new Error(
          `Receiver accepts at most ${capabilities.maxTransferBytes} bytes, but the transfer is ${this.totalBytes} bytes`
        );
      }

      for (let fileIndex = 0; fileIndex < this.files.length; fileIndex++) {
        await this.sendFile(this.files[fileIndex], fileIndex, capabilities, abort.signal);
      }

      this.throwIfSendAborted(abort.signal);

      this.webrtc.sendJSON({ type: 'transfer_complete' } as TransferCompleteMessage);
      this.setStatus('completed');
      this.emit({ type: 'transfer_complete' });
    } finally {
      if (this.sendAbort === abort) {
        this.sendAbort = null;
      }
    }
  }

  /** 送信が中断されていれば例外を投げる。待機を挟むたびに確認する。 */
  private throwIfSendAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error('Transfer stopped');
  }

  private async sendFile(
    file: File,
    fileIndex: number,
    capabilities: ReceiverCapabilities,
    signal: AbortSignal
  ): Promise<void> {
    const metadata = this.chunkManager.createMetadata(file);
    // 圧縮は双方が対応している場合にのみ使う。受信側が解凍できない環境なら
    // 圧縮せずに送る（送信側の環境だけで決めない）。
    const shouldCompress = this.options.enableCompression &&
      CompressionService.isSupported() &&
      capabilities.supportsDecompression &&
      this.compression.shouldCompress(file.size);

    // ACK は最後のチャンクの直後に届き得るので、送信前に待機を登録しておく。
    // タイムアウトは全チャンクを積み終えてから開始する（下の armTimeout）。
    const ack = this.waitForAck(fileIndex, file.name, file.size);
    // 送信中に reject されても unhandled rejection にしない（下で await する）。
    ack.received.catch(() => {});

    const metadataMsg: FileMetadataMessage = {
      type: 'file_metadata',
      fileIndex,
      metadata,
      compressed: shouldCompress,
    };
    // データチャネルは順序保証があり、受信側の処理も直列化されているので、
    // metadata の後に固定時間待つ必要はない。
    this.webrtc.sendJSON(metadataMsg);

    for await (const chunk of this.chunkManager.split(file)) {
      let data = chunk.data;

      if (shouldCompress) {
        data = await this.compression.compress(data);
      }

      // 読み込み・圧縮を待っている間にキャンセルや切断が起きている可能性がある。
      // 壊れた接続に次のチャンクを流し込まないよう、送信前に必ず確認する。
      this.throwIfSendAborted(signal);

      const serialized = ChunkManager.serializeChunk({ ...chunk, data });
      // 送信バッファが高水位を下回るまで待ってから積む（固定 sleep ではなく
      // 実際のドレインに追従させる）。cancel / 切断時は待機ごと reject される。
      await this.webrtc.sendWithBackpressure(serialized, signal);

      this.bytesTransferred += chunk.size;
      this.updateProgress();
    }

    // 全チャンクを送信バッファに渡し終えた。ここから受信側の検証・解凍・
    // File 化にかかる時間を見込んでタイムアウトを計り始める。
    ack.armTimeout();

    // 受信側の検証が通るまで次のファイルへ進まない。
    await ack.received;
  }

  private waitForCapabilities(): Promise<ReceiverCapabilities> {
    if (this.receiverCapabilities) {
      return Promise.resolve(this.receiverCapabilities);
    }

    return new Promise<ReceiverCapabilities>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.capabilityWaiter = null;
        reject(new Error(INCOMPATIBLE_RECEIVER_MESSAGE));
      }, CAPABILITY_TIMEOUT_MS);

      this.capabilityWaiter = { resolve, reject, timer };
    });
  }

  /**
   * file_ack を待つ。タイムアウトは armTimeout() が呼ばれてから計り始める
   * （登録時から計ると、大きなファイルの送信時間だけで期限切れになる）。
   */
  private waitForAck(fileIndex: number, fileName: string, fileSize: number): AckHandle {
    let armTimeout = (): void => {};

    const received = new Promise<void>((resolve, reject) => {
      const waiter: PendingWaiter<void> & { fileIndex: number } = {
        fileIndex,
        resolve,
        reject,
        timer: null,
      };
      this.ackWaiter = waiter;

      armTimeout = (): void => {
        // すでに ACK が届いた / 解放された、あるいは二重に呼ばれた場合は何もしない。
        if (this.ackWaiter !== waiter || waiter.timer !== null) return;

        waiter.timer = setTimeout(() => {
          this.ackWaiter = null;
          reject(new Error(`Receiver did not acknowledge ${fileName} in time`));
        }, ackTimeoutMs(fileSize));
      };
    });

    return { received, armTimeout };
  }

  /**
   * 待機中の Promise を全て reject する。待機が永久に残らないよう、
   * cancel / cleanup / 切断 / エラー / 受信側エラーの全経路から呼ぶ。
   * 何かを reject した場合に true を返す。
   */
  private rejectPendingWaiters(reason: Error): boolean {
    let rejected = false;

    // 送信ループ（バッファ空き待ち・圧縮待ち）を解放する。abort すると
    // 待機が reject され、ループは sendFile から例外として抜ける。
    if (this.sendAbort && !this.sendAbort.signal.aborted) {
      this.sendAbort.abort(reason);
      rejected = true;
    }

    if (this.capabilityWaiter) {
      const waiter = this.capabilityWaiter;
      this.capabilityWaiter = null;
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      waiter.reject(reason);
      rejected = true;
    }

    if (this.ackWaiter) {
      const waiter = this.ackWaiter;
      this.ackWaiter = null;
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      waiter.reject(reason);
      rejected = true;
    }

    return rejected;
  }

  /** 送信側の転送失敗。すでに終了状態なら二重に報告しない。 */
  private failTransfer(message: string): void {
    if (this.status === 'cancelled' || this.status === 'completed' || this.status === 'error') {
      return;
    }
    this.setStatus('error');
    this.emit({ type: 'error', data: { message } });
  }

  private sendCapabilities(): void {
    const message: ReceiverCapabilitiesMessage = {
      type: 'receiver_capabilities',
      protocolVersion: PROTOCOL_VERSION,
      supportsDecompression: CompressionService.isSupported(),
      maxTransferBytes: MAX_TRANSFER_BYTES,
    };
    this.webrtc.sendJSON(message);
  }

  private handleReceiverCapabilities(message: ReceiverCapabilitiesMessage): void {
    if (this.role !== 'sender') return;

    const capabilities: ReceiverCapabilities = {
      protocolVersion: message.protocolVersion,
      supportsDecompression: message.supportsDecompression === true,
      maxTransferBytes:
        typeof message.maxTransferBytes === 'number' && message.maxTransferBytes >= 0
          ? message.maxTransferBytes
          : 0,
    };

    if (capabilities.protocolVersion !== PROTOCOL_VERSION) {
      const waiter = this.capabilityWaiter;
      this.capabilityWaiter = null;
      if (waiter) {
        if (waiter.timer !== null) clearTimeout(waiter.timer);
        waiter.reject(new Error(INCOMPATIBLE_RECEIVER_MESSAGE));
      } else {
        this.failTransfer(INCOMPATIBLE_RECEIVER_MESSAGE);
      }
      return;
    }

    this.receiverCapabilities = capabilities;

    const waiter = this.capabilityWaiter;
    this.capabilityWaiter = null;
    if (waiter) {
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      waiter.resolve(capabilities);
    }
  }

  private handleFileAck(message: FileAckMessage): void {
    if (this.role !== 'sender') return;

    const waiter = this.ackWaiter;
    if (!waiter) return;

    if (message.fileIndex !== waiter.fileIndex) {
      this.ackWaiter = null;
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      waiter.reject(
        new Error(`Unexpected ack for file ${message.fileIndex}, expected ${waiter.fileIndex}`)
      );
      return;
    }

    this.ackWaiter = null;
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    waiter.resolve();
  }

  /** 受信側が報告したエラー。送信側は成功表示せず error にする。 */
  private handleTransferError(message: TransferErrorMessage): void {
    if (this.role !== 'sender') return;

    const text = typeof message.message === 'string' && message.message.length > 0
      ? message.message
      : 'Receiver reported a transfer error';

    // 待機中なら startSending 側の catch で status / event を出す。
    if (this.rejectPendingWaiters(new Error(text))) return;

    this.failTransfer(text);
  }

  private handleReceivedData(data: Uint8Array | string): void {
    const generation = this.receiveGeneration;

    this.receiveQueue = this.receiveQueue
      .then(() => {
        if (this.isReceiveStale(generation)) return;
        return this.processReceivedData(data, generation);
      })
      .catch((err) => {
        if (this.isReceiveStale(generation)) return;
        this.receiveFailed = true;
        const message = err?.message || 'Chunk processing failed';
        // 受信側で失敗したことを送信側にも伝える。伝えないと送信側は
        // 全チャンク送信後に成功として完了してしまう。
        this.reportErrorToSender(message);
        this.setStatus('error');
        this.emit({ type: 'error', data: { message } });
      });
  }

  /**
   * True once this receive pipeline has been torn down (cancel/cleanup) or has
   * already reported an error. Checked before every state mutation or event
   * emission, including after each await.
   */
  private isReceiveStale(generation: number): boolean {
    return this.receiveFailed || generation !== this.receiveGeneration;
  }

  private async processReceivedData(data: Uint8Array | string, generation: number): Promise<void> {
    if (typeof data === 'string') {
      this.dispatchControlMessage(parseControlMessage(data));
      return;
    }

    // Binary data may be a JSON control message or a chunk
    const text = new TextDecoder().decode(data);
    if (this.dispatchControlMessage(parseControlMessage(text))) {
      return;
    }

    await this.handleChunkData(data, generation);
  }

  /**
   * 制御メッセージをディスパッチする。処理した場合に true を返す。
   * ハンドラが投げた例外は受信キューの catch まで伝播させる（握り潰さない）。
   */
  private dispatchControlMessage(message: ControlMessage | null): boolean {
    if (!message) return false;

    switch (message.type) {
      case 'receiver_capabilities':
        this.handleReceiverCapabilities(message as unknown as ReceiverCapabilitiesMessage);
        return true;
      case 'file_ack':
        this.handleFileAck(message as unknown as FileAckMessage);
        return true;
      case 'transfer_error':
        this.handleTransferError(message as unknown as TransferErrorMessage);
        return true;
      case 'file_metadata':
        this.handleFileMetadata(message as unknown as FileMetadataMessage);
        return true;
      case 'transfer_complete':
        this.handleTransferComplete();
        return true;
      default:
        return false;
    }
  }

  private handleFileMetadata(message: FileMetadataMessage): void {
    if (this.role !== 'receiver') return;

    // 圧縮を解けない環境では、破損したファイルを成功として扱わず明示的に失敗する。
    if (message.compressed === true && !CompressionService.isSupported()) {
      throw new Error(
        'Received compressed data but this browser cannot decompress it (DecompressionStream is unavailable)'
      );
    }

    if (!Number.isInteger(message.fileIndex) || message.fileIndex < 0) {
      throw new Error(`Invalid file index: ${message.fileIndex}`);
    }

    if (this.announcedFiles.has(message.fileIndex)) {
      throw new Error(`Duplicate metadata for file ${message.fileIndex}`);
    }

    // 前のファイルが未完了のまま次の metadata が来るのはプロトコル違反。
    const previous = this.chunkManager.getMetadata();
    if (previous && !this.chunkManager.isComplete()) {
      throw new Error(`Metadata for file ${message.fileIndex} arrived before the previous file completed`);
    }

    if (!message.metadata || typeof message.metadata !== 'object') {
      throw new Error('Invalid metadata: not an object');
    }

    // The file name comes from the (untrusted) sender, so sanitize it at the
    // trust boundary before it flows to the File object, the UI, or disk.
    const metadata: ChunkMetadata = {
      ...message.metadata,
      fileName: sanitizeFileName(message.metadata.fileName),
    };

    // 転送全体の合計にも上限を効かせる（1 ファイルずつ小さくても総量は制限する）。
    const nextTotal = this.receivedTotalSize + (metadata.totalSize ?? 0);
    if (nextTotal > MAX_TRANSFER_BYTES) {
      throw new Error(
        `Transfer exceeds the receive limit of ${MAX_TRANSFER_BYTES} bytes`
      );
    }

    this.chunkManager.reset();
    this.chunkManager.setMetadata(metadata);
    this.receivedTotalSize = nextTotal;
    this.announcedFiles.add(message.fileIndex);
    this.currentFileIndex = message.fileIndex;
    this.isCurrentFileCompressed = message.compressed === true;
    this.totalBytes = metadata.totalSize;
    this.bytesTransferred = 0;
    this._transferStartTime = Date.now();
    this.lastProgressTime = Date.now();
  }

  private async handleChunkData(data: Uint8Array, generation: number): Promise<void> {
    const chunk = ChunkManager.deserializeChunk(data);

    if (this.isCurrentFileCompressed) {
      chunk.data = await this.compression.decompress(chunk.data);
      // The pipeline may have been torn down while decompression was pending.
      if (this.isReceiveStale(generation)) return;

      // 解凍結果が宣言サイズと違うなら、そのまま結合せず失敗させる。
      if (chunk.data.byteLength !== chunk.size) {
        throw new Error(
          `Chunk ${chunk.index} size mismatch after decompression: declared ${chunk.size} bytes, got ${chunk.data.byteLength} bytes`
        );
      }
    }

    this.chunkManager.addChunk(chunk);
    this.bytesTransferred += chunk.size;
    this.updateProgress();

    if (this.chunkManager.isComplete()) {
      const file = this.chunkManager.toFile();
      const fileName = file.name;
      const fileSize = file.size;

      // メモリ対策: Blob がすでにバイト列を保持しているので、チャンク Map は
      // ここで手放す。残しておくとファイル 1 個ぶんのバイト列を JS ヒープ側にも
      // 二重に抱えたまま、次の metadata か cleanup まで解放されない。
      // reset 後は getMetadata() が null になるため、handleFileMetadata の
      // 「前のファイルが未完了」判定（previous && !isComplete()）は素通りし、
      // 次のファイルの metadata は従来どおり受け付けられる。
      this.chunkManager.reset();

      const fileIndex = this.currentFileIndex ?? 0;
      this.ackedFiles.add(fileIndex);
      this.webrtc.sendJSON({
        type: 'file_ack',
        fileIndex,
        fileName,
        size: fileSize,
      } as FileAckMessage);
      this.emit({ type: 'file_received', data: file });
    }
  }

  private handleTransferComplete(): void {
    // 完了宣言は送信側だけが出す。送信側は自分の ACK 集計で完了を決めるので、
    // 相手からの transfer_complete では成功にしない。
    if (this.role !== 'receiver') return;

    const unfinished = [...this.announcedFiles].filter(index => !this.ackedFiles.has(index));
    if (unfinished.length > 0) {
      throw new Error(`Transfer ended with unfinished files: ${unfinished.join(', ')}`);
    }

    this.setStatus('completed');
    this.emit({ type: 'transfer_complete' });
  }

  /** 受信側の失敗を送信側に伝える。チャネルが閉じていても投げない。 */
  private reportErrorToSender(message: string): void {
    if (this.role !== 'receiver') return;
    try {
      this.webrtc.sendJSON({ type: 'transfer_error', message } as TransferErrorMessage);
    } catch {
      // 送れなければ諦める。受信側の error 通知は別途発火する。
    }
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
    // Invalidate queued and in-flight receive work before tearing anything down.
    this.receiveGeneration++;
    this.receiveQueue = Promise.resolve();
    this.receiveFailed = false;

    // 能力待ち・ACK 待ちを解放する（残すと送信側が永久に待つ）。
    this.rejectPendingWaiters(new Error('Transfer stopped'));
    this.receiverCapabilities = null;
    this.currentFileIndex = null;
    this.announcedFiles.clear();
    this.ackedFiles.clear();
    this.receivedTotalSize = 0;

    this.cleanupFunctions.forEach(fn => fn());
    this.cleanupFunctions = [];
    this.webrtc.destroy();
    this.signaling.disconnect();
    this.chunkManager.reset();
    this.eventHandlers.clear();
    this.webrtcCreated = false;
    this.webrtcConnected = false;
    this.transferStarted = false;
    this.targetPeerId = null;
  }
}
