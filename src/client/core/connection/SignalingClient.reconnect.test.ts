import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SignalingClient } from './SignalingClient';

/**
 * 再接続の所有者が PartySocket 1 つだけであることを確かめるためのフェイク。
 * インスタンス数と「生きているソケット数」を数えられるようにしてある。
 */
const fake = vi.hoisted(() => {
  type Handler = ((arg?: unknown) => void) | null;

  class FakePartySocket {
    static instances: FakePartySocket[] = [];

    readyState = 0; // CONNECTING
    closed = false;
    options: Record<string, unknown>;

    onopen: Handler = null;
    onclose: Handler = null;
    onerror: Handler = null;
    onmessage: ((event: { data: string }) => void) | null = null;

    send = vi.fn();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakePartySocket.instances.push(this);
    }

    close(): void {
      this.closed = true;
      this.readyState = 3; // CLOSED
    }

    // --- テストから状態遷移を起こすためのヘルパー ---
    open(): void {
      this.readyState = 1; // OPEN
      this.onopen?.();
    }

    fireClose(): void {
      this.readyState = 3;
      this.onclose?.();
    }

    fireError(error: unknown = new Error('boom')): void {
      this.onerror?.(error);
    }
  }

  return { FakePartySocket };
});

vi.mock('partysocket', () => ({
  default: fake.FakePartySocket,
}));

type FakeSocket = InstanceType<typeof fake.FakePartySocket>;

function instances(): FakeSocket[] {
  return fake.FakePartySocket.instances;
}

/** disconnect / close されていないソケットの数 */
function liveSocketCount(): number {
  return instances().filter(socket => !socket.closed).length;
}

function latest(): FakeSocket {
  const list = instances();
  return list[list.length - 1];
}

describe('SignalingClient の再接続', () => {
  let client: SignalingClient;

  beforeEach(() => {
    fake.FakePartySocket.instances = [];
    client = new SignalingClient('localhost:1999');
  });

  it('PartySocket に上限付きの再接続オプションを渡す', async () => {
    const connected = client.connect('123456');
    latest().open();
    await connected;

    expect(latest().options).toMatchObject({
      host: 'localhost:1999',
      room: '123456',
      maxRetries: 3,
    });
    expect(latest().options.maxRetries).not.toBe(Number.POSITIVE_INFINITY);
  });

  it('connect は最初の open で 1 度だけ resolve する', async () => {
    const onConnected = vi.fn();
    const onReconnected = vi.fn();
    client.on('connected', onConnected);
    client.on('reconnected', onReconnected);

    const connected = client.connect('123456');
    latest().open();
    await expect(connected).resolves.toBeUndefined();

    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onReconnected).not.toHaveBeenCalled();
  });

  it('初回 open 前のエラーで reject し、ソケットを残さない', async () => {
    const connected = client.connect('123456');
    latest().fireError(new Error('refused'));

    await expect(connected).rejects.toThrow('Could not connect to the signaling server');
    // リトライを続けるゾンビを残さない
    expect(liveSocketCount()).toBe(0);
    expect(instances()).toHaveLength(1);
  });

  it('初回 open 前の close でも reject する', async () => {
    const connected = client.connect('123456');
    latest().fireClose();

    await expect(connected).rejects.toThrow('closed before it opened');
    expect(liveSocketCount()).toBe(0);
  });

  it('reject 後に再度 error / close が起きても二重には決着しない', async () => {
    const connected = client.connect('123456');
    const socket = latest();

    socket.fireError(new Error('refused'));
    await expect(connected).rejects.toThrow();

    // 追加のイベントが飛んでも例外にならず、新しいソケットも作られない
    expect(() => {
      socket.fireError(new Error('again'));
      socket.fireClose();
    }).not.toThrow();
    expect(instances()).toHaveLength(1);
  });

  it('open 後の close は disconnected を出すだけで reject しない', async () => {
    const onDisconnected = vi.fn();
    client.on('disconnected', onDisconnected);

    const connected = client.connect('123456');
    latest().open();
    await connected;

    latest().fireClose();

    expect(onDisconnected).toHaveBeenCalledWith({ type: 'disconnected' });
    // PartySocket が自分で張り直すので、クライアント側は新規ソケットを作らない
    expect(instances()).toHaveLength(1);
  });

  it('切断 -> 再接続 -> disconnect でソケット数が 1 -> 1 -> 0 になる', async () => {
    const events: string[] = [];
    client.on('connected', () => events.push('connected'));
    client.on('reconnected', () => events.push('reconnected'));
    client.on('disconnected', () => events.push('disconnected'));

    const connected = client.connect('123456');
    latest().open();
    await connected;
    expect(liveSocketCount()).toBe(1);

    // 切断（PartySocket 内部で再接続が始まる）
    latest().fireClose();
    expect(liveSocketCount()).toBe(1);
    expect(instances()).toHaveLength(1);

    // 同じソケットが再度 open する
    latest().open();
    expect(liveSocketCount()).toBe(1);
    expect(instances()).toHaveLength(1);

    client.disconnect();
    expect(liveSocketCount()).toBe(0);
    expect(instances()).toHaveLength(1);

    expect(events).toEqual(['connected', 'disconnected', 'reconnected']);
  });

  it('disconnect 後はイベントを一切出さず、新しいソケットも作らない', async () => {
    const handler = vi.fn();
    const connected = client.connect('123456');
    const socket = latest();
    socket.open();
    await connected;

    client.on('disconnected', handler);
    client.on('connected', handler);
    client.on('error', handler);
    client.disconnect();

    // disconnect() は購読も消すので、残響イベントは誰にも届かない
    socket.fireClose();
    socket.fireError();
    socket.open();

    expect(handler).not.toHaveBeenCalled();
    expect(instances()).toHaveLength(1);
    expect(liveSocketCount()).toBe(0);
  });

  it('接続待ちのまま disconnect されたら Promise を宙吊りにしない', async () => {
    const connected = client.connect('123456');

    client.disconnect();

    await expect(connected).rejects.toThrow('Signaling connection was closed');
    expect(liveSocketCount()).toBe(0);
  });

  it('connect を張り直すときは古いソケットを閉じる', async () => {
    const first = (async () => {
      const promise = client.connect('111111');
      latest().open();
      await promise;
    })();
    await first;
    const firstSocket = latest();

    const second = client.connect('222222');
    latest().open();
    await second;

    expect(instances()).toHaveLength(2);
    expect(firstSocket.closed).toBe(true);
    expect(liveSocketCount()).toBe(1);
  });
});
