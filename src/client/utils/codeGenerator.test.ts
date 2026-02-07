import { describe, it, expect } from 'vitest';
import { generateCode, validateCode } from './codeGenerator';

describe('codeGenerator', () => {
  describe('generateCode', () => {
    it('4桁の数字コードを生成する', () => {
      const code = generateCode();
      expect(code).toMatch(/^\d{4}$/);
    });

    it('生成されるコードは0000から9999の範囲である', () => {
      const code = generateCode();
      const num = parseInt(code, 10);
      expect(num).toBeGreaterThanOrEqual(0);
      expect(num).toBeLessThanOrEqual(9999);
    });

    it('複数回呼び出すと異なるコードを生成する可能性がある', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 100; i++) {
        codes.add(generateCode());
      }
      // 100回で必ず複数の異なるコードが生成される
      expect(codes.size).toBeGreaterThan(1);
    });

    it('0埋めで4桁を保証する', () => {
      const code = generateCode();
      expect(code.length).toBe(4);
    });
  });

  describe('validateCode', () => {
    it('正しい4桁の数字コードはtrueを返す', () => {
      expect(validateCode('1234')).toBe(true);
      expect(validateCode('0000')).toBe(true);
      expect(validateCode('9999')).toBe(true);
      expect(validateCode('0001')).toBe(true);
    });

    it('4桁未満の数字はfalseを返す', () => {
      expect(validateCode('123')).toBe(false);
      expect(validateCode('12')).toBe(false);
      expect(validateCode('1')).toBe(false);
      expect(validateCode('')).toBe(false);
    });

    it('4桁より多い数字はfalseを返す', () => {
      expect(validateCode('12345')).toBe(false);
      expect(validateCode('123456')).toBe(false);
    });

    it('数字以外の文字を含むとfalseを返す', () => {
      expect(validateCode('12a4')).toBe(false);
      expect(validateCode('abc4')).toBe(false);
      expect(validateCode('12-4')).toBe(false);
      expect(validateCode('12 4')).toBe(false);
    });

    it('nullまたはundefinedはfalseを返す', () => {
      expect(validateCode(null as any)).toBe(false);
      expect(validateCode(undefined as any)).toBe(false);
    });
  });
});
