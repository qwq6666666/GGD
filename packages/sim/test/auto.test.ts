import { describe, expect, it } from 'vitest';
import type { Command } from '@ss/schema';
import { createWorld, isAutoPlanDay, planAuto, step, submitCommand, type AutoAction, type WorldState } from '../src/index.js';

/** 與網頁 Worker 相同的送出方式：每週規劃一次，之後每天最多送出一項。 */
function runAuto(w: WorldState, days: number): { accepted: number; rejected: Record<string, number>; queue: number } {
  let queue: AutoAction[] = [];
  let id = 1;
  let accepted = 0;
  const rejected: Record<string, number> = {};
  for (let d = 0; d < days; d++) {
    if (isAutoPlanDay(w.tick)) queue = planAuto(w);
    const a = queue.shift();
    if (a) submitCommand(w, { commandId: id++, issuedTick: w.tick, expectedWorldVersion: w.version, type: a.type, payload: a.payload } as Command);
    const r = step(w, { checkInvariants: w.tick % 30 === 0 });
    for (const c of r.commandResults) {
      if (c.status === 'rejected') rejected[c.reason] = (rejected[c.reason] ?? 0) + 1;
      else accepted++;
    }
  }
  return { accepted, rejected, queue: queue.length };
}

describe('電腦自動模式', () => {
  it('自動玩 6 年：守恆不破、人口存活、有實際行動且大多被接受', () => {
    for (const seed of [1, 2, 3]) {
      const w = createWorld(seed);
      const r = runAuto(w, 360 * 6);
      const total = r.accepted + Object.values(r.rejected).reduce((a, b) => a + b, 0);
      expect(w.npcs.length).toBeGreaterThan(8);
      expect(r.accepted).toBeGreaterThan(5);
      expect(r.accepted / total).toBeGreaterThan(0.7);
    }
  });

  it('自動模式會推動村級階段（至少升到「村」）', () => {
    let up = 0;
    for (const seed of [1, 2, 3, 4]) {
      const w = createWorld(seed);
      runAuto(w, 360 * 6);
      if (w.progress.stage >= 1) up++;
    }
    expect(up).toBeGreaterThanOrEqual(3);
  });

  it('決定性：同 seed 自動玩得到相同結果', () => {
    const a = createWorld(7);
    const b = createWorld(7);
    runAuto(a, 360 * 3);
    runAuto(b, 360 * 3);
    expect(a.progress).toEqual(b.progress);
    expect(a.npcs.length).toBe(b.npcs.length);
    expect(a.settlement.public.cash).toBe(b.settlement.public.cash);
  });

  it('不是領袖時不下建設命令（只會嘗試參選）', () => {
    const w = createWorld(5);
    w.leadership.mode = 1;
    w.leadership.nextElectionTick = -1;
    expect(planAuto(w)).toEqual([]);
  });
});
