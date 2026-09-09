import { describe, it, expect, vi } from 'vitest';
import type * as Party from 'partykit/server';
import TransferServer from './server';
import { CROSS_ROOM_RATE_LIMIT, RATE_LIMITER_ROOM_ID } from './rateLimit';

/**
 * Party.Connection の最小テストダブル
 */
class FakeConnection {
  send = vi.fn<(message: string) => void>();
  close = vi.fn<() => void>();

  constructor(readonly id: string) {}

  asConnection(): Party.Connection {
    return this as unknown as Party.Connection;
  }
}

/**
 * Party.ConnectionContext の最小テストダブル。
 * ip を渡さない場合はヘッダ無し（partykit dev 相当）になる。
 */
function connectionContext(ip?: string): Party.ConnectionContext | undefined {
  if (ip === undefined) {
    return undefined;
  }
  return {
    request: { headers: new Headers({ 'cf-connecting-ip': ip }) },
  } as unknown as Party.ConnectionContext;
}

/**
 * `room.context.parties` のテストダブル。
 *
 * fetch を実際にリミッタールームの TransferServer#onRequest へ流すので、
 * ルームを跨いだ試行が本当に1か所（リミッタールーム）に集まることを検証できる。
 */
class FakeLimiterNetwork {
  readonly room = new FakeRoom(RATE_LIMITER_ROOM_ID);
  readonly server: TransferServer;

  /** テストから差し替えて fetch の失敗を再現できるようにしておく */
  fetch = vi.fn(async (init: RequestInit): Promise<Response> => {
    return this.server.onRequest(
      new Request('http://limiter/', init) as unknown as Party.Request
    );
  });

  constructor() {
    this.server = new TransferServer(this.room.asRoom());
  }

  asParties(): Party.Room['context']['parties'] {
    return {
      main: {
        get: (id: string) => {
          expect(id).toBe(RATE_LIMITER_ROOM_ID);
          return { fetch: this.fetch } as unknown as Party.Stub;
        },
      },
    } as unknown as Party.Room['context']['parties'];
  }
}

/**
 * Party.Room の最小テストダブル
 */
class FakeRoom {
  connections: FakeConnection[] = [];
  context: Party.Room['context'] | undefined;

  broadcast = vi.fn((message: string) => {
    for (const conn of this.connections) {
      conn.send(message);
    }
  });

  constructor(readonly id: string, limiter?: FakeLimiterNetwork) {
    this.context = limiter
      ? ({ parties: limiter.asParties() } as Party.Room['context'])
      : undefined;
  }

  getConnections(): FakeConnection[] {
    return this.connections;
  }

  asRoom(): Party.Room {
    return this as unknown as Party.Room;
  }
}

// モジュールレベルの codeManager は全テストで共有されるため、
// ルームIDと接続IDはテストごとに一意にする
let roomCounter = 0;
function nextRoomId(): string {
  roomCounter += 1;
  return (100000 + roomCounter).toString();
}

// ルーム横断リミッターもモジュールレベルで共有されるため、IPもテストごとに一意にする
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

interface Harness {
  room: FakeRoom;
  server: TransferServer;
  connect: (suffix: string, ip?: string) => FakeConnection;
  send: (conn: FakeConnection, message: unknown) => Promise<void>;
  sendRaw: (conn: FakeConnection, raw: string) => Promise<void>;
}

interface HarnessOptions {
  /** ルーム横断リミッターへ繋ぐ。省略するとリミッターに届かず fail-open する */
  limiter?: FakeLimiterNetwork;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const room = new FakeRoom(nextRoomId(), options.limiter);
  const server = new TransferServer(room.asRoom());

  return {
    room,
    server,
    connect(suffix: string, ip?: string) {
      const conn = new FakeConnection(`${room.id}-${suffix}`);
      room.connections.push(conn);
      server.onConnect(conn.asConnection(), connectionContext(ip));
      return conn;
    },
    async send(conn: FakeConnection, message: unknown) {
      await server.onMessage(JSON.stringify(message), conn.asConnection());
    },
    async sendRaw(conn: FakeConnection, raw: string) {
      await server.onMessage(raw, conn.asConnection());
    },
  };
}

