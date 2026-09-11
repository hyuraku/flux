import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTransfer } from './useTransfer';

// TransferManager 本体はここでの関心事ではないので、初期化の成否だけ操作する
const mocks = vi.hoisted(() => {
  type EventHandler = (event: { type: string; data?: unknown }) => void;
  const handlers = new Map<string, EventHandler>();

  const instance = {
    on: vi.fn((event: string, handler: EventHandler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
    initializeAsReceiver: vi.fn().mockResolvedValue('123456'),
    initializeAsSender: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    cleanup: vi.fn(),
  };

  return { handlers, instance };
});

vi.mock('../core/transfer/TransferManager', () => ({
  TransferManager: vi.fn(() => mocks.instance),
}));

describe('useTransfer の初期化失敗', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.instance.initializeAsReceiver.mockResolvedValue('123456');
    mocks.instance.initializeAsSender.mockResolvedValue(undefined);
  });

  it('受信の初期化が失敗したら status=error と error がセットされる', async () => {
    mocks.instance.initializeAsReceiver.mockRejectedValueOnce(new Error('offline'));

    const { result } = renderHook(() => useTransfer());

    await act(async () => {
      await expect(result.current.initializeAsReceiver()).rejects.toThrow('offline');
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('offline');
  });

  it('送信の初期化が失敗したら status=error と error がセットされる', async () => {
    mocks.instance.initializeAsSender.mockRejectedValueOnce(new Error('room is full'));

    const { result } = renderHook(() => useTransfer());

    await act(async () => {
      await expect(
        result.current.initializeAsSender('123456', [new File(['a'], 'a.txt')])
      ).rejects.toThrow('room is full');
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('room is full');
  });

  it('error イベントと catch の両方が走っても結果は変わらない（冪等）', async () => {
    mocks.instance.initializeAsReceiver.mockImplementationOnce(() => {
      mocks.handlers.get('error')?.({ type: 'error', data: { message: 'offline' } });
      return Promise.reject(new Error('offline'));
    });

    const { result } = renderHook(() => useTransfer());

    await act(async () => {
      await expect(result.current.initializeAsReceiver()).rejects.toThrow('offline');
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('offline');
  });

  it('初期化が成功すればコードが返り error は立たない', async () => {
    const { result } = renderHook(() => useTransfer());

    await act(async () => {
      await expect(result.current.initializeAsReceiver()).resolves.toBe('123456');
    });

    expect(result.current.code).toBe('123456');
    expect(result.current.error).toBeNull();
    expect(result.current.status).not.toBe('error');
  });
});
