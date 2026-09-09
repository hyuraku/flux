import { describe, it, expect, vi } from 'vitest';
import type * as Party from 'partykit/server';
import TransferServer from './server';

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
 * Party.Room の最小テストダブル
 */
class FakeRoom {
  connections: FakeConnection[] = [];

  broadcast = vi.fn((message: string) => {
    for (const conn of this.connections) {
      conn.send(message);
    }
  });

  constructor(readonly id: string) {}

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

interface Harness {
  room: FakeRoom;
  server: TransferServer;
  connect: (suffix: string) => FakeConnection;
  send: (conn: FakeConnection, message: unknown) => void;
  sendRaw: (conn: FakeConnection, raw: string) => void;
}

function createHarness(): Harness {
  const room = new FakeRoom(nextRoomId());
  const server = new TransferServer(room.asRoom());

  return {
    room,
    server,
    connect(suffix: string) {
      const conn = new FakeConnection(`${room.id}-${suffix}`);
      room.connections.push(conn);
      server.onConnect(conn.asConnection());
      return conn;
    },
    send(conn: FakeConnection, message: unknown) {
      server.onMessage(JSON.stringify(message), conn.asConnection());
    },
    sendRaw(conn: FakeConnection, raw: string) {
      server.onMessage(raw, conn.asConnection());
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
function createPairedRoom() {
  const harness = createHarness();
  const receiver = harness.connect('receiver');
  harness.send(receiver, { type: 'generate_code' });

  const sender = harness.connect('sender');
  harness.send(sender, {
    type: 'join_room',
    code: harness.room.id,
    role: 'sender',
  });

  return { ...harness, receiver, sender };
}

describe('TransferServer', () => {
  describe('正常系のシグナリング', () => {
    it('receiverがgenerate_codeでコードを受け取る', () => {
      const { room, connect, send } = createHarness();
      const receiver = connect('receiver');

      send(receiver, { type: 'generate_code' });

      expect(lastMessage(receiver)).toMatchObject({
        type: 'code_generated',
        code: room.id,
        roomId: room.id,
      });
    });

    it('senderがjoin_roomすると双方にpeer_joinedが届く', () => {
      const { receiver, sender } = createPairedRoom();

      expect(receivedOfType(receiver, 'peer_joined')).toHaveLength(1);
      expect(receivedOfType(sender, 'peer_joined')).toEqual([
        expect.objectContaining({ peerId: sender.id, role: 'sender' }),
      ]);
    });

    it('receiverのwebrtc_offerがfromPeerId付きでsenderに届く', () => {
      const { receiver, sender, send } = createPairedRoom();

      send(receiver, {
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

    it('senderのwebrtc_answerがreceiverに届く', () => {
      const { receiver, sender, send } = createPairedRoom();

      send(sender, {
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

    it('ice_candidateが双方向に中継される', () => {
      const { receiver, sender, send } = createPairedRoom();

      send(receiver, {
        type: 'ice_candidate',
        targetPeerId: sender.id,
        candidate: 'from-receiver',
      });
      send(sender, {
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

    it('transfer_statusが相手にpeer_statusとして届く', () => {
      const { receiver, sender, send } = createPairedRoom();

      send(sender, {
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
    it('JSONとして不正な文字列でも例外を投げずINVALID_MESSAGEを返す', () => {
      const { connect, sendRaw } = createHarness();
      const conn = connect('peer');

      expect(() => sendRaw(conn, '{ not json')).not.toThrow();
      expect(lastMessage(conn)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('nullを渡しても例外を投げずINVALID_MESSAGEを返す', () => {
      const { connect, sendRaw } = createHarness();
      const conn = connect('peer');

      expect(() => sendRaw(conn, 'null')).not.toThrow();
      expect(lastMessage(conn)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('配列を渡してもINVALID_MESSAGEを返す', () => {
      const { connect, send } = createHarness();
      const conn = connect('peer');

      expect(() => send(conn, ['webrtc_offer'])).not.toThrow();
      expect(lastMessage(conn)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('typeが無いオブジェクトはINVALID_MESSAGEを返す', () => {
      const { connect, send } = createHarness();
      const conn = connect('peer');

      send(conn, { targetPeerId: 'someone', sdp: 'x' });

      expect(lastMessage(conn)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('未知のtypeはINVALID_MESSAGEを返す', () => {
      const { connect, send } = createHarness();
      const conn = connect('peer');

      send(conn, { type: 'definitely_unknown' });

      expect(lastMessage(conn)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('targetPeerIdやsdpが文字列でないwebrtc_offerは中継しない', () => {
      const { receiver, sender, send } = createPairedRoom();

      send(receiver, { type: 'webrtc_offer', targetPeerId: 123, sdp: 'x' });
      send(receiver, { type: 'webrtc_offer', targetPeerId: sender.id, sdp: { a: 1 } });

      expect(receivedOfType(sender, 'webrtc_offer')).toHaveLength(0);
      expect(receivedOfType(receiver, 'error')).toHaveLength(2);
    });

    it('上限を超えるsdpは中継せずINVALID_MESSAGEを返す', () => {
      const { receiver, sender, send } = createPairedRoom();

      send(receiver, {
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

    it('上限を超えるcandidateは中継せずINVALID_MESSAGEを返す', () => {
      const { receiver, sender, send } = createPairedRoom();

      send(receiver, {
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

    it('未知のstatusや非有限のprogressを持つtransfer_statusは拒否する', () => {
      const { receiver, sender, send } = createPairedRoom();

      send(sender, { type: 'transfer_status', status: 'hacking', progress: 1, speed: 1 });
      send(sender, {
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
    it('未参加の接続からのwebrtc_answerは中継しない', () => {
      const { room, server, connect, send } = createHarness();
      const receiver = connect('receiver');
      send(receiver, { type: 'generate_code' });

      // join_room も generate_code も経ていない接続
      const outsider = new FakeConnection(`${room.id}-outsider`);
      room.connections.push(outsider);
      server.onMessage(
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

    it('未参加の接続からのice_candidateは中継しない', () => {
      const { room, server, connect, send } = createHarness();
      const receiver = connect('receiver');
      send(receiver, { type: 'generate_code' });

      const outsider = new FakeConnection(`${room.id}-outsider`);
      room.connections.push(outsider);
      server.onMessage(
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

    it('未参加の接続からのtransfer_statusは中継しない', () => {
      const { room, server, connect, send } = createHarness();
      const receiver = connect('receiver');
      send(receiver, { type: 'generate_code' });

      const outsider = new FakeConnection(`${room.id}-outsider`);
      room.connections.push(outsider);
      server.onMessage(
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
    it('senderからのwebrtc_offerは中継しない（ロールが逆）', () => {
      const { receiver, sender, send } = createPairedRoom();

      send(sender, {
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

    it('receiverからのwebrtc_answerは中継しない（ロールが逆）', () => {
      const { receiver, sender, send } = createPairedRoom();

      send(receiver, {
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

    it('自分自身を宛先にしたメッセージは中継しない', () => {
      const { receiver, sender, send } = createPairedRoom();

      send(receiver, {
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

    it('未登録のtargetPeerId宛ては中継しない', () => {
      const { room, receiver, sender, send } = createPairedRoom();

      // ルームには接続しているが peers に登録されていない第三者
      const outsider = new FakeConnection(`${room.id}-outsider`);
      room.connections.push(outsider);

      send(receiver, {
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
    it('room.idと一致しないコードでは参加できない', () => {
      // 別ルームで有効なコードを発行する
      const other = createHarness();
      const otherReceiver = other.connect('receiver');
      other.send(otherReceiver, { type: 'generate_code' });

      const { connect, send } = createHarness();
      const receiver = connect('receiver');
      send(receiver, { type: 'generate_code' });

      const sender = connect('sender');
      send(sender, { type: 'join_room', code: other.room.id, role: 'sender' });

      expect(lastMessage(sender)).toMatchObject({
        type: 'error',
        code: 'INVALID_CODE',
      });
      expect(receivedOfType(receiver, 'peer_joined')).toHaveLength(0);
    });

    it('6桁でないコードはINVALID_MESSAGEで拒否する', () => {
      const { connect, send } = createHarness();
      const sender = connect('sender');

      send(sender, { type: 'join_room', code: '12', role: 'sender' });

      expect(lastMessage(sender)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('不正なroleはINVALID_MESSAGEで拒否する', () => {
      const { room, connect, send } = createHarness();
      const receiver = connect('receiver');
      send(receiver, { type: 'generate_code' });

      const sender = connect('sender');
      send(sender, { type: 'join_room', code: room.id, role: 'admin' });

      expect(lastMessage(sender)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('role=receiverでのjoin_roomは受け付けない', () => {
      const { room, connect, send } = createHarness();
      const receiver = connect('receiver');
      send(receiver, { type: 'generate_code' });

      const impostor = connect('impostor');
      send(impostor, { type: 'join_room', code: room.id, role: 'receiver' });

      expect(lastMessage(impostor)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });

    it('2人目のsenderはROOM_FULLで拒否する', () => {
      const { room, connect, send, sender } = createPairedRoom();

      const secondSender = connect('sender2');
      send(secondSender, { type: 'join_room', code: room.id, role: 'sender' });

      expect(lastMessage(secondSender)).toMatchObject({
        type: 'error',
        code: 'ROOM_FULL',
      });
      // 既存の sender には peer_joined が増えない
      expect(receivedOfType(sender, 'peer_joined')).toHaveLength(1);
    });
  });

  describe('generate_codeの検証', () => {
    it('receiverが既にいるルームでの2回目のgenerate_codeはROOM_FULLで拒否する', () => {
      const { connect, send } = createHarness();
      const receiver = connect('receiver');
      send(receiver, { type: 'generate_code' });

      const secondReceiver = connect('receiver2');
      send(secondReceiver, { type: 'generate_code' });

      expect(lastMessage(secondReceiver)).toMatchObject({
        type: 'error',
        code: 'ROOM_FULL',
      });
      expect(receivedOfType(secondReceiver, 'code_generated')).toHaveLength(0);
    });
  });

  describe('lock_connection', () => {
    it('他人のpeerIdを指定したlock_connectionは拒否する', () => {
      const { receiver, sender, send } = createPairedRoom();

      send(sender, { type: 'lock_connection', peerId: receiver.id });

      expect(receivedOfType(sender, 'connection_locked')).toHaveLength(0);
      expect(lastMessage(sender)).toMatchObject({
        type: 'error',
        code: 'NOT_AUTHORIZED',
      });
    });

    it('未参加の接続からのlock_connectionは拒否する', () => {
      const { room, server } = createPairedRoom();
      const outsider = new FakeConnection(`${room.id}-outsider`);
      room.connections.push(outsider);

      server.onMessage(
        JSON.stringify({ type: 'lock_connection', peerId: outsider.id }),
        outsider.asConnection()
      );

      expect(receivedOfType(outsider, 'connection_locked')).toHaveLength(0);
      expect(lastMessage(outsider)).toMatchObject({
        type: 'error',
        code: 'NOT_AUTHORIZED',
      });
    });

    it('自分自身のpeerIdならロックを発行する', () => {
      const { sender, send } = createPairedRoom();

      send(sender, { type: 'lock_connection', peerId: sender.id });

      expect(lastMessage(sender)).toMatchObject({ type: 'connection_locked' });
    });
  });

  describe('reconnect_with_lock', () => {
    it('ロックを消費してpeerを引き継ぎ、シグナリングを継続できる', () => {
      const { connect, send, receiver, sender } = createPairedRoom();

      send(sender, { type: 'lock_connection', peerId: sender.id });
      const locked = receivedOfType(sender, 'connection_locked')[0];
      expect(locked).toBeDefined();

      const reconnected = connect('sender-reconnected');
      send(reconnected, { type: 'reconnect_with_lock', lockId: locked.lockId });

      expect(receivedOfType(reconnected, 'peer_joined')).toEqual([
        expect.objectContaining({ peerId: reconnected.id, role: 'sender' }),
      ]);

      // 引き継いだ接続は sender として answer を中継できる
      send(reconnected, {
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
      send(sender, {
        type: 'webrtc_answer',
        targetPeerId: receiver.id,
        sdp: 'stale-answer',
      });
      expect(receivedOfType(receiver, 'webrtc_answer')).toHaveLength(1);

      // ロックは使い捨て
      const second = connect('sender-reconnected2');
      send(second, { type: 'reconnect_with_lock', lockId: locked.lockId });
      expect(lastMessage(second)).toMatchObject({
        type: 'error',
        code: 'LOCK_NOT_FOUND',
      });
    });

    it('切断後の再接続でもロールを引き継いで中継できる', () => {
      const { server, connect, send, receiver, sender } = createPairedRoom();

      send(sender, { type: 'lock_connection', peerId: sender.id });
      const locked = receivedOfType(sender, 'connection_locked')[0];

      // 実際の切断で peers から消える
      server.onClose(sender.asConnection());

      const reconnected = connect('sender-reconnected');
      send(reconnected, { type: 'reconnect_with_lock', lockId: locked.lockId });

      send(reconnected, {
        type: 'webrtc_answer',
        targetPeerId: receiver.id,
        sdp: 'answer-after-disconnect',
      });

      expect(receivedOfType(receiver, 'webrtc_answer')).toEqual([
        expect.objectContaining({ sdp: 'answer-after-disconnect' }),
      ]);
    });

    it('lockIdが文字列でない場合はINVALID_MESSAGEを返す', () => {
      const { connect, send } = createHarness();
      const conn = connect('peer');

      send(conn, { type: 'reconnect_with_lock', lockId: 42 });

      expect(lastMessage(conn)).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
    });
  });
});
