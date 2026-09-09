import type * as Party from 'partykit/server';
import { CodeManager } from './CodeManager';
import type {
  ServerMessage,
  ErrorCode,
  Role,
  ConnectionLock,
  TransferStatus,
} from './types';

// グローバルCodeManager（全ルーム共有）
const codeManager = new CodeManager();

// ルーム内の接続情報
interface PeerInfo {
  connectionId: string;
  role: Role;
}

// ペアリングコードの形式（6桁の数字）
const CODE_PATTERN = /^\d{6}$/;

// 中継するシグナリングペイロードの上限
// （シグナリングサーバをメッセージ増幅に使われないようにする）
const MAX_SDP_BYTES = 64 * 1024;
const MAX_CANDIDATE_BYTES = 4 * 1024;

const TRANSFER_STATUSES: readonly TransferStatus[] = [
  'idle',
  'connecting',
  'transferring',
  'completed',
  'error',
];

/**
 * JSON.parse の結果がプレーンなオブジェクトか
 * （null・配列・プリミティブを弾く）
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export default class TransferServer implements Party.Server {
  private peers: Map<string, PeerInfo> = new Map();
  private locks: Map<string, ConnectionLock> = new Map();

  constructor(readonly room: Party.Room) {}

  onConnect(conn: Party.Connection) {
    const roomId = this.room.id;
    console.log(`[${roomId}] Peer connected: ${conn.id}`);

    // ルーム内のピア数制限（最大2）
    const connectionCount = [...this.room.getConnections()].length;
    if (connectionCount > 2) {
      this.sendError(conn, 'ROOM_FULL', 'This transfer room is full');
      conn.close();
      return;
    }
  }

  onClose(conn: Party.Connection) {
    const roomId = this.room.id;
    console.log(`[${roomId}] Peer disconnected: ${conn.id}`);

    const peer = this.peers.get(conn.id);
    if (peer) {
      // 相手にdisconnect通知
      this.broadcastExcept(conn.id, {
        type: 'error',
        code: 'PEER_DISCONNECTED',
        message: `${peer.role} has disconnected`,
      });

      this.peers.delete(conn.id);
    }

    // ルームが空になったらコードを無効化
    if (this.peers.size === 0) {
      codeManager.expireCode(roomId);
    }
  }

  onMessage(message: string, sender: Party.Connection) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(message);
    } catch {
      this.sendError(sender, 'INVALID_MESSAGE', 'Invalid message format');
      return;
    }

    // 型注釈だけではランタイムの入力を守れない。
    // null・配列・プリミティブ・type 欠落はここで弾く。
    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      this.sendError(sender, 'INVALID_MESSAGE', 'Invalid message format');
      return;
    }

    const data = parsed;

    // クライアントIPを取得（レート制限用）
    const clientIp = sender.id; // 本番ではX-Forwarded-Forなどから取得

    switch (data.type) {
      case 'generate_code':
        this.handleGenerateCode(sender);
        break;

      case 'join_room': {
        if (typeof data.code !== 'string' || !CODE_PATTERN.test(data.code)) {
          this.sendError(
            sender,
            'INVALID_MESSAGE',
            'join_room requires a 6-digit code'
          );
          return;
        }
        // receiver は generate_code で登録されるため、
        // join_room で受け付けるのは sender のみ。
        if (data.role !== 'sender') {
          this.sendError(
            sender,
            'INVALID_MESSAGE',
            "join_room requires role 'sender'"
          );
          return;
        }
        this.handleJoinRoom(sender, data.code, 'sender', clientIp);
        break;
      }

      case 'webrtc_offer':
      case 'webrtc_answer': {
        if (!isNonEmptyString(data.targetPeerId) || typeof data.sdp !== 'string') {
          this.sendError(
            sender,
            'INVALID_MESSAGE',
            `${data.type} requires targetPeerId and sdp strings`
          );
          return;
        }
        if (data.sdp.length > MAX_SDP_BYTES) {
          this.sendError(sender, 'INVALID_MESSAGE', 'sdp is too large');
          return;
        }
        // receiver が initiator（offer を出す側）、sender が answer を返す側。
        const requiredRole: Role = data.type === 'webrtc_offer' ? 'receiver' : 'sender';
        this.relayToPeer(sender, requiredRole, data.targetPeerId, data);
        break;
      }

      case 'ice_candidate': {
        if (
          !isNonEmptyString(data.targetPeerId) ||
          typeof data.candidate !== 'string'
        ) {
          this.sendError(
            sender,
            'INVALID_MESSAGE',
            'ice_candidate requires targetPeerId and candidate strings'
          );
          return;
        }
        if (data.candidate.length > MAX_CANDIDATE_BYTES) {
          this.sendError(sender, 'INVALID_MESSAGE', 'candidate is too large');
          return;
        }
        // ICE はどちらの向きにも流れるが、宛先は必ず逆ロールの相手。
        this.relayToPeer(sender, null, data.targetPeerId, data);
        break;
      }

      case 'lock_connection': {
        if (!isNonEmptyString(data.peerId)) {
          this.sendError(
            sender,
            'INVALID_MESSAGE',
            'lock_connection requires a peerId string'
          );
          return;
        }
        this.handleLockConnection(sender, data.peerId);
        break;
      }

      case 'reconnect_with_lock': {
        if (!isNonEmptyString(data.lockId)) {
          this.sendError(
            sender,
            'INVALID_MESSAGE',
            'reconnect_with_lock requires a lockId string'
          );
          return;
        }
        this.handleReconnectWithLock(sender, data.lockId);
        break;
      }

      case 'transfer_status': {
        if (
          typeof data.status !== 'string' ||
          !TRANSFER_STATUSES.includes(data.status as TransferStatus)
        ) {
          this.sendError(
            sender,
            'INVALID_MESSAGE',
            'transfer_status requires a known status'
          );
          return;
        }
        if (
          typeof data.progress !== 'number' ||
          !Number.isFinite(data.progress) ||
          typeof data.speed !== 'number' ||
          !Number.isFinite(data.speed)
        ) {
          this.sendError(
            sender,
            'INVALID_MESSAGE',
            'transfer_status requires finite progress and speed'
          );
          return;
        }
        if (!this.peers.has(sender.id)) {
          this.sendError(
            sender,
            'NOT_AUTHORIZED',
            'Join the room before sending transfer status'
          );
          return;
        }
        this.broadcastStatus(sender, {
          status: data.status as TransferStatus,
          progress: data.progress,
          speed: data.speed,
        });
        break;
      }

      default:
        this.sendError(sender, 'INVALID_MESSAGE', 'Unknown message type');
    }
  }

  /**
   * コード生成（Receiver用）
   */
  private handleGenerateCode(sender: Party.Connection) {
    const roomId = this.room.id;

    // 既に別の接続が receiver として登録済みなら乗っ取らせない
    // （同じ接続からの再送は冪等に扱う）
    const existingReceiver = this.findPeerIdByRole('receiver');
    if (existingReceiver !== undefined && existingReceiver !== sender.id) {
      this.sendError(sender, 'ROOM_FULL', 'This transfer room already has a receiver');
      return;
    }

    // このルームIDをコードとして登録
    codeManager.registerCode(roomId, sender.id);

    // Peerとして登録
    this.peers.set(sender.id, {
      connectionId: sender.id,
      role: 'receiver',
    });

    this.send(sender, {
      type: 'code_generated',
      code: roomId,
      roomId,
      timestamp: Date.now(),
    });
  }

  /**
   * ルーム参加（Sender用）
   */
  private handleJoinRoom(
    sender: Party.Connection,
    code: string,
    role: Role,
    clientIp: string
  ) {
    // ロックアウトチェック
    if (codeManager.isLockedOut(clientIp)) {
      this.sendError(
        sender,
        'RATE_LIMITED',
        'Too many failed attempts. Please wait 5 minutes.'
      );
      return;
    }

    // レート制限チェック
    if (!codeManager.checkRateLimit(clientIp)) {
      this.sendError(
        sender,
        'RATE_LIMITED',
        'Too many requests. Please wait a moment.'
      );
      return;
    }

    codeManager.recordAttempt(clientIp);

    // コード検証
    // codeManager は全ルーム共有なので、別ルームで有効なコードでも
    // このルームには入れないよう room.id との一致も要求する。
    if (code !== this.room.id || !codeManager.validateCode(code)) {
      codeManager.recordFailedAttempt(clientIp);
      this.sendError(sender, 'INVALID_CODE', 'Invalid or expired code');
      return;
    }

    // 成功
    codeManager.recordSuccessfulAttempt(clientIp);

    // 同じロールのピアが既にいるなら拒否（1ルーム = sender 1 + receiver 1）
    const existingPeerId = this.findPeerIdByRole(role);
    if (existingPeerId !== undefined && existingPeerId !== sender.id) {
      this.sendError(sender, 'ROOM_FULL', `This transfer room already has a ${role}`);
      return;
    }

    // Peerとして登録
    this.peers.set(sender.id, {
      connectionId: sender.id,
      role,
    });

    // 全員にpeer_joined通知
    const response: ServerMessage = {
      type: 'peer_joined',
      peerId: sender.id,
      role,
      timestamp: Date.now(),
    };

    this.room.broadcast(JSON.stringify(response));
  }

  /**
   * iOS用接続ロック
   */
  private handleLockConnection(sender: Party.Connection, peerId: string) {
    const peer = this.peers.get(sender.id);
    if (!peer) {
      this.sendError(
        sender,
        'NOT_AUTHORIZED',
        'Join the room before locking the connection'
      );
      return;
    }

    // 他人の peerId をロックして reconnect_with_lock で乗っ取られないよう、
    // 自分自身の id のロックだけを発行する。
    if (peerId !== sender.id) {
      this.sendError(
        sender,
        'NOT_AUTHORIZED',
        'Only your own connection can be locked'
      );
      return;
    }

    const lockId = `lock_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5分後

    this.locks.set(lockId, {
      lockId,
      peerId,
      role: peer.role,
      expiresAt,
    });

    this.send(sender, {
      type: 'connection_locked',
      lockId,
      expiresAt,
    });
  }

  /**
   * ロックIDで再接続
   */
  private handleReconnectWithLock(sender: Party.Connection, lockId: string) {
    const lock = this.locks.get(lockId);

    if (!lock) {
      this.sendError(sender, 'LOCK_NOT_FOUND', 'Lock not found');
      return;
    }

    if (Date.now() > lock.expiresAt) {
      this.locks.delete(lockId);
      this.sendError(sender, 'LOCK_EXPIRED', 'Lock has expired');
      return;
    }

    // ロックを消費
    this.locks.delete(lockId);

    // Peerとして再登録（前の接続情報を復元）
    const existingPeer = this.peers.get(lock.peerId);
    if (existingPeer) {
      this.peers.delete(lock.peerId);
      this.peers.set(sender.id, existingPeer);
    } else {
      // 切断で peers から消えている場合はロックに記録したロールで再登録する
      // （登録されていないと以降のシグナリングが中継されない）
      this.peers.set(sender.id, {
        connectionId: sender.id,
        role: lock.role || 'sender',
      });
    }

    // 再接続成功を通知
    this.send(sender, {
      type: 'peer_joined',
      peerId: sender.id,
      role: existingPeer?.role || lock.role || 'sender',
      timestamp: Date.now(),
    });
  }

  /**
   * 転送状態をブロードキャスト
   */
  private broadcastStatus(
    sender: Party.Connection,
    data: { status: TransferStatus; progress: number; speed: number }
  ) {
    this.broadcastExcept(sender.id, {
      type: 'peer_status',
      fromPeerId: sender.id,
      status: data.status,
      progress: data.progress,
      speed: data.speed,
    });
  }

  /**
   * ロールを指定して peers から1件探す
   */
  private findPeerIdByRole(role: Role): string | undefined {
    for (const [peerId, peer] of this.peers) {
      if (peer.role === role) {
        return peerId;
      }
    }
    return undefined;
  }

  /**
   * シグナリングメッセージの中継可否を判定して転送する。
   *
   * - 送信元がルームに参加済み（peers に登録済み）であること
   * - requiredFromRole が指定されていればそのロールであること
   * - 宛先が自分自身でなく、参加済みで、逆ロールであること
   *
   * 条件を満たさない場合は転送せず、送信元にだけエラーを返す。
   */
  private relayToPeer(
    sender: Party.Connection,
    requiredFromRole: Role | null,
    targetPeerId: string,
    payload: Record<string, unknown>
  ) {
    const fromPeer = this.peers.get(sender.id);
    if (!fromPeer) {
      this.sendError(sender, 'NOT_AUTHORIZED', 'Join the room before signaling');
      return;
    }

    if (requiredFromRole !== null && fromPeer.role !== requiredFromRole) {
      this.sendError(
        sender,
        'NOT_AUTHORIZED',
        `Only the ${requiredFromRole} may send ${String(payload.type)}`
      );
      return;
    }

    if (targetPeerId === sender.id) {
      this.sendError(sender, 'NOT_AUTHORIZED', 'Cannot signal yourself');
      return;
    }

    const targetPeer = this.peers.get(targetPeerId);
    if (!targetPeer) {
      this.sendError(sender, 'NOT_AUTHORIZED', 'Unknown target peer');
      return;
    }

    if (targetPeer.role === fromPeer.role) {
      this.sendError(
        sender,
        'NOT_AUTHORIZED',
        'Target peer must have the opposite role'
      );
      return;
    }

    this.forwardToTarget(targetPeerId, payload, sender.id);
  }

  /**
   * 特定のピアに検証済みメッセージを転送（送信元IDを追加）
   */
  private forwardToTarget(
    targetId: string,
    payload: Record<string, unknown>,
    fromPeerId: string
  ) {
    const connections = [...this.room.getConnections()];
    const target = connections.find((conn) => conn.id === targetId);

    if (target) {
      target.send(JSON.stringify({ ...payload, fromPeerId }));
    }
  }

  /**
   * メッセージ送信
   */
  private send(conn: Party.Connection, message: ServerMessage) {
    conn.send(JSON.stringify(message));
  }

  /**
   * エラー送信
   */
  private sendError(conn: Party.Connection, code: ErrorCode, message: string) {
    this.send(conn, { type: 'error', code, message });
  }

  /**
   * 特定のピア以外にブロードキャスト
   */
  private broadcastExcept(excludeId: string, message: ServerMessage) {
    const connections = [...this.room.getConnections()];
    for (const conn of connections) {
      if (conn.id !== excludeId) {
        this.send(conn, message);
      }
    }
  }
}
