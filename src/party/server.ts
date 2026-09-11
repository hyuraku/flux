import type * as Party from 'partykit/server';
import { CodeManager } from './CodeManager';
import {
  CROSS_ROOM_RATE_LIMIT,
  RATE_LIMITER_ROOM_ID,
  extractClientIp,
  normalizeRateLimitKey,
} from './rateLimit';
import type {
  ServerMessage,
  ErrorCode,
  Role,
  ConnectionLock,
  TransferStatus,
  RateLimiterAction,
  RateLimiterRequest,
  RateLimiterResponse,
} from './types';

// グローバルCodeManager（全ルーム共有）
const codeManager = new CodeManager();

/**
 * ルーム横断のペアリング試行リミッター。
 *
 * このインスタンスを触るのは RATE_LIMITER_ROOM_ID のルームだけ（onRequest 経由）。
 * PartyKit はペアリングコードごとに別ルーム＝別インスタンスになるため、
 * 転送ルームのローカルな Map ではルームを跨いだコード列挙を止められない。
 * 全ルームからの判定を1つの予約ルームに集約することで、
 * 接続を張り直しても・ルームを変えても同じ接続元は同じ枠を消費する。
 *
 * 集約する以上このインスタンスには全ルーム分のキーが集まるので、
 * state の上限・掃除は CodeManager 側で面倒を見ている
 * （DEFAULT_MAX_TRACKED_KEYS / DEFAULT_SWEEP_INTERVAL_MS）。
 */
const crossRoomLimiter = new CodeManager(CROSS_ROOM_RATE_LIMIT);

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

/**
 * リクエストがクライアント（インターネット側）から来たものかどうか。
 *
 * 本番では Cloudflare が cf-connecting-ip を必ず付ける。ルーム間の内部fetchは
 * server.ts が組み立てた Request なのでこれらのヘッダを持たない。
 *
 * 注意: `partykit dev` はローカルの外部リクエストにもこれらを付けないため、
 * この判定が効くのは Cloudflare 上（本番）だけ。
 */
function isExternallyOriginated(req: Party.Request): boolean {
  return (
    req.headers.get('cf-connecting-ip') !== null ||
    req.headers.get('x-forwarded-for') !== null
  );
}

