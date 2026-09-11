import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { App } from './App';
import type { UseTransferReturn } from './hooks/useTransfer';

// useTransfer の戻り値をテストから差し替えて、エラー画面だけを検証する
const transfer = vi.hoisted(() => {
  const state = {
    status: 'idle',
    progress: {
      status: 'idle',
      progress: 0,
      speed: 0,
      eta: 0,
      bytesTransferred: 0,
      totalBytes: 0,
    },
    code: null as string | null,
    error: null as string | null,
    receivedFiles: [] as File[],
    initializeAsReceiver: vi.fn().mockResolvedValue('123456'),
    initializeAsSender: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    reset: vi.fn(),
  };
  return { state };
});

vi.mock('./hooks/useTransfer', () => ({
  useTransfer: () => transfer.state as unknown as UseTransferReturn,
}));

vi.mock('file-saver', () => ({ saveAs: vi.fn() }));

describe('App のエラー表示と再試行', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transfer.state.status = 'idle';
    transfer.state.code = null;
    transfer.state.error = null;
    transfer.state.receivedFiles = [];
  });

  it('受信画面のエラーで再試行できる', async () => {
    const { rerender } = render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Receive files'));
    });
    expect(transfer.state.initializeAsReceiver).toHaveBeenCalledTimes(1);

    transfer.state.status = 'error';
    transfer.state.error = 'Could not connect to the signaling server';
    rerender(<App />);

    expect(screen.getByText('Connection failed')).toBeInTheDocument();
    // ConnectionStatus と再試行ブロックの両方に出る
    expect(
      screen.getAllByText('Could not connect to the signaling server').length
    ).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Try receiving again'));
    });

    expect(transfer.state.reset).toHaveBeenCalled();
    expect(transfer.state.initializeAsReceiver).toHaveBeenCalledTimes(2);
  });

  it('転送画面がエラーになると Transfer failed と再試行/戻るを出す', () => {
    transfer.state.status = 'transferring';
    const { rerender } = render(<App />);

    // transferring になると転送画面へ遷移する
    expect(screen.getByText('Transferring...')).toBeInTheDocument();

    transfer.state.status = 'error';
    transfer.state.error = 'Connection lost';
    rerender(<App />);

    expect(screen.getByText('Transfer failed')).toBeInTheDocument();
    expect(screen.getByText('Connection lost')).toBeInTheDocument();
    expect(screen.getByLabelText('Try the transfer again')).toBeInTheDocument();
    expect(screen.getByLabelText('Back to home')).toBeInTheDocument();
    expect(screen.queryByLabelText('Cancel transfer')).not.toBeInTheDocument();
  });
});
