import type * as Party from 'partykit/server';
import { CodeManager } from './CodeManager';
import type {
  ClientMessage,
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
    let data: ClientMessage;

    try {
      data = JSON.parse(message);
    } catch {
      this.sendError(sender, 'INVALID_CODE', 'Invalid message format');
      return;
    }

    // クライアントIPを取得（レート制限用）
    const clientIp = sender.id; // 本番ではX-Forwarded-Forなどから取得

    switch (data.type) {
      case 'generate_code':
        this.handleGenerateCode(sender);
        break;

      case 'join_room':
        this.handleJoinRoom(sender, data.code, data.role, clientIp);
        break;

      case 'webrtc_offer':
      case 'webrtc_answer':
      case 'ice_candidate':
        this.forwardToTarget(data.targetPeerId, message, sender.id);
        break;

      case 'lock_connection':
        this.handleLockConnection(sender, data.peerId);
        break;

      case 'reconnect_with_lock':
        this.handleReconnectWithLock(sender, data.lockId);
        break;

      case 'transfer_status':
        this.broadcastStatus(sender, data);
        break;

      default:
        this.sendError(sender, 'INVALID_CODE', 'Unknown message type');
    }
  }

  /**
   * コード生成（Receiver用）
   */
  private handleGenerateCode(sender: Party.Connection) {
    const roomId = this.room.id;

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
    if (!codeManager.validateCode(code)) {
      codeManager.recordFailedAttempt(clientIp);
      this.sendError(sender, 'INVALID_CODE', 'Invalid or expired code');
      return;
    }

    // 成功
    codeManager.recordSuccessfulAttempt(clientIp);

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
    const lockId = `lock_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5分後

    this.locks.set(lockId, {
      lockId,
      peerId,
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
    }

    // 再接続成功を通知
    this.send(sender, {
      type: 'peer_joined',
      peerId: sender.id,
      role: existingPeer?.role || 'sender',
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
   * 特定のピアにメッセージを転送（送信元IDを追加）
   */
  private forwardToTarget(targetId: string, message: string, fromPeerId?: string) {
    const connections = [...this.room.getConnections()];
    const target = connections.find((conn) => conn.id === targetId);

    if (target) {
      // Add fromPeerId to the message
      if (fromPeerId) {
        const parsed = JSON.parse(message);
        parsed.fromPeerId = fromPeerId;
        target.send(JSON.stringify(parsed));
      } else {
        target.send(message);
      }
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
