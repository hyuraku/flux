/**
 * 4桁の数字コード(0000-9999)を生成する
 * @returns 4桁の数字文字列
 */
export function generateCode(): string {
  const num = Math.floor(Math.random() * 10000);
  return num.toString().padStart(4, '0');
}

/**
 * コードが有効な4桁の数字かを検証する
 * @param code 検証するコード
 * @returns 有効な場合true
 */
export function validateCode(code: string): boolean {
  if (!code || typeof code !== 'string') {
    return false;
  }
  return /^\d{4}$/.test(code);
}
