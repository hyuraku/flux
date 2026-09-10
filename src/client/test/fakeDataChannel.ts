/**
 * テスト用の RTCDataChannel / RTCPeerConnection フェイク。
 * bufferedAmount の増減とドレイン（bufferedamountlow の発火）を
 * テストから明示的に制御できるようにする。
 */

function byteLengthOf(data: ArrayBuffer | string): number {
  return typeof data === 'string'
    ? new TextEncoder().encode(data).byteLength
    : data.byteLength;
}

export class FakeDataChannel {
  label = 'flux-transfer';
  readyState: RTCDataChannelState = 'connecting';
  binaryType: BinaryType = 'blob';
  ordered = true;
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  /** send() に渡されたペイロード（メタデータ JSON とチャンクの両方） */
  readonly sent: (ArrayBuffer | string)[] = [];
  /** 観測された bufferedAmount の最大値 */
  maxBufferedAmount = 0;
  /** close() が呼ばれた回数 */
  closeCalls = 0;

  private listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** リスナーが外れているかの検証用 */
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  private dispatch(type: string): void {
    const event = new Event(type);
    [...(this.listeners.get(type) ?? [])].forEach(listener => listener(event));
  }

  send(data: ArrayBuffer | string): void {
    if (this.readyState !== 'open') {
      throw new Error('FakeDataChannel is not open');
    }
    this.sent.push(data);
    this.bufferedAmount += byteLengthOf(data);
    this.maxBufferedAmount = Math.max(this.maxBufferedAmount, this.bufferedAmount);
  }

  /**
   * bytes バイトだけ送信済みにする。実ブラウザと同様、低水位以下に
   * 落ちたときだけ bufferedamountlow を発火する。
   */
  drain(bytes: number = Number.POSITIVE_INFINITY): void {
    const before = this.bufferedAmount;
    if (before === 0) return;

    this.bufferedAmount = Math.max(0, before - bytes);

    if (
      before > this.bufferedAmountLowThreshold &&
      this.bufferedAmount <= this.bufferedAmountLowThreshold
    ) {
      this.dispatch('bufferedamountlow');
    }
  }

  /** チャネルを open にして onopen を発火する */
  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }

  close(): void {
    this.closeCalls++;
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
  }

  /** onerror を発火する */
  fail(error: Error): void {
    this.readyState = 'closed';
    this.onerror?.({ type: 'error', error } as unknown as Event);
  }

  /** 受信データを注入する */
  receive(data: ArrayBuffer | string): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

export interface FakePeerConnection {
  createDataChannel: (label: string, init?: RTCDataChannelInit) => FakeDataChannel;
  createOffer: () => Promise<RTCSessionDescriptionInit>;
  createAnswer: () => Promise<RTCSessionDescriptionInit>;
  setLocalDescription: (description: RTCSessionDescriptionInit) => Promise<void>;
  setRemoteDescription: (description: RTCSessionDescriptionInit) => Promise<void>;
  addIceCandidate: (candidate: RTCIceCandidateInit) => Promise<void>;
  close: () => void;
  getStats: () => Promise<RTCStatsReport>;
  localDescription: RTCSessionDescription | null;
  remoteDescription: RTCSessionDescription | null;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  ondatachannel: ((event: { channel: FakeDataChannel }) => void) | null;
}

/** 指定したフェイクチャネルを返す RTCPeerConnection のフェイク */
export function createFakePeerConnection(channel: FakeDataChannel): FakePeerConnection {
  return {
    createDataChannel: () => channel,
    createOffer: async () => ({ type: 'offer', sdp: 'fake-offer' }),
    createAnswer: async () => ({ type: 'answer', sdp: 'fake-answer' }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {},
    addIceCandidate: async () => {},
    close: () => {},
    getStats: async () => new Map() as unknown as RTCStatsReport,
    localDescription: null,
    remoteDescription: null,
    connectionState: 'new',
    iceConnectionState: 'new',
    onicecandidate: null,
    onconnectionstatechange: null,
    oniceconnectionstatechange: null,
    ondatachannel: null,
  };
}
