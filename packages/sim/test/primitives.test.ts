import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  fxMul,
  hash64,
  idiv,
  nextInt,
  nextU32,
  scale,
  seedPrng,
  toDate,
  toTick,
} from '../src/index.js';

describe('PRNG', () => {
  it('同 seed 產生相同序列，且輸出為 uint32', () => {
    const a = seedPrng(5);
    const b = seedPrng(5);
    for (let i = 0; i < 1000; i++) {
      const x = nextU32(a);
      expect(x).toBe(nextU32(b));
      expect(Number.isInteger(x) && x >= 0 && x <= 0xffffffff).toBe(true);
    }
  });

  it('序列固定（防止實作被無意改動而破壞舊存檔重播）', () => {
    const s = seedPrng(42);
    expect([nextU32(s), nextU32(s), nextU32(s)]).toMatchSnapshot();
  });

  it('nextInt 分布大致均勻', () => {
    const s = seedPrng(1);
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 60000; i++) counts[nextInt(s, 6)]!++;
    for (const c of counts) expect(Math.abs(c - 10000)).toBeLessThan(500);
  });
});

describe('定點數', () => {
  it('floor 捨入一致，含負數', () => {
    expect(idiv(7, 2)).toBe(3);
    expect(idiv(-7, 2)).toBe(-4);
    expect(fxMul(850, 840)).toBe(714);
    expect(scale(500, 2550)).toBe(1275);
  });
  it('拒絕非整數輸入', () => {
    expect(() => idiv(1.5, 1)).toThrow();
  });
});

describe('曆法（已鎖定：360/90/30/6）', () => {
  it('開局為春季第 60 日', () => {
    expect(toDate(toTick(1, 0, 60))).toMatchObject({ year: 1, season: 0, dayOfSeason: 60 });
  });
  it('週、月、季邊界對齊；第 6 日為休息日', () => {
    const lastOfSeason = toDate(toTick(1, 0, 90));
    expect(lastOfSeason).toMatchObject({ dayOfMonth: 30, dayOfWeek: 6, isRestDay: true, week: 15 });
    const lastOfYear = toDate(toTick(1, 3, 90));
    expect(lastOfYear).toMatchObject({ dayOfYear: 360, week: 60, month: 12 });
    expect(toDate(toTick(2, 0, 1))).toMatchObject({ year: 2, dayOfWeek: 1, week: 1 });
  });
});

describe('正規化與 hash', () => {
  it('鍵順序不影響結果', () => {
    expect(canonicalize({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(canonicalize({ a: [2, { c: 4, d: 3 }], b: 1 }));
  });
  it('拒絕浮點數與非純物件（狀態只含整數）', () => {
    expect(() => canonicalize({ x: 0.5 })).toThrow(/non-integer/);
    expect(() => canonicalize({ m: new Map() })).toThrow(/non-plain/);
  });
  it('hash 為 16 位十六進位且穩定', () => {
    expect(hash64('生生之境')).toMatch(/^[0-9a-f]{16}$/);
    expect(hash64('abc')).toBe(hash64('abc'));
    expect(hash64('abc')).not.toBe(hash64('abd'));
  });
});
