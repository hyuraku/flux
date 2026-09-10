export type WebRTCEventType =
  | 'connected'
  | 'disconnected'
  | 'data'
  | 'error'
  | 'signal';

export interface WebRTCEvent {
  type: WebRTCEventType;
  data?: unknown;
}

export type WebRTCEventHandler = (event: WebRTCEvent) => void;

export interface WebRTCConfig {
  initiator: boolean;
  trickle?: boolean;
  config?: RTCConfiguration;
}

export interface SignalData {
  type: 'offer' | 'answer' | 'candidate';
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

const DATA_CHANNEL_LABEL = 'flux-transfer';

/**
 * 送信バッファの低水位。bufferedAmount がここまで減ると
 * bufferedamountlow が発火し、送信を再開できる。
 */
export const BUFFERED_AMOUNT_LOW_WATERMARK = 256 * 1024; // 256KiB

/**
 * 送信バッファの高水位。これ以上積まれている間は新しいチャンクを積まず、
 * バッファが空くまで待つ（遅い回線でバッファが無限に膨らむのを防ぐ）。
 */
export const BUFFERED_AMOUNT_HIGH_WATERMARK = 1024 * 1024; // 1MiB

/** モックや未実装環境で bufferedAmount が数値でない場合も安全に扱う。 */
function bufferedAmountOf(channel: RTCDataChannel): number {
  const amount = channel.bufferedAmount;
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
}

/** AbortSignal の reason を Error に正規化する。 */
function abortReasonToError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string' && reason.length > 0) return new Error(reason);
  return new Error('Send aborted');
}

export class WebRTCConnection {
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private eventHandlers: Map<WebRTCEventType, Set<WebRTCEventHandler>> = new Map();
  private _isConnected = false;
  private _isInitiator = false;
  private _trickle = true;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private maxBufferSize = 16 * 1024 * 1024; // 16MB buffer limit
  // バッファ空き待ちの待機者。チャネルの close / error と destroy から
  // 必ず解放するので、待機が永久に残ることはない。
  private bufferWaiters: Set<(reason: Error) => void> = new Set();

  get isConnected(): boolean {
    return this._isConnected;
  }

