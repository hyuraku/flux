/**
 * 6桁の数字コード(000000-999999)を生成する
 * @returns 6桁の数字文字列
 */
export function generateCode(): string {
  const num = Math.floor(Math.random() * 1000000);
  return num.toString().padStart(6, '0');
}

/**
 * コードが有効な6桁の数字かを検証する
 * @param code 検証するコード
 * @returns 有効な場合true
 */
export function validateCode(code: string): boolean {
  if (!code || typeof code !== 'string') {
    return false;
  }
  return /^\d{6}$/.test(code);
}
