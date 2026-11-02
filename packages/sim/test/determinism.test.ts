import { describe, expect, it } from 'vitest';
import type { Command } from '@ss/schema';
import { createWorld, runDays, stateHash, step, submitCommand } from '../src/index.js';

const noop = (commandId: number, issuedTick: number, expectedWorldVersion = 0): Command => ({
  commandId,
  issuedTick,
  expectedWorldVersion,
  type: 'Noop',
  payload: { note: `c${commandId}` },
});

describe('決定性（GDD 11.3、14 存檔回放／速度一致性）', () => {
  it('同 seed 推進同日數得到相同 hash', () => {
    const a = createWorld(42);
    const b = createWorld(42);
    runDays(a, 720);
    runDays(b, 720);
    expect(stateHash(a)).toBe(stateHash(b));
  });

  it('不同 seed 得到不同 hash', () => {
    const a = createWorld(1);
    const b = createWorld(2);
    runDays(a, 30);
    runDays(b, 30);
    expect(stateHash(a)).not.toBe(stateHash(b));
  });

  it('速度一致性：分批大小（模擬不同速度）不影響結果', () => {
    const a = createWorld(7);
    const b = createWorld(7);
    runDays(a, 400);
    for (let i = 0; i < 80; i++) runDays(b, 5);
    expect(stateHash(a)).toBe(stateHash(b));
  });

  it('命令依 (issuedTick, commandId) 排序，與提交順序無關', () => {
    const a = createWorld(9);
    const b = createWorld(9);
    const t = a.tick;
    const cmds = [noop(3, t), noop(1, t), noop(2, t + 1)];
    for (const c of cmds) submitCommand(a, c);
    for (const c of [...cmds].reverse()) submitCommand(b, c);
    const ra = runDays(a, 2).flatMap((r) => r.commandResults.map((x) => x.commandId));
    const rb = runDays(b, 2).flatMap((r) => r.commandResults.map((x) => x.commandId));
    expect(ra).toEqual([1, 3, 2]);
    expect(rb).toEqual(ra);
    expect(stateHash(a)).toBe(stateHash(b));
  });

  it('過期世界版本與過期 tick 的命令被拒絕且附原因', () => {
    const w = createWorld(3);
    submitCommand(w, noop(1, w.tick, 99));
    submitCommand(w, noop(2, w.tick - 1));
    const r = step(w).commandResults;
    expect(r).toEqual([
      { commandId: 2, status: 'rejected', reason: 'late_command' },
      { commandId: 1, status: 'rejected', reason: 'stale_world_version' },
    ]);
  });

  it('無效命令被拒絕並附原因，不改變世界版本', () => {
    const w = createWorld(3);
    submitCommand(w, { commandId: 1, issuedTick: w.tick, expectedWorldVersion: 0, type: 'BuildRoad', payload: {} });
    expect(step(w).commandResults[0]).toEqual({ commandId: 1, status: 'rejected', reason: 'invalid_target' });
    expect(w.version).toBe(0);
  });

  it('debug 模式下 3 年不變量檢查通過（貨幣與商品守恆）', () => {
    const w = createWorld(123);
    expect(() => runDays(w, 360 * 3, { checkInvariants: true })).not.toThrow();
  }, 60000);
});
