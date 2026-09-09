import type * as Party from 'partykit/server';
import type { RateLimitConfig } from './CodeManager';

/**
 * ルーム横断リミッター専用のルームID。
 *
 * ペアリングコードは6桁の数字（server.ts の CODE_PATTERN）なので、
 * このIDが転送ルームのIDと衝突することはない。
 * このルームは内部からの fetch（onRequest）専用で、
 * WebSocket 接続は受け付けない。
 */
export const RATE_LIMITER_ROOM_ID = '__rate_limiter__';

/**
 * リミッターのキーに許す最大長。
 * 長大なキーでリミッター側のメモリを膨らませられないよう切り詰める。
 */
export const MAX_RATE_LIMIT_KEY_LENGTH = 100;

/**
 * ルーム横断のしきい値。
 *
 * ローカル（接続IDキー、CodeManager の DEFAULT_RATE_LIMIT）より緩めにしてある。
 *
 * 緩める理由:
 * - キーが接続元IPなので、NAT・社内網・キャリアグレードNATの背後にいる
 *   無関係な利用者が同じキーを共有する。コードの打ち間違いや、
 *   相手の準備を待って何度か入れ直すといった正常な使い方で
 *   止まらない程度の余裕が要る。
 *
 * それでも列挙対策としては十分に効く:
 * - コード空間 10^6 に対し 30 試行/分では全走査に約23日かかる。
 * - コードの有効期限は5分なので、その間に踏める候補は最大150個
 *   （空間の約0.015%）にとどまる。
 * - さらに失敗が5分以内に10回たまると5分止まるので、
 *   総当たり時の実効レートは 10 試行 / 5分 まで落ちる
 *   （＝有効期限内に踏めるのは10個・約0.001%）。
 */
export const CROSS_ROOM_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60 * 1000, // 1分
  maxAttempts: 30,
  lockoutThreshold: 10,
  lockoutMs: 5 * 60 * 1000, // 5分
  failureWindowMs: 5 * 60 * 1000, // 5分以内の失敗だけを数える
};

/**
 * 接続元IPをヘッダから取り出す。
 *
 * `cf-connecting-ip` だけを見る。これは Cloudflare が付与するヘッダで、
 * クライアントからは詐称できない。本番（PartyKit = Cloudflare Workers）では
 * 必ず付くので、これで足りる。
 *
 * `x-forwarded-for` は**あえて見ない**。先頭の値はクライアントが自由に
 * 名乗れるため、フォールバックとして採用すると
 * - 毎回別のIPを名乗ってレート制限を無制限に回避する
 * - 他人のIPを名乗ってその利用者を巻き添えでロックアウトする
 * の両方の経路になる。取れないなら制限のキーとして使わない方が安全。
 *
 * 取れなければ null（`partykit dev` などヘッダの無い環境）。
 * 呼び出し側は接続IDにフォールバックする。
 */
export function extractClientIp(ctx?: Party.ConnectionContext): string | null {
  const headers = ctx?.request?.headers;
  if (!headers || typeof headers.get !== 'function') {
    return null;
  }

  return headers.get('cf-connecting-ip')?.trim() || null;
}

/**
 * リミッターのキーを正規化する（長さを切り詰めるだけ）。
 */
export function normalizeRateLimitKey(key: string): string {
  return key.slice(0, MAX_RATE_LIMIT_KEY_LENGTH);
}
