import { formatFileSize } from '../utils/validators';

interface TransferProgressProps {
  progress: number; // 0-100
  speed: number; // bytes per second
  eta: number; // seconds remaining
  bytesTransferred: number;
  totalBytes: number;
  fileName?: string;
  className?: string;
}

export function TransferProgress({
  progress,
  speed,
  eta,
  bytesTransferred,
  totalBytes,
  fileName,
  className = '',
}: TransferProgressProps) {
  const formatSpeed = (bytesPerSecond: number): string => {
    if (bytesPerSecond === 0) return '0 B/s';
    return `${formatFileSize(bytesPerSecond)}/s`;
  };

  const formatETA = (seconds: number): string => {
    if (seconds <= 0 || !isFinite(seconds)) return '--:--';

    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);

    if (mins > 60) {
      const hours = Math.floor(mins / 60);
      const remainingMins = mins % 60;
      return `${hours}h ${remainingMins}m`;
    }

    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Calculate circle properties for progress ring
  const radius = 88;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress / 100);

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Progress Ring */}
      <div className="relative w-48 h-48 mx-auto">
        <svg className="w-full h-full transform -rotate-90">
          {/* Background circle */}
          <circle
            cx="96"
            cy="96"
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="8"
          />
          {/* Progress circle */}
          <circle
            cx="96"
            cy="96"
            r={radius}
            fill="none"
            stroke="url(#progressGradient)"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            style={{ transition: 'stroke-dashoffset 0.3s ease-out' }}
          />
          <defs>
            <linearGradient id="progressGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#6366f1" />
              <stop offset="100%" stopColor="#22d3ee" />
            </linearGradient>
          </defs>
        </svg>

        {/* Percentage text */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-5xl font-bold text-white text-mono">
            {Math.round(progress)}%
          </span>
          {fileName && (
            <span className="text-xs text-muted mt-1 max-w-[120px] truncate">
              {fileName}
            </span>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="flex justify-center gap-8 text-sm">
        {/* Speed */}
        <div className="text-center">
          <div className="text-white font-medium">{formatSpeed(speed)}</div>
          <div className="text-dim text-xs">Speed</div>
        </div>

        {/* Progress */}
        <div className="text-center">
          <div className="text-white font-medium">
            {formatFileSize(bytesTransferred)} / {formatFileSize(totalBytes)}
          </div>
          <div className="text-dim text-xs">Transferred</div>
        </div>

        {/* ETA */}
        <div className="text-center">
          <div className="text-white font-medium">{formatETA(eta)}</div>
          <div className="text-dim text-xs">Remaining</div>
        </div>
      </div>

      {/* Linear progress bar (alternative view) */}
      <div className="w-full max-w-md mx-auto">
        <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-indigo-500 to-cyan-400 rounded-full transition-all duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// Compact inline progress bar
export function InlineProgress({ progress, className = '' }: { progress: number; className?: string }) {
  return (
    <div className={`h-1 bg-white/10 rounded-full overflow-hidden ${className}`}>
      <div
        className="h-full bg-gradient-to-r from-indigo-500 to-cyan-400 rounded-full transition-all duration-300 ease-out"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}
