import { describe, it, expect } from 'vitest';
import { generateCode, validateCode } from './codeGenerator';

describe('codeGenerator', () => {
  describe('generateCode', () => {
    it('6桁の数字コードを生成する', () => {
      const code = generateCode();
      expect(code).toMatch(/^\d{6}$/);
    });

    it('生成されるコードは000000から999999の範囲である', () => {
      const code = generateCode();
      const num = parseInt(code, 10);
      expect(num).toBeGreaterThanOrEqual(0);
      expect(num).toBeLessThanOrEqual(999999);
    });

    it('複数回呼び出すと異なるコードを生成する可能性がある', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 100; i++) {
        codes.add(generateCode());
      }
      // 100回で必ず複数の異なるコードが生成される
      expect(codes.size).toBeGreaterThan(1);
    });

    it('0埋めで6桁を保証する', () => {
      const code = generateCode();
      expect(code.length).toBe(6);
    });
  });

  describe('validateCode', () => {
    it('正しい6桁の数字コードはtrueを返す', () => {
      expect(validateCode('123456')).toBe(true);
      expect(validateCode('000000')).toBe(true);
      expect(validateCode('999999')).toBe(true);
      expect(validateCode('000001')).toBe(true);
    });

    it('6桁未満の数字はfalseを返す', () => {
      expect(validateCode('12345')).toBe(false);
      expect(validateCode('1234')).toBe(false);
      expect(validateCode('123')).toBe(false);
      expect(validateCode('')).toBe(false);
    });

    it('6桁より多い数字はfalseを返す', () => {
      expect(validateCode('1234567')).toBe(false);
      expect(validateCode('12345678')).toBe(false);
    });

    it('数字以外の文字を含むとfalseを返す', () => {
      expect(validateCode('12a456')).toBe(false);
      expect(validateCode('abcdef')).toBe(false);
      expect(validateCode('123-56')).toBe(false);
      expect(validateCode('123 56')).toBe(false);
    });

    it('nullまたはundefinedはfalseを返す', () => {
      expect(validateCode(null as any)).toBe(false);
      expect(validateCode(undefined as any)).toBe(false);
    });
  });
});