  create(config: WebRTCConfig): void {
    const iceServers = config.config?.iceServers || DEFAULT_ICE_SERVERS;
    this._isInitiator = config.initiator;
    this._trickle = config.trickle ?? true;

    // Create RTCPeerConnection
    this.pc = new RTCPeerConnection({
      iceServers,
      ...config.config,
    });

    // Handle ICE candidates
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        if (this._trickle) {
          // Trickle ICE: send each candidate as it's discovered
          this.emit({
            type: 'signal',
            data: {
              type: 'candidate',
              candidate: event.candidate.toJSON(),
            },
          });
        }
      } else {
        // ICE gathering complete
        if (!this._trickle && this.pc?.localDescription) {
          // Non-trickle: send complete SDP with all candidates
          this.emit({
            type: 'signal',
            data: {
              type: this.pc.localDescription.type as 'offer' | 'answer',
              sdp: this.pc.localDescription.sdp,
            },
          });
        }
      }
    };

    // Handle connection state changes
    // Note: We don't emit 'connected' here because the data channel may not be open yet
    // The 'connected' event is only emitted from dataChannel.onopen
    this.pc.onconnectionstatechange = () => {
      switch (this.pc?.connectionState) {
        case 'disconnected':
        case 'closed':
          this._isConnected = false;
          this.emit({ type: 'disconnected' });
          break;
        case 'failed':
          this._isConnected = false;
          this.emit({ type: 'error', data: new Error('Connection failed') });
          break;
      }
    };

    // Handle ICE connection state
    this.pc.oniceconnectionstatechange = () => {
      if (this.pc?.iceConnectionState === 'failed') {
        this.emit({ type: 'error', data: new Error('ICE connection failed') });
      }
    };

    if (this._isInitiator) {
      // Initiator creates the data channel
      this.setupDataChannel(this.pc.createDataChannel(DATA_CHANNEL_LABEL, {
        ordered: true,
      }));

      // Create and send offer
      this.createOffer();
    } else {
      // Non-initiator waits for data channel
      this.pc.ondatachannel = (event) => {
        this.setupDataChannel(event.channel);
      };
    }
  }

  private setupDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;
    this.dataChannel.binaryType = 'arraybuffer';
    // 低水位を設定しておくと、bufferedAmount がここまで減ったときだけ
    // bufferedamountlow が発火する（ポーリング不要で送信を再開できる）。
    this.dataChannel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_WATERMARK;

    this.dataChannel.onopen = () => {
      this._isConnected = true;
      this.emit({ type: 'connected' });
    };

    this.dataChannel.onclose = () => {
      this._isConnected = false;
      this.rejectBufferWaiters(new Error('Data channel closed'));
      this.emit({ type: 'disconnected' });
    };

    this.dataChannel.onerror = (event) => {
      this._isConnected = false;
      const errorEvent = event as RTCErrorEvent;
      const error = errorEvent.error || new Error('DataChannel error');
      this.rejectBufferWaiters(error);
      this.emit({
        type: 'error',
        data: error,
      });
    };

    this.dataChannel.onmessage = (event) => {
      const data = event.data instanceof ArrayBuffer
        ? new Uint8Array(event.data)
        : event.data;
      this.emit({ type: 'data', data });
    };
  }

  private async createOffer(): Promise<void> {
    if (!this.pc) return;

    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      if (this._trickle) {
        // Trickle: send offer immediately
        this.emit({
          type: 'signal',
          data: {
            type: 'offer',
            sdp: offer.sdp,
          },
        });
      }
      // Non-trickle: wait for ICE gathering complete (handled in onicecandidate)
    } catch (error) {
      this.emit({ type: 'error', data: error });
    }
  }

  private async createAnswer(): Promise<void> {
    if (!this.pc) return;

    try {
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);

      if (this._trickle) {
        // Trickle: send answer immediately
        this.emit({
          type: 'signal',
          data: {
            type: 'answer',
            sdp: answer.sdp,
          },
        });
      }
      // Non-trickle: wait for ICE gathering complete (handled in onicecandidate)
    } catch (error) {
      this.emit({ type: 'error', data: error });
    }
  }

  private async addPendingCandidates(): Promise<void> {
    if (!this.pc) return;

    for (const candidate of this.pendingCandidates) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.warn('Failed to add ICE candidate:', error);
      }
    }
    this.pendingCandidates = [];
  }

  async signal(data: SignalData): Promise<void> {
    if (!this.pc) {
      throw new Error('Peer not created');
    }

    try {
      if (data.type === 'offer') {
        // Received offer - set remote description and create answer
        await this.pc.setRemoteDescription(new RTCSessionDescription({
          type: 'offer',
          sdp: data.sdp,
        }));
        await this.addPendingCandidates();
        await this.createAnswer();
      } else if (data.type === 'answer') {
        // Received answer - set remote description
        await this.pc.setRemoteDescription(new RTCSessionDescription({
          type: 'answer',
          sdp: data.sdp,
        }));
        await this.addPendingCandidates();
      } else if (data.type === 'candidate' && data.candidate) {
        // Received ICE candidate
        if (this.pc.remoteDescription) {
          await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } else {
          // Queue candidate until remote description is set
          this.pendingCandidates.push(data.candidate);
        }
      }
    } catch (error) {
      this.emit({ type: 'error', data: error });
    }
  }

  send(data: ArrayBuffer | Uint8Array | string): void {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Peer not connected');
    }

    // Convert to appropriate format
    let buffer: ArrayBuffer | string;
    if (data instanceof ArrayBuffer) {
      buffer = data;
    } else if (data instanceof Uint8Array) {
      buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    } else {
      buffer = data; // string
    }

    // Check buffer size
    const size = typeof buffer === 'string'
      ? new TextEncoder().encode(buffer).byteLength
      : buffer.byteLength;

    if (size > this.maxBufferSize) {
      throw new Error(`Data too large: ${size} bytes exceeds ${this.maxBufferSize} bytes limit`);
    }

    this.dataChannel.send(buffer as ArrayBuffer);
  }

  sendJSON(data: object): void {
    this.send(JSON.stringify(data));
  }

  /**
   * 送信バッファが高水位を下回るまで待ってから送る。遅い回線でも
   * bufferedAmount が無制限に膨らまない。
   */
  async sendWithBackpressure(
    data: ArrayBuffer | Uint8Array | string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.waitForBufferedAmountLow(signal);
    this.send(data);
  }

  /**
   * 送信バッファが高水位を下回るまで待つ。チャネルが閉じた / エラーになった、
   * destroy された、signal が abort された場合は必ず reject する。
   */
  async waitForBufferedAmountLow(signal?: AbortSignal): Promise<void> {
    // bufferedamountlow は高水位より上で発火し得る（閾値が食い違う場合）ので、
    // 発火後も必ず再確認し、下回るまでループする。
    for (;;) {
      const channel = this.dataChannel;
      if (!channel || channel.readyState !== 'open') {
        throw new Error('Peer not connected');
      }
      if (signal?.aborted) {
        throw abortReasonToError(signal);
      }
      if (bufferedAmountOf(channel) < BUFFERED_AMOUNT_HIGH_WATERMARK) {
        return;
      }
      await this.waitForDrainEvent(channel, signal);
    }
  }

  /** bufferedamountlow を 1 回だけ待つ。終了時にリスナーは必ず外す。 */
  private waitForDrainEvent(channel: RTCDataChannel, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        channel.removeEventListener('bufferedamountlow', onDrain);
        signal?.removeEventListener('abort', onAbort);
        this.bufferWaiters.delete(rejectWaiter);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const onDrain = (): void => finish(null);
      const onAbort = (): void => finish(abortReasonToError(signal));
      const rejectWaiter = (reason: Error): void => finish(reason);

      this.bufferWaiters.add(rejectWaiter);
      channel.addEventListener('bufferedamountlow', onDrain);
      signal?.addEventListener('abort', onAbort);
    });
  }

  /** バッファ空き待ちを全て解放する。close / error / destroy から呼ぶ。 */
  private rejectBufferWaiters(reason: Error): void {
    if (this.bufferWaiters.size === 0) return;
    const waiters = [...this.bufferWaiters];
    this.bufferWaiters.clear();
    waiters.forEach(reject => reject(reason));
  }

  on(event: WebRTCEventType, handler: WebRTCEventHandler): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);

    return () => {
      this.eventHandlers.get(event)?.delete(handler);
    };
  }

  private emit(event: WebRTCEvent): void {
    this.eventHandlers.get(event.type)?.forEach(handler => handler(event));
  }

  destroy(): void {
    // 待機中の送信を先に解放する（チャネルを閉じてからでは
    // イベントハンドラを消した後になり、待機が残り得る）。
    this.rejectBufferWaiters(new Error('Connection destroyed'));

    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    this._isConnected = false;
    this.pendingCandidates = [];
    this.eventHandlers.clear();
  }

  // Get connection stats for debugging
  async getStats(): Promise<RTCStatsReport | null> {
    if (!this.pc) return null;
    return this.pc.getStats();
  }
}
