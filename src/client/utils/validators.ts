/**
 * validators.ts - バリデーション・サニタイズユーティリティ
 *
 * セキュリティ対策:
 * - 入力値の検証
 * - XSS対策
 * - ファイルタイプ検証
 */

// =====================================
// コード入力バリデーション
// =====================================

/**
 * 4桁コードの形式を検証
 */
export function isValidCode(code: string): boolean {
  if (typeof code !== 'string') {
    return false;
  }

  // 4桁の数字のみ許可
  return /^\d{4}$/.test(code);
}

/**
 * コード入力をサニタイズ（数字以外を除去）
 */
export function sanitizeCodeInput(input: string): string {
  return input.replace(/\D/g, '').slice(0, 4);
}

// =====================================
// ファイル検証
// =====================================

/**
 * 最大ファイルサイズ（2GB）
 */
export const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

/**
 * 圧縮を適用する最小サイズ（10KB）
 */
export const MIN_COMPRESSION_SIZE = 10 * 1024;

/**
 * 圧縮を適用する最大サイズ（100MB）
 */
export const MAX_COMPRESSION_SIZE = 100 * 1024 * 1024;

/**
 * 危険なファイル拡張子（実行可能ファイル等）
 * 注意: これはUIでの警告用。実際の転送は許可する
 */
export const DANGEROUS_EXTENSIONS = [
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.msi',
  '.scr',
  '.pif',
  '.application',
  '.gadget',
  '.hta',
  '.cpl',
  '.msc',
  '.jar',
  '.js',
  '.jse',
  '.ws',
  '.wsf',
  '.wsc',
  '.wsh',
  '.ps1',
  '.ps1xml',
  '.ps2',
  '.ps2xml',
  '.psc1',
  '.psc2',
  '.lnk',
  '.inf',
  '.reg',
  '.vb',
  '.vbe',
  '.vbs',
];

export interface FileValidationResult {
  valid: boolean;
  error?: string;
  warning?: string;
}

/**
 * ファイルを検証
 */
export function validateFile(file: File): FileValidationResult {
  // サイズチェック
  if (file.size === 0) {
    return { valid: false, error: 'ファイルが空です' };
  }

  if (file.size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `ファイルサイズが大きすぎます（最大: ${formatFileSize(MAX_FILE_SIZE)}）`,
    };
  }

  // 危険な拡張子の警告
  const extension = getFileExtension(file.name).toLowerCase();
  if (DANGEROUS_EXTENSIONS.includes(extension)) {
    return {
      valid: true,
      warning: `このファイル形式（${extension}）は実行可能ファイルの可能性があります。受信者は注意してください。`,
    };
  }

  return { valid: true };
}

/**
 * 複数ファイルを検証
 */
export function validateFiles(files: File[]): FileValidationResult {
  if (files.length === 0) {
    return { valid: false, error: 'ファイルが選択されていません' };
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `合計ファイルサイズが大きすぎます（最大: ${formatFileSize(MAX_FILE_SIZE)}）`,
    };
  }

  const warnings: string[] = [];
  for (const file of files) {
    const result = validateFile(file);
    if (!result.valid) {
      return result;
    }
    if (result.warning) {
      warnings.push(result.warning);
    }
  }

  if (warnings.length > 0) {
    return { valid: true, warning: warnings.join('\n') };
  }

  return { valid: true };
}

/**
 * 圧縮を適用すべきかどうか
 */
export function shouldCompress(fileSize: number): boolean {
  return fileSize >= MIN_COMPRESSION_SIZE && fileSize <= MAX_COMPRESSION_SIZE;
}

// =====================================
// XSS対策
// =====================================

/**
 * HTMLエスケープ
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * ファイル名をサニタイズ
 * - 危険な文字を除去
 * - パストラバーサル対策
 */
export function sanitizeFileName(name: string): string {
  // パス区切り文字を除去
  let sanitized = name.replace(/[/\\]/g, '_');

  // 制御文字を除去
  sanitized = sanitized.replace(/[\x00-\x1f\x7f]/g, '');

  // 先頭の . を除去（隠しファイル対策）
  sanitized = sanitized.replace(/^\.+/, '');

  // 予約語チェック（Windows）
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (reserved.test(sanitized.split('.')[0])) {
    sanitized = '_' + sanitized;
  }

  // 空の場合はデフォルト名
  if (!sanitized || sanitized.trim() === '') {
    sanitized = 'unnamed_file';
  }

  return sanitized;
}

// =====================================
// URL検証
// =====================================

/**
 * WebSocket URLを検証
 */
export function isValidWebSocketUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  } catch {
    return false;
  }
}

// =====================================
// ユーティリティ
// =====================================

/**
 * ファイル拡張子を取得
 */
export function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) {
    return '';
  }
  return filename.slice(lastDot);
}

/**
 * ファイルサイズをフォーマット
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
}

/**
 * 転送速度をフォーマット
 */
export function formatSpeed(bytesPerSecond: number): string {
  return formatFileSize(bytesPerSecond) + '/s';
}

/**
 * 残り時間を推定
 */
export function estimateRemainingTime(
  bytesRemaining: number,
  bytesPerSecond: number
): string {
  if (bytesPerSecond === 0) {
    return '計算中...';
  }

  const seconds = Math.ceil(bytesRemaining / bytesPerSecond);

  if (seconds < 60) {
    return `${seconds}秒`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes < 60) {
    return `${minutes}分${remainingSeconds}秒`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  return `${hours}時間${remainingMinutes}分`;
}
