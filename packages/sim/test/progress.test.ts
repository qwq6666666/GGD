import { describe, expect, it } from 'vitest';
import type { Command } from '@ss/schema';
import { GOALS } from '@ss/content';
import { createWorld, goalStatus, inBuildZone, runDays, step, submitCommand, updateProgress, type WorldState } from '../src/index.js';
import { addBuilding } from '../src/start.js';

const cmd = (w: WorldState, type: Command['type'], payload: Record<string, unknown>, id = 1): Command => ({ commandId: id, issuedTick: w.tick, expectedWorldVersion: w.version, type, payload });

describe('村級目標與階段（ADR-0007）', () => {
  it('開局為營地，可建區維持 48 格；目標有 3 項且尚未達成', () => {
    const w = createWorld(5);
    expect(w.progress).toEqual({ stage: 0, done: [] });
    expect(w.map.zmax - w.map.zmin).toBe(48);
    const g = goalStatus(w);
    expect(g.length).toBe(3);
    expect(g.every((x) => !x.done)).toBe(true);
  });

  it('達成任兩項目標即升階，可建區擴大，事件入史', () => {
    const w = createWorld(5);
    addBuilding(w, 'field', 28, 60, 1, 'active');
    expect(w.buildings.filter((b) => b.type === 'field').length).toBeGreaterThanOrEqual(4);
    updateProgress(w);
    expect(w.progress.stage).toBe(0);
    for (let i = 0; i < 25; i++) w.map.road[40 * w.map.w + 30 + i] = 1;
    updateProgress(w);
    expect(w.progress.stage).toBe(1);
    expect(w.map.zmax - w.map.zmin).toBe(GOALS.stages[1]!.zone);
    expect(inBuildZone(w.map, w.map.zmin, w.map.zmin)).toBe(true);
    expect(inBuildZone(w.map, w.map.zmin - 1, w.map.zmin)).toBe(false);
    expect(w.eventLog.some((e) => e.type === 'StageUp')).toBe(true);
    expect(w.eventLog.filter((e) => e.type === 'GoalDone').length).toBe(2);
  });

  it('已達成的目標不會因數值回落而取消', () => {
    const w = createWorld(5);
    w.map.road[40 * w.map.w + 30] = 1;
    for (let i = 0; i < 25; i++) w.map.road[40 * w.map.w + 30 + i] = 1;
    updateProgress(w);
    for (let i = 0; i < 25; i++) w.map.road[40 * w.map.w + 30 + i] = 0;
    expect(goalStatus(w).find((x) => x.id === 's0-road')!.done).toBe(true);
  });

  it('未解鎖的建築與道路被拒絕，原因為 locked', () => {
    const w = createWorld(5);
    submitCommand(w, cmd(w, 'PlaceBuilding', { type: 'school', x: 40, y: 40 }, 1));
    submitCommand(w, { ...cmd(w, 'BuildRoad', { mode: 'stone', tiles: [{ x: 1, y: 1 }] }, 2) });
    submitCommand(w, { ...cmd(w, 'ZoneLand', { x: 30, y: 30, w: 4, h: 4, kind: 1 }, 3) });
    const r = step(w).commandResults;
    expect(r.map((x) => (x.status === 'rejected' ? x.reason : 'ok'))).toEqual(['locked', 'locked', 'locked']);
  });

  it('階段與目標進度是決定性的：同 seed 同步數得到相同結果', () => {
    const a = createWorld(9);
    const b = createWorld(9);
    runDays(a, 400);
    runDays(b, 400);
    expect(a.progress).toEqual(b.progress);
  });
});