function jsonResponse(body: RateLimiterResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default class TransferServer implements Party.Server {
  private peers: Map<string, PeerInfo> = new Map();
  private locks: Map<string, ConnectionLock> = new Map();
  // 接続ID → ルーム横断レート制限のキー（接続元IP、取れなければ接続ID）
  private rateLimitKeys: Map<string, string> = new Map();
  // IPヘッダ欠落の警告はルームにつき1回だけ（接続ごとに出すとログが埋まる）
  private warnedMissingClientIp = false;

  constructor(readonly room: Party.Room) {}

  onConnect(conn: Party.Connection, ctx?: Party.ConnectionContext) {
    const roomId = this.room.id;

    // リミッタールームは内部fetch専用。WebSocketは受け付けない。
    if (this.isRateLimiterRoom()) {
      conn.close();
      return;
    }

    console.log(`[${roomId}] Peer connected: ${conn.id}`);

    // レート制限のキーになる接続元IPを接続時に確保しておく
    // （onMessage には ConnectionContext が渡ってこないため）
    const clientIp = extractClientIp(ctx);
    if (clientIp === null && !this.warnedMissingClientIp) {
      // partykit dev などIPヘッダの無い環境。接続IDで代用するため
      // ルーム横断の制限は事実上効かない（張り直せば別キーになる）。
      this.warnedMissingClientIp = true;
      console.warn(
        `[${roomId}] No client IP header; falling back to connection id for cross-room rate limiting`
      );
    }
    this.rateLimitKeys.set(conn.id, normalizeRateLimitKey(clientIp ?? conn.id));

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

    this.rateLimitKeys.delete(conn.id);

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

  async onMessage(message: string, sender: Party.Connection) {
    // リミッタールームはシグナリングを一切扱わない
    if (this.isRateLimiterRoom()) {
      sender.close();
      return;
    }

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

    // ローカル（このルーム限定）のレート制限キー。
    // 接続IDなので張り直しで回避できるが、多重防御として残している。
    const localRateKey = sender.id;
    // ルーム横断のレート制限キー（接続元IP、取れなければ接続ID）
    const crossRoomRateKey = this.rateLimitKeys.get(sender.id) ?? sender.id;

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
        await this.handleJoinRoom(
          sender,
          data.code,
          'sender',
          localRateKey,
          crossRoomRateKey
        );
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
   * HTTPリクエスト。
   *
   * リミッタールーム（RATE_LIMITER_ROOM_ID）だけが、他のルームからの
   * レート制限判定リクエストを受け付ける。他のルームでは 404 を返す。
   */
  async onRequest(req: Party.Request): Promise<Response> {
    if (!this.isRateLimiterRoom()) {
      return new Response('Not found', { status: 404 });
    }

    // PartyKit のルームURLは公開されているので、外から直接叩かれると
    // 任意のIPをロックアウトさせたり（record_failure）、自分のロックアウトを
    // 解除したり（record_success）できてしまう。
    // 転送ルームからの内部fetchは自分で組み立てた Request なので
    // cf-connecting-ip / x-forwarded-for を持たない。
    // 一方 Cloudflare 経由の外部リクエストには必ず cf-connecting-ip が付く。
    if (isExternallyOriginated(req)) {
      return new Response('Not found', { status: 404 });
    }

    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    if (
      !isRecord(body) ||
      typeof body.action !== 'string' ||
      !isNonEmptyString(body.key)
    ) {
      return new Response('Invalid request', { status: 400 });
    }

    const key = normalizeRateLimitKey(body.key);

    switch (body.action) {
      case 'check': {
        if (crossRoomLimiter.isLockedOut(key)) {
          return jsonResponse({ allowed: false, reason: 'locked_out' });
        }
        if (!crossRoomLimiter.checkRateLimit(key)) {
          return jsonResponse({ allowed: false, reason: 'rate_limited' });
        }
        crossRoomLimiter.recordAttempt(key);
        return jsonResponse({ allowed: true });
      }

      case 'record_failure': {
        crossRoomLimiter.recordFailedAttempt(key);
        return jsonResponse({ allowed: true });
      }

      case 'record_success': {
        crossRoomLimiter.recordSuccessfulAttempt(key);
        return jsonResponse({ allowed: true });
      }

      default:
        return new Response('Unknown action', { status: 400 });
    }
  }

  private isRateLimiterRoom(): boolean {
    return this.room.id === RATE_LIMITER_ROOM_ID;
  }

  /**
   * リミッタールームに判定を問い合わせる。
   *
   * フェイルモードは fail-open。リミッタールームに届かない・2xx が返らない場合は
   * null を返し、呼び出し側はローカル制限だけで参加を許可する。
   * シグナリングが落ちて誰もファイル転送できなくなるより、
   * 列挙対策が一時的に弱まる方がましだと判断した。
   * （fail-closed にするなら、ここで allowed:false を返す）
   */
  private async callRateLimiter(
    action: RateLimiterAction,
    key: string
  ): Promise<RateLimiterResponse | null> {
    const parties = this.room.context?.parties;
    const mainParty = parties?.main;

    if (!mainParty) {
      console.warn(
        '[rate-limiter] parties.main is unavailable; skipping cross-room rate limit'
      );
      return null;
    }

    const payload: RateLimiterRequest = { action, key };

    try {
      const response = await mainParty.get(RATE_LIMITER_ROOM_ID).fetch({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.warn(
          `[rate-limiter] ${action} responded ${response.status}; allowing the attempt`
        );
        return null;
      }

      return (await response.json()) as RateLimiterResponse;
    } catch (error) {
      console.warn(
        `[rate-limiter] ${action} request failed; allowing the attempt`,
        error
      );
      return null;
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
  private async handleJoinRoom(
    sender: Party.Connection,
    code: string,
    role: Role,
    localRateKey: string,
    crossRoomRateKey: string
  ) {
    // --- ローカル制限（接続IDキー、多重防御）---

    // ロックアウトチェック
    if (codeManager.isLockedOut(localRateKey)) {
      this.sendError(
        sender,
        'RATE_LIMITED',
        'Too many failed attempts. Please wait 5 minutes.'
      );
      return;
    }

    // レート制限チェック
    if (!codeManager.checkRateLimit(localRateKey)) {
      this.sendError(
        sender,
        'RATE_LIMITED',
        'Too many requests. Please wait a moment.'
      );
      return;
    }

    codeManager.recordAttempt(localRateKey);

    // --- ルーム横断制限（接続元IPキー）---
    // 接続の張り直しやルームの切り替えでは回避できない。
    const verdict = await this.callRateLimiter('check', crossRoomRateKey);
    if (verdict && !verdict.allowed) {
      this.sendError(
        sender,
        'RATE_LIMITED',
        verdict.reason === 'locked_out'
          ? 'Too many failed attempts. Please wait 5 minutes.'
          : 'Too many requests. Please wait a moment.'
      );
      return;
    }

    // コード検証
    // codeManager は全ルーム共有なので、別ルームで有効なコードでも
    // このルームには入れないよう room.id との一致も要求する。
    if (code !== this.room.id || !codeManager.validateCode(code)) {
      codeManager.recordFailedAttempt(localRateKey);
      await this.callRateLimiter('record_failure', crossRoomRateKey);
      this.sendError(sender, 'INVALID_CODE', 'Invalid or expired code');
      return;
    }

    // 成功
    codeManager.recordSuccessfulAttempt(localRateKey);
    await this.callRateLimiter('record_success', crossRoomRateKey);

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

    // ロックIDは reconnect_with_lock でそのまま接続の引き継ぎに使われるので、
    // 推測されると他人の接続を乗っ取られる。Math.random() や時刻を混ぜた文字列は
    // 予測可能なので、CSPRNG 由来の UUID を使う
    // （PartyKit = Cloudflare Workers / Node 19+ の両方で利用できる）。
    // 値をパースしている箇所は無いので接頭辞は付けない。
    const lockId = crypto.randomUUID();
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
