/**
 * ペアリングコードは「誰がこの転送の端点になれるか」を決める唯一の
 * アクセス制御なので、予測可能な Math.random() ではなく CSPRNG
 * (crypto.getRandomValues) を用いる。
 */

const CODE_RANGE = 1_000_000; // 000000-999999

/**
 * 6桁の数字コード(000000-999999)を暗号学的乱数から生成する。
 *
 * 単純な `value % CODE_RANGE` は 2^32 が CODE_RANGE の倍数でないため
 * modulo bias（小さい値がわずかに出やすい偏り）を生む。棄却サンプリングで
 * 範囲を超えた値を捨てることで完全な一様分布を保証する。
 *
 * @returns 6桁の数字文字列
 */
export function generateCode(): string {
  // CODE_RANGE の倍数のうち 2^32 以下で最大のもの。これ以上の乱数は捨てる。
  const limit = Math.floor(0xffffffff / CODE_RANGE) * CODE_RANGE;
  const buffer = new Uint32Array(1);

  let value: number;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0];
  } while (value >= limit);

  return (value % CODE_RANGE).toString().padStart(6, '0');
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
