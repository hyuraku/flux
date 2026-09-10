import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WebRTCConnection,
  BUFFERED_AMOUNT_HIGH_WATERMARK,
  BUFFERED_AMOUNT_LOW_WATERMARK,
} from './WebRTCConnection';
import { FakeDataChannel, createFakePeerConnection } from '../../test/fakeDataChannel';

/** マイクロタスクを消化して、待機が解決/継続したかを観測できる状態にする */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('WebRTCConnection 送信バックプレッシャ', () => {
  let channel: FakeDataChannel;
  let connection: WebRTCConnection;

  beforeEach(() => {
    channel = new FakeDataChannel();
    const pc = createFakePeerConnection(channel);

    vi.stubGlobal('RTCPeerConnection', vi.fn(() => pc));
    vi.stubGlobal('RTCSessionDescription', vi.fn((init: unknown) => init));
    vi.stubGlobal('RTCIceCandidate', vi.fn((init: unknown) => init));

    connection = new WebRTCConnection();
    connection.create({ initiator: true });
    channel.open();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('bufferedAmountLowThreshold', () => {
    it('自分で作ったデータチャネルに低水位が設定される', () => {
      expect(channel.bufferedAmountLowThreshold).toBe(BUFFERED_AMOUNT_LOW_WATERMARK);
    });

    it('相手から受け取ったデータチャネルにも低水位が設定される', () => {
      const remoteChannel = new FakeDataChannel();
      const pc = createFakePeerConnection(remoteChannel);
      vi.stubGlobal('RTCPeerConnection', vi.fn(() => pc));

      const receiver = new WebRTCConnection();
      receiver.create({ initiator: false });
      pc.ondatachannel?.({ channel: remoteChannel });

      expect(remoteChannel.bufferedAmountLowThreshold).toBe(BUFFERED_AMOUNT_LOW_WATERMARK);
    });

    it('低水位は高水位より小さい', () => {
      expect(BUFFERED_AMOUNT_LOW_WATERMARK).toBeLessThan(BUFFERED_AMOUNT_HIGH_WATERMARK);
    });
  });

  describe('sendWithBackpressure', () => {
    it('バッファが高水位未満なら待たずに送信する', async () => {
      channel.bufferedAmount = BUFFERED_AMOUNT_HIGH_WATERMARK - 1;

      await connection.sendWithBackpressure('payload');

      expect(channel.sent).toEqual(['payload']);
      expect(channel.listenerCount('bufferedamountlow')).toBe(0);
    });

    it('高水位以上なら待機し、bufferedamountlow で送信を再開する', async () => {
      channel.bufferedAmount = BUFFERED_AMOUNT_HIGH_WATERMARK;

      let settled = false;
      const sending = connection.sendWithBackpressure('payload').then(() => {
        settled = true;
      });

      await flushMicrotasks();
      expect(settled).toBe(false);
      expect(channel.sent).toHaveLength(0);
      expect(channel.listenerCount('bufferedamountlow')).toBe(1);

      // 低水位まで落として bufferedamountlow を発火させる
      channel.drain();
      await sending;

      expect(settled).toBe(true);
      expect(channel.sent).toEqual(['payload']);
      // リスナーは待機終了時に必ず外れる
      expect(channel.listenerCount('bufferedamountlow')).toBe(0);
    });

    it('イベント後も高水位以上ならもう一度待ち直す', async () => {
      channel.bufferedAmount = BUFFERED_AMOUNT_HIGH_WATERMARK;

      let settled = false;
      const sending = connection.sendWithBackpressure('payload').then(() => {
        settled = true;
      });
      await flushMicrotasks();

      // イベントは発火するが、再開前にまた高水位まで積まれた状況
      channel.drain();
      channel.bufferedAmount = BUFFERED_AMOUNT_HIGH_WATERMARK;
      await flushMicrotasks();

      expect(settled).toBe(false);
      expect(channel.sent).toHaveLength(0);
      expect(channel.listenerCount('bufferedamountlow')).toBe(1);

      channel.drain();
      await sending;

      expect(channel.sent).toEqual(['payload']);
      expect(channel.listenerCount('bufferedamountlow')).toBe(0);
    });

    it('チャネルが開いていなければ待たずに失敗する', async () => {
      channel.readyState = 'closed';
      channel.bufferedAmount = BUFFERED_AMOUNT_HIGH_WATERMARK;

      await expect(connection.sendWithBackpressure('payload')).rejects.toThrow(
        'Peer not connected'
      );
    });
  });

  describe('待機の解放', () => {
    function startBlockedSend(signal?: AbortSignal): Promise<void> {
      channel.bufferedAmount = BUFFERED_AMOUNT_HIGH_WATERMARK;
      return connection.sendWithBackpressure('payload', signal);
    }

    it('データチャネルが閉じたら待機が reject される', async () => {
      const sending = startBlockedSend();
      await flushMicrotasks();

      channel.close();

      await expect(sending).rejects.toThrow('Data channel closed');
      expect(channel.listenerCount('bufferedamountlow')).toBe(0);
    });

    it('データチャネルのエラーで待機が reject される', async () => {
      const sending = startBlockedSend();
      await flushMicrotasks();

      channel.fail(new Error('DataChannel exploded'));

      await expect(sending).rejects.toThrow('DataChannel exploded');
      expect(channel.listenerCount('bufferedamountlow')).toBe(0);
    });

    it('destroy() で待機が reject される', async () => {
      const sending = startBlockedSend();
      await flushMicrotasks();

      connection.destroy();

      await expect(sending).rejects.toThrow('Connection destroyed');
      expect(channel.listenerCount('bufferedamountlow')).toBe(0);
    });

    it('AbortSignal の abort で待機が reject される', async () => {
      const controller = new AbortController();
      const sending = startBlockedSend(controller.signal);
      await flushMicrotasks();

      controller.abort(new Error('Transfer stopped'));

      await expect(sending).rejects.toThrow('Transfer stopped');
      expect(channel.listenerCount('bufferedamountlow')).toBe(0);
    });

    it('すでに abort 済みの signal では待機に入らない', async () => {
      const controller = new AbortController();
      controller.abort(new Error('Transfer stopped'));

      await expect(startBlockedSend(controller.signal)).rejects.toThrow('Transfer stopped');
      expect(channel.listenerCount('bufferedamountlow')).toBe(0);
      expect(channel.sent).toHaveLength(0);
    });

    it('複数の待機がまとめて解放される', async () => {
      const first = startBlockedSend();
      const second = connection.sendWithBackpressure('second');
      await flushMicrotasks();

      expect(channel.listenerCount('bufferedamountlow')).toBe(2);

      connection.destroy();

      await expect(first).rejects.toThrow('Connection destroyed');
      await expect(second).rejects.toThrow('Connection destroyed');
      expect(channel.listenerCount('bufferedamountlow')).toBe(0);
    });
  });

  describe('既存の同期送信セマンティクス', () => {
    it('send はバッファ量に関係なく即座に送る', () => {
      channel.bufferedAmount = BUFFERED_AMOUNT_HIGH_WATERMARK * 4;

      connection.send('now');

      expect(channel.sent).toEqual(['now']);
    });

    it('16MB を超える単一メッセージは送信できない', () => {
      expect(() => connection.send(new Uint8Array(17 * 1024 * 1024))).toThrow('Data too large');
    });

    it('未接続なら send は例外を投げる', () => {
      channel.readyState = 'closed';

      expect(() => connection.send('x')).toThrow('Peer not connected');
    });
  });
});
