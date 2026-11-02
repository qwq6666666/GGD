import { describe, expect, it } from 'vitest';
import { runGrowth, runReplay, runSpeed } from '../src/scenarios.js';

describe('headless 驗收情境（GDD 14）', () => {
  it('存檔回放', () => expect(runReplay(1).ok).toBe(true));
  it('速度一致性', () => expect(runSpeed(1).ok).toBe(true));
  it('正常成長 10 年（A0 骨架）', () => {
    let t = 0;
    expect(runGrowth(1, 10, () => t++).ok).toBe(true);
  }, 120000);
});
