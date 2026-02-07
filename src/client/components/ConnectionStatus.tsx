import type { ConnectionStatus as ConnectionStatusType } from '../hooks/useConnection';

interface ConnectionStatusProps {
  status: ConnectionStatusType;
  error?: string | null;
  className?: string;
}

export function ConnectionStatus({ status, error, className = '' }: ConnectionStatusProps) {
  const getStatusConfig = () => {
    switch (status) {
      case 'connected':
        return {
          color: 'bg-green-500',
          glow: 'shadow-green-500/50',
          text: 'Connected',
          icon: (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ),
        };
      case 'connecting':
        return {
          color: 'bg-yellow-500',
          glow: 'shadow-yellow-500/50',
          text: 'Connecting...',
          icon: (
            <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          ),
        };
      case 'error':
        return {
          color: 'bg-red-500',
          glow: 'shadow-red-500/50',
          text: error || 'Connection error',
          icon: (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          ),
        };
      default:
        return {
          color: 'bg-gray-500',
          glow: 'shadow-gray-500/50',
          text: 'Disconnected',
          icon: (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          ),
        };
    }
  };

  const config = getStatusConfig();

  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      {/* Status indicator dot */}
      <div className={`relative flex items-center justify-center`}>
        <div
          className={`w-2.5 h-2.5 rounded-full ${config.color} ${config.glow} shadow-lg`}
        />
        {status === 'connecting' && (
          <div
            className={`absolute inset-0 w-2.5 h-2.5 rounded-full ${config.color} animate-ping`}
          />
        )}
      </div>

      {/* Status text */}
      <span className="text-xs text-muted">{config.text}</span>
    </div>
  );
}

// Compact version for inline use
export function ConnectionIndicator({ status }: { status: ConnectionStatusType }) {
  const colors: Record<ConnectionStatusType, string> = {
    connected: 'bg-green-500 shadow-green-500/50',
    connecting: 'bg-yellow-500 shadow-yellow-500/50 animate-pulse',
    error: 'bg-red-500 shadow-red-500/50',
    disconnected: 'bg-gray-500',
  };

  return (
    <div
      className={`w-2 h-2 rounded-full ${colors[status]} shadow-sm`}
      title={status}
    />
  );
}
