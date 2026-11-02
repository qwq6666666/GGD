import type { Command } from '@ss/schema';
import { addBuilding, createWorld, findSpot, formatDate, immigrate, runDays, stateHash, step, submitCommand } from '@ss/sim';
import { Autopilot } from './autopilot.js';
import { createSave, parseSave, serializeSave } from '@ss/persistence';

export interface ScenarioReport {
  name: string;
  ok: boolean;
  lines: string[];
}

/** 正常推進 N 年；記錄每日步進耗時（GDD 13）。 */
export function runGrowth(seed: number, years: number, now: () => number): ScenarioReport {
  const w = createWorld(seed);
  const days = years * 360;
  const times: number[] = [];
  for (let i = 0; i < days; i++) {
    const t0 = now();
    step(w, { checkInvariants: w.tick % 30 === 0 });
    times.push(now() - t0);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
  return {
    name: `growth-${years}y`,
    ok: true,
    lines: [
      `seed=${seed} end=${formatDate(w.tick)} hash=${stateHash(w)}`,
      `events=${w.eventLog.length} stepP95=${p95.toFixed(3)}ms`,
    ],
  };
}

/** 存檔回放：同 seed＋命令序列＋版本 → 相同 hash；存讀後續跑也相同。 */
export function runReplay(seed: number): ScenarioReport {
  const live = createWorld(seed);
  const log: Command[] = [];
  for (let i = 0; i < 24; i++) {
    const c: Command = {
      commandId: i + 1,
      issuedTick: live.tick,
      expectedWorldVersion: live.version,
      type: 'Noop',
      payload: { note: `replay-${i}` },
    };
    submitCommand(live, c);
    log.push(c);
    runDays(live, 45);
  }
  const text = serializeSave(createSave(live, log));
  const { save, world: loaded } = parseSave(text);

  const replay = createWorld(save.seed);
  for (const c of save.commandLog) submitCommand(replay, c);
  runDays(replay, save.tick - replay.tick);

  const liveHash = stateHash(live);
  runDays(live, 360);
  runDays(loaded, 360);
  const ok = stateHash(replay) === liveHash && stateHash(loaded) === stateHash(live);
  return {
    name: 'replay',
    ok,
    lines: [`replayHash=${stateHash(replay)} liveHash=${liveHash}`, `afterLoad=${stateHash(loaded)} saveBytes=${text.length}`],
  };
}

/** 速度一致性：不同批次大小推進到同 tick → 相同 hash。 */
export function runSpeed(seed: number): ScenarioReport {
  const hashes = [1, 2, 5].map((batch) => {
    const w = createWorld(seed);
    for (let d = 0; d < 360 * 3; d += batch) runDays(w, batch);
    return stateHash(w);
  });
  return { name: 'speed', ok: hashes.every((h) => h === hashes[0]), lines: [`hashes=${hashes.join(',')}`] };
}

/** 高速 N 年壓測（GDD 14）：無死循環、日誌有上限、存檔 < 20MB、單日步進時間。 */
export function runStress(seed: number, years: number, now: () => number): ScenarioReport {
  const w = createWorld(seed);
  const bot = new Autopilot();
  const times: number[] = [];
  for (let d = 0; d < years * 360; d++) {
    bot.act(w);
    const t0 = now();
    step(w, { checkInvariants: w.tick % 360 === 0 });
    times.push(now() - t0);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
  const max = times[times.length - 1] ?? 0;
  const bytes = serializeSave(createSave(w, [])).length;
  const ok = bytes < 20 * 1024 * 1024 && w.eventLog.length < 3000 && w.ledger.length < 6000 && p95 < 50;
  return {
    name: `stress-${years}y`,
    ok,
    lines: [`pop=${w.npcs.length} events=${w.eventLog.length} ledger=${w.ledger.length} saveKB=${Math.floor(bytes / 1024)}`, `stepP95=${p95.toFixed(3)}ms stepMax=${max.toFixed(2)}ms`],
  };
}

/** 200–500 人壓力測試（僅測試，非 V1 顯示量）：以大量住宅與遷入家庭放大聚落，量測單日步進。 */
export function runNpcStress(target: number, now: () => number): ScenarioReport {
  const w = createWorld(5);
  let guard = 0;
  while (w.npcs.length < target && guard++ < 400) {
    const spot = findSpot(w.map, w.buildings, 'publichome', 30 + ((guard * 7) % 36), 28 + ((guard * 11) % 40));
    if (!spot) break;
    addBuilding(w, 'publichome', spot.x, spot.y, 0, 'active');
    immigrate(w, true);
  }
  const times: number[] = [];
  for (let d = 0; d < 360; d++) {
    const t0 = now();
    step(w);
    times.push(now() - t0);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
  return { name: `npc-stress-${w.npcs.length}`, ok: p95 < 50, lines: [`pop=${w.npcs.length} stepP95=${p95.toFixed(2)}ms stepMax=${(times[times.length - 1] ?? 0).toFixed(2)}ms`] };
}