interface AnyMessage {
  type: string;
  [key: string]: unknown;
}

function received(conn: FakeConnection): AnyMessage[] {
  return conn.send.mock.calls.map(([raw]) => JSON.parse(raw) as AnyMessage);
}

function receivedOfType(conn: FakeConnection, type: string): AnyMessage[] {
  return received(conn).filter((message) => message.type === type);
}

function lastMessage(conn: FakeConnection): AnyMessage | undefined {
  return received(conn).at(-1);
}

/**
 * receiver が generate_code、sender が join_room を済ませた状態を作る
 */
async function createPairedRoom() {
  const harness = createHarness();
  const receiver = harness.connect('receiver');
  await harness.send(receiver, { type: 'generate_code' });

  const sender = harness.connect('sender');
  await harness.send(sender, {
    type: 'join_room',
    code: harness.room.id,
    role: 'sender',
  });

  return { ...harness, receiver, sender };
}

describe('TransferServer', () => {
  describe('正常系のシグナリング', () => {
    it('receiverがgenerate_codeでコードを受け取る', async () => {
      const { room, connect, send } = createHarness();
      const receiver = connect('receiver');

      await send(receiver, { type: 'generate_code' });

      expect(lastMessage(receiver)).toMatchObject({
        type: 'code_generated',
        code: room.id,
        roomId: room.id,
      });
    });

    it('senderがjoin_roomすると双方にpeer_joinedが届く', async () => {
      const { receiver, sender } = await createPairedRoom();

      expect(receivedOfType(receiver, 'peer_joined')).toHaveLength(1);
      expect(receivedOfType(sender, 'peer_joined')).toEqual([
        expect.objectContaining({ peerId: sender.id, role: 'sender' }),
      ]);
    });

    it('receiverのwebrtc_offerがfromPeerId付きでsenderに届く', async () => {
      const { receiver, sender, send } = await createPairedRoom();

      await send(receiver, {
        type: 'webrtc_offer',
        targetPeerId: sender.id,
        sdp: 'offer-sdp',
      });

      expect(receivedOfType(sender, 'webrtc_offer')).toEqual([
        {
          type: 'webrtc_offer',
          targetPeerId: sender.id,
          sdp: 'offer-sdp',
          fromPeerId: receiver.id,
        },
      ]);
    });

    it('senderのwebrtc_answerがreceiverに届く', async () => {
      const { receiver, sender, send } = await createPairedRoom();

      await send(sender, {
        type: 'webrtc_answer',
        targetPeerId: receiver.id,
        sdp: 'answer-sdp',
      });

      expect(receivedOfType(receiver, 'webrtc_answer')).toEqual([
        {
          type: 'webrtc_answer',
          targetPeerId: receiver.id,
          sdp: 'answer-sdp',
          fromPeerId: sender.id,
        },
      ]);
    });

    it('ice_candidateが双方向に中継される', async () => {
      const { receiver, sender, send } = await createPairedRoom();

      await send(receiver, {
        type: 'ice_candidate',
        targetPeerId: sender.id,
        candidate: 'from-receiver',
      });
      await send(sender, {
        type: 'ice_candidate',
        targetPeerId: receiver.id,
        candidate: 'from-sender',
      });

      expect(receivedOfType(sender, 'ice_candidate')).toEqual([
        expect.objectContaining({ candidate: 'from-receiver', fromPeerId: receiver.id }),
      ]);
      expect(receivedOfType(receiver, 'ice_candidate')).toEqual([
        expect.objectContaining({ candidate: 'from-sender', fromPeerId: sender.id }),
      ]);
    });

    it('transfer_statusが相手にpeer_statusとして届く', async () => {
      const { receiver, sender, send } = await createPairedRoom();

      await send(sender, {
        type: 'transfer_status',
        status: 'transferring',
        progress: 42,
        speed: 1024,
      });

      expect(receivedOfType(receiver, 'peer_status')).toEqual([
        {
          type: 'peer_status',
          fromPeerId: sender.id,
          status: 'transferring',
          progress: 42,
          speed: 1024,
        },
      ]);
      expect(receivedOfType(sender, 'peer_status')).toHaveLength(0);
    });
  });

  describe('メッセージ形式の検証', () => {
    it('JSONとして不正な文字列でも例外を投げずINVALID_MESSAGEを返す', async () => {
      const { connect, sendRaw } = createHarness();
      const conn = connect('peer');

      expect(() => sendRaw(conn, '{ not json')).not.toThrow();
      expect(lastMessage(conn)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('nullを渡しても例外を投げずINVALID_MESSAGEを返す', async () => {
      const { connect, sendRaw } = createHarness();
      const conn = connect('peer');

      expect(() => sendRaw(conn, 'null')).not.toThrow();
      expect(lastMessage(conn)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('配列を渡してもINVALID_MESSAGEを返す', async () => {
      const { connect, send } = createHarness();
      const conn = connect('peer');

      expect(() => send(conn, ['webrtc_offer'])).not.toThrow();
      expect(lastMessage(conn)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('typeが無いオブジェクトはINVALID_MESSAGEを返す', async () => {
      const { connect, send } = createHarness();
      const conn = connect('peer');

      await send(conn, { targetPeerId: 'someone', sdp: 'x' });

      expect(lastMessage(conn)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('未知のtypeはINVALID_MESSAGEを返す', async () => {
      const { connect, send } = createHarness();
      const conn = connect('peer');

      await send(conn, { type: 'definitely_unknown' });

      expect(lastMessage(conn)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('targetPeerIdやsdpが文字列でないwebrtc_offerは中継しない', async () => {
      const { receiver, sender, send } = await createPairedRoom();

      await send(receiver, { type: 'webrtc_offer', targetPeerId: 123, sdp: 'x' });
      await send(receiver, { type: 'webrtc_offer', targetPeerId: sender.id, sdp: { a: 1 } });

      expect(receivedOfType(sender, 'webrtc_offer')).toHaveLength(0);
      expect(receivedOfType(receiver, 'error')).toHaveLength(2);
    });

    it('上限を超えるsdpは中継せずINVALID_MESSAGEを返す', async () => {
      const { receiver, sender, send } = await createPairedRoom();

      await send(receiver, {
        type: 'webrtc_offer',
        targetPeerId: sender.id,
        sdp: 'a'.repeat(64 * 1024 + 1),
      });

      expect(receivedOfType(sender, 'webrtc_offer')).toHaveLength(0);
      expect(lastMessage(receiver)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('上限を超えるcandidateは中継せずINVALID_MESSAGEを返す', async () => {
      const { receiver, sender, send } = await createPairedRoom();

      await send(receiver, {
        type: 'ice_candidate',
        targetPeerId: sender.id,
        candidate: 'a'.repeat(4 * 1024 + 1),
      });

      expect(receivedOfType(sender, 'ice_candidate')).toHaveLength(0);
      expect(lastMessage(receiver)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('未知のstatusや非有限のprogressを持つtransfer_statusは拒否する', async () => {
      const { receiver, sender, send } = await createPairedRoom();

      await send(sender, { type: 'transfer_status', status: 'hacking', progress: 1, speed: 1 });
      await send(sender, {
        type: 'transfer_status',
        status: 'transferring',
        progress: Number.NaN,
        speed: 1,
      });

      expect(receivedOfType(receiver, 'peer_status')).toHaveLength(0);
      expect(receivedOfType(sender, 'error')).toHaveLength(2);
    });
  });

  describe('参加状態の検証', () => {
    it('未参加の接続からのwebrtc_answerは中継しない', async () => {
      const { room, server, connect, send } = createHarness();
      const receiver = connect('receiver');
      await send(receiver, { type: 'generate_code' });

      // join_room も generate_code も経ていない接続
      const outsider = new FakeConnection(`${room.id}-outsider`);
      room.connections.push(outsider);
      await server.onMessage(
        JSON.stringify({
          type: 'webrtc_answer',
          targetPeerId: receiver.id,
          sdp: 'rogue-sdp',
        }),
        outsider.asConnection()
      );

      expect(receivedOfType(receiver, 'webrtc_answer')).toHaveLength(0);
      expect(lastMessage(outsider)).toMatchObject({
        type: 'error',
        code: 'NOT_AUTHORIZED',
      });
    });

    it('未参加の接続からのice_candidateは中継しない', async () => {
      const { room, server, connect, send } = createHarness();
      const receiver = connect('receiver');
      await send(receiver, { type: 'generate_code' });

      const outsider = new FakeConnection(`${room.id}-outsider`);
      room.connections.push(outsider);
      await server.onMessage(
        JSON.stringify({
          type: 'ice_candidate',
          targetPeerId: receiver.id,
          candidate: 'rogue-candidate',
        }),
        outsider.asConnection()
      );

      expect(receivedOfType(receiver, 'ice_candidate')).toHaveLength(0);
      expect(lastMessage(outsider)).toMatchObject({
        type: 'error',
        code: 'NOT_AUTHORIZED',
      });
    });

    it('未参加の接続からのtransfer_statusは中継しない', async () => {
      const { room, server, connect, send } = createHarness();
      const receiver = connect('receiver');
      await send(receiver, { type: 'generate_code' });

      const outsider = new FakeConnection(`${room.id}-outsider`);
      room.connections.push(outsider);
      await server.onMessage(
        JSON.stringify({
          type: 'transfer_status',
          status: 'transferring',
          progress: 10,
          speed: 10,
        }),
        outsider.asConnection()
      );

      expect(receivedOfType(receiver, 'peer_status')).toHaveLength(0);
      expect(lastMessage(outsider)).toMatchObject({
        type: 'error',
        code: 'NOT_AUTHORIZED',
      });
    });
  });

  describe('ロールと宛先の検証', () => {
    it('senderからのwebrtc_offerは中継しない（ロールが逆）', async () => {
      const { receiver, sender, send } = await createPairedRoom();

      await send(sender, {
        type: 'webrtc_offer',
        targetPeerId: receiver.id,
        sdp: 'offer-from-sender',
      });

      expect(receivedOfType(receiver, 'webrtc_offer')).toHaveLength(0);
      expect(lastMessage(sender)).toMatchObject({
        type: 'error',
        code: 'NOT_AUTHORIZED',
      });
    });

    it('receiverからのwebrtc_answerは中継しない（ロールが逆）', async () => {
      const { receiver, sender, send } = await createPairedRoom();

      await send(receiver, {
        type: 'webrtc_answer',
        targetPeerId: sender.id,
        sdp: 'answer-from-receiver',
      });

      expect(receivedOfType(sender, 'webrtc_answer')).toHaveLength(0);
      expect(lastMessage(receiver)).toMatchObject({
        type: 'error',
        code: 'NOT_AUTHORIZED',
      });
    });

    it('自分自身を宛先にしたメッセージは中継しない', async () => {
      const { receiver, sender, send } = await createPairedRoom();

      await send(receiver, {
        type: 'webrtc_offer',
        targetPeerId: receiver.id,
        sdp: 'self-offer',
      });

      expect(receivedOfType(receiver, 'webrtc_offer')).toHaveLength(0);
      expect(lastMessage(receiver)).toMatchObject({
        type: 'error',
        code: 'NOT_AUTHORIZED',
      });
      expect(receivedOfType(sender, 'webrtc_offer')).toHaveLength(0);
    });

    it('未登録のtargetPeerId宛ては中継しない', async () => {
      const { room, receiver, sender, send } = await createPairedRoom();

      // ルームには接続しているが peers に登録されていない第三者
      const outsider = new FakeConnection(`${room.id}-outsider`);
      room.connections.push(outsider);

      await send(receiver, {
        type: 'webrtc_offer',
        targetPeerId: outsider.id,
        sdp: 'offer-to-outsider',
      });

      expect(receivedOfType(outsider, 'webrtc_offer')).toHaveLength(0);
      expect(lastMessage(receiver)).toMatchObject({
        type: 'error',
        code: 'NOT_AUTHORIZED',
      });
      expect(receivedOfType(sender, 'webrtc_offer')).toHaveLength(0);
    });
  });

  describe('join_roomの検証', () => {
    it('room.idと一致しないコードでは参加できない', async () => {
      // 別ルームで有効なコードを発行する
      const other = createHarness();
      const otherReceiver = other.connect('receiver');
      await other.send(otherReceiver, { type: 'generate_code' });

      const { connect, send } = createHarness();
      const receiver = connect('receiver');
      await send(receiver, { type: 'generate_code' });

      const sender = connect('sender');
      await send(sender, { type: 'join_room', code: other.room.id, role: 'sender' });

      expect(lastMessage(sender)).toMatchObject({
        type: 'error',
        code: 'INVALID_CODE',
      });
      expect(receivedOfType(receiver, 'peer_joined')).toHaveLength(0);
    });

    it('6桁でないコードはINVALID_MESSAGEで拒否する', async () => {
      const { connect, send } = createHarness();
      const sender = connect('sender');

      await send(sender, { type: 'join_room', code: '12', role: 'sender' });

      expect(lastMessage(sender)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('不正なroleはINVALID_MESSAGEで拒否する', async () => {
      const { room, connect, send } = createHarness();
      const receiver = connect('receiver');
      await send(receiver, { type: 'generate_code' });

      const sender = connect('sender');
      await send(sender, { type: 'join_room', code: room.id, role: 'admin' });

      expect(lastMessage(sender)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('role=receiverでのjoin_roomは受け付けない', async () => {
      const { room, connect, send } = createHarness();
      const receiver = connect('receiver');
      await send(receiver, { type: 'generate_code' });

      const impostor = connect('impostor');
      await send(impostor, { type: 'join_room', code: room.id, role: 'receiver' });

      expect(lastMessage(impostor)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('2人目のsenderはROOM_FULLで拒否する', async () => {
      const { room, connect, send, sender } = await createPairedRoom();

      const secondSender = connect('sender2');
      await send(secondSender, { type: 'join_room', code: room.id, role: 'sender' });

      expect(lastMessage(secondSender)).toMatchObject({
        type: 'error',
        code: 'ROOM_FULL',
      });
      // 既存の sender には peer_joined が増えない
      expect(receivedOfType(sender, 'peer_joined')).toHaveLength(1);
    });
  });

  describe('generate_codeの検証', () => {
    it('receiverが既にいるルームでの2回目のgenerate_codeはROOM_FULLで拒否する', async () => {
      const { connect, send } = createHarness();
      const receiver = connect('receiver');
      await send(receiver, { type: 'generate_code' });

      const secondReceiver = connect('receiver2');
      await send(secondReceiver, { type: 'generate_code' });

      expect(lastMessage(secondReceiver)).toMatchObject({
        type: 'error',
        code: 'ROOM_FULL',
      });
      expect(receivedOfType(secondReceiver, 'code_generated')).toHaveLength(0);
    });
  });

  describe('lock_connection', () => {
    it('他人のpeerIdを指定したlock_connectionは拒否する', async () => {
      const { receiver, sender, send } = await createPairedRoom();

      await send(sender, { type: 'lock_connection', peerId: receiver.id });

      expect(receivedOfType(sender, 'connection_locked')).toHaveLength(0);
      expect(lastMessage(sender)).toMatchObject({
        type: 'error',
        code: 'NOT_AUTHORIZED',
      });
    });

    it('未参加の接続からのlock_connectionは拒否する', async () => {
      const { room, server } = await createPairedRoom();
      const outsider = new FakeConnection(`${room.id}-outsider`);
      room.connections.push(outsider);

      await server.onMessage(
        JSON.stringify({ type: 'lock_connection', peerId: outsider.id }),
        outsider.asConnection()
      );

      expect(receivedOfType(outsider, 'connection_locked')).toHaveLength(0);
      expect(lastMessage(outsider)).toMatchObject({
        type: 'error',
        code: 'NOT_AUTHORIZED',
      });
    });

    it('自分自身のpeerIdならロックを発行する', async () => {
      const { sender, send } = await createPairedRoom();

      await send(sender, { type: 'lock_connection', peerId: sender.id });

      expect(lastMessage(sender)).toMatchObject({ type: 'connection_locked' });
    });
  });

  describe('reconnect_with_lock', () => {
    it('ロックを消費してpeerを引き継ぎ、シグナリングを継続できる', async () => {
      const { connect, send, receiver, sender } = await createPairedRoom();

      await send(sender, { type: 'lock_connection', peerId: sender.id });
      const locked = receivedOfType(sender, 'connection_locked')[0];
      expect(locked).toBeDefined();

      const reconnected = connect('sender-reconnected');
      await send(reconnected, { type: 'reconnect_with_lock', lockId: locked.lockId });

      expect(receivedOfType(reconnected, 'peer_joined')).toEqual([
        expect.objectContaining({ peerId: reconnected.id, role: 'sender' }),
      ]);

      // 引き継いだ接続は sender として answer を中継できる
      await send(reconnected, {
        type: 'webrtc_answer',
        targetPeerId: receiver.id,
        sdp: 'answer-after-reconnect',
      });
      expect(receivedOfType(receiver, 'webrtc_answer')).toEqual([
        expect.objectContaining({
          sdp: 'answer-after-reconnect',
          fromPeerId: reconnected.id,
        }),
      ]);

      // 古い接続はもう peers に居ないので中継されない
      await send(sender, {
        type: 'webrtc_answer',
        targetPeerId: receiver.id,
        sdp: 'stale-answer',
      });
      expect(receivedOfType(receiver, 'webrtc_answer')).toHaveLength(1);

      // ロックは使い捨て
      const second = connect('sender-reconnected2');
      await send(second, { type: 'reconnect_with_lock', lockId: locked.lockId });
      expect(lastMessage(second)).toMatchObject({
        type: 'error',
        code: 'LOCK_NOT_FOUND',
      });
    });

    it('切断後の再接続でもロールを引き継いで中継できる', async () => {
      const { server, connect, send, receiver, sender } = await createPairedRoom();

      await send(sender, { type: 'lock_connection', peerId: sender.id });
      const locked = receivedOfType(sender, 'connection_locked')[0];

      // 実際の切断で peers から消える
      server.onClose(sender.asConnection());

      const reconnected = connect('sender-reconnected');
      await send(reconnected, { type: 'reconnect_with_lock', lockId: locked.lockId });

      await send(reconnected, {
        type: 'webrtc_answer',
        targetPeerId: receiver.id,
        sdp: 'answer-after-disconnect',
      });

      expect(receivedOfType(receiver, 'webrtc_answer')).toEqual([
        expect.objectContaining({ sdp: 'answer-after-disconnect' }),
      ]);
    });

    it('lockIdが文字列でない場合はINVALID_MESSAGEを返す', async () => {
      const { connect, send } = createHarness();
      const conn = connect('peer');

      await send(conn, { type: 'reconnect_with_lock', lockId: 42 });

      expect(lastMessage(conn)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });
  });

  describe('ルーム横断のペアリング試行制限', () => {
    /**
     * 毎回「別ルーム・別接続」から無効なコードで join_room する。
     * 接続IDキーのローカル制限は毎回まっさらなので、
     * ここで効くのはルーム横断のリミッターだけになる。
     */
    async function attemptJoin(
      limiter: FakeLimiterNetwork,
      ip: string | undefined,
      suffix: string
    ): Promise<AnyMessage | undefined> {
      const harness = createHarness({ limiter });
      const conn = harness.connect(suffix, ip);
      await harness.send(conn, {
        type: 'join_room',
        code: harness.room.id,
        role: 'sender',
      });
      return lastMessage(conn);
    }

    async function pairSuccessfully(
      limiter: FakeLimiterNetwork | undefined,
      ip: string | undefined
    ) {
      const harness = createHarness({ limiter });
      const receiver = harness.connect('receiver', ip);
      await harness.send(receiver, { type: 'generate_code' });

      const sender = harness.connect('sender', ip);
      await harness.send(sender, {
        type: 'join_room',
        code: harness.room.id,
        role: 'sender',
      });
      return sender;
    }

    it('接続IDとルームIDを変えても、同一IPの失敗はしきい値でRATE_LIMITEDになる', async () => {
      const limiter = new FakeLimiterNetwork();
      const ip = nextIp();
      const { lockoutThreshold } = CROSS_ROOM_RATE_LIMIT;

      // しきい値まではコードが違うというエラーで済む
      for (let i = 0; i < lockoutThreshold; i++) {
        expect(await attemptJoin(limiter, ip, `attacker-${i}`)).toMatchObject({
          type: 'error',
          code: 'INVALID_CODE',
        });
      }

      // しきい値到達後は別ルーム・別接続でも止まる
      expect(await attemptJoin(limiter, ip, 'attacker-final')).toMatchObject({
        type: 'error',
        code: 'RATE_LIMITED',
      });
    });

    it('ロックアウトされたIPがいても、別のIPは巻き添えにならない', async () => {
      const limiter = new FakeLimiterNetwork();
      const attackerIp = nextIp();
      const innocentIp = nextIp();

      for (let i = 0; i < CROSS_ROOM_RATE_LIMIT.lockoutThreshold; i++) {
        await attemptJoin(limiter, attackerIp, `attacker-${i}`);
      }
      expect(await attemptJoin(limiter, attackerIp, 'attacker-final')).toMatchObject({
        code: 'RATE_LIMITED',
      });

      const sender = await pairSuccessfully(limiter, innocentIp);
      expect(receivedOfType(sender, 'peer_joined')).toHaveLength(1);
      expect(receivedOfType(sender, 'error')).toHaveLength(0);
    });

    it('ペアリングに成功すると失敗カウントがリセットされる', async () => {
      const limiter = new FakeLimiterNetwork();
      const ip = nextIp();
      const { lockoutThreshold } = CROSS_ROOM_RATE_LIMIT;

      // あと1回でロックされるところまで失敗する
      for (let i = 0; i < lockoutThreshold - 1; i++) {
        await attemptJoin(limiter, ip, `retry-${i}`);
      }

      // 正しいコードで成功
      const sender = await pairSuccessfully(limiter, ip);
      expect(receivedOfType(sender, 'peer_joined')).toHaveLength(1);

      // カウントが戻っているので、また同じ回数まで失敗できる
      for (let i = 0; i < lockoutThreshold - 1; i++) {
        expect(await attemptJoin(limiter, ip, `after-${i}`)).toMatchObject({
          code: 'INVALID_CODE',
        });
      }
    });

    it('IPヘッダが無い場合は接続IDにフォールバックする（＝張り直しで回避できる）', async () => {
      const limiter = new FakeLimiterNetwork();

      // ip を渡さない = cf-connecting-ip の無い環境
      for (let i = 0; i < CROSS_ROOM_RATE_LIMIT.lockoutThreshold + 5; i++) {
        expect(await attemptJoin(limiter, undefined, `anon-${i}`)).toMatchObject({
          code: 'INVALID_CODE',
        });
      }
    });

    it('リミッターへのfetchがrejectされてもペアリングは続けられる（fail-open）', async () => {
      const limiter = new FakeLimiterNetwork();
      limiter.fetch.mockRejectedValue(new Error('limiter unreachable'));

      const sender = await pairSuccessfully(limiter, nextIp());

      expect(receivedOfType(sender, 'peer_joined')).toHaveLength(1);
      expect(receivedOfType(sender, 'error')).toHaveLength(0);
    });

    it('リミッターが非2xxを返してもペアリングは続けられる（fail-open）', async () => {
      const limiter = new FakeLimiterNetwork();
      limiter.fetch.mockResolvedValue(new Response('boom', { status: 500 }));

      const sender = await pairSuccessfully(limiter, nextIp());

      expect(receivedOfType(sender, 'peer_joined')).toHaveLength(1);
      expect(receivedOfType(sender, 'error')).toHaveLength(0);
    });

    it('room.context が無い環境でもペアリングは続けられる（fail-open）', async () => {
      const sender = await pairSuccessfully(undefined, nextIp());

      expect(receivedOfType(sender, 'peer_joined')).toHaveLength(1);
    });
  });

  describe('リミッタールーム', () => {
    function request(body: unknown, method = 'POST'): Party.Request {
      return new Request('http://limiter/', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body),
      }) as unknown as Party.Request;
    }

    async function check(
      limiter: FakeLimiterNetwork,
      key: string
    ): Promise<unknown> {
      const response = await limiter.server.onRequest(
        request({ action: 'check', key })
      );
      return response.json();
    }

    it('WebSocket接続は受け付けずに閉じる', () => {
      const limiter = new FakeLimiterNetwork();
      const conn = new FakeConnection('ws-client');

      limiter.server.onConnect(conn.asConnection(), undefined);

      expect(conn.close).toHaveBeenCalled();
      expect(conn.send).not.toHaveBeenCalled();
    });

    it('WebSocketメッセージも処理せずに閉じる', async () => {
      const limiter = new FakeLimiterNetwork();
      const conn = new FakeConnection('ws-client');

      await limiter.server.onMessage(
        JSON.stringify({ type: 'generate_code' }),
        conn.asConnection()
      );

      expect(conn.close).toHaveBeenCalled();
      expect(conn.send).not.toHaveBeenCalled();
    });

    it('転送ルームへのHTTPリクエストは404を返す', async () => {
      const { server } = createHarness();

      const response = await server.onRequest(
        request({ action: 'check', key: nextIp() })
      );

      expect(response.status).toBe(404);
    });

    it('cf-connecting-ip付き（＝外部からの直接リクエスト）は404で弾く', async () => {
      const limiter = new FakeLimiterNetwork();
      const key = nextIp();

      const external = new Request('http://limiter/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': '203.0.113.200',
        },
        body: JSON.stringify({ action: 'record_failure', key }),
      }) as unknown as Party.Request;

      expect((await limiter.server.onRequest(external)).status).toBe(404);

      // 失敗が記録されていないこと
      expect(await check(limiter, key)).toEqual({ allowed: true });
    });

    it('x-forwarded-for付きの直接リクエストも404で弾く', async () => {
      const limiter = new FakeLimiterNetwork();

      const external = new Request('http://limiter/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '203.0.113.201',
        },
        body: JSON.stringify({ action: 'record_success', key: nextIp() }),
      }) as unknown as Party.Request;

      expect((await limiter.server.onRequest(external)).status).toBe(404);
    });

    it('maxAttemptsを超えるcheckはrate_limitedを返す', async () => {
      const limiter = new FakeLimiterNetwork();
      const key = nextIp();

      for (let i = 0; i < CROSS_ROOM_RATE_LIMIT.maxAttempts; i++) {
        expect(await check(limiter, key)).toEqual({ allowed: true });
      }

      expect(await check(limiter, key)).toEqual({
        allowed: false,
        reason: 'rate_limited',
      });
    });

    it('別インスタンス経由でも状態が共有される（ルーム横断の集約）', async () => {
      const first = new FakeLimiterNetwork();
      const second = new FakeLimiterNetwork();
      const key = nextIp();

      for (let i = 0; i < CROSS_ROOM_RATE_LIMIT.lockoutThreshold; i++) {
        await first.server.onRequest(request({ action: 'record_failure', key }));
      }

      expect(await check(second, key)).toEqual({
        allowed: false,
        reason: 'locked_out',
      });
    });

    it('POST以外は405、壊れたJSONや不正なactionは400を返す', async () => {
      const limiter = new FakeLimiterNetwork();

      expect((await limiter.server.onRequest(request(null, 'GET'))).status).toBe(405);

      const broken = new Request('http://limiter/', {
        method: 'POST',
        body: '{ not json',
      }) as unknown as Party.Request;
      expect((await limiter.server.onRequest(broken)).status).toBe(400);

      expect((await limiter.server.onRequest(request({ action: 'check' }))).status).toBe(
        400
      );
      expect(
        (await limiter.server.onRequest(request({ action: 'drop_table', key: 'x' })))
          .status
      ).toBe(400);
    });
  });
});
