import type { Command } from '@ss/schema';
import { createWorld, formatDate, runDays, stateHash, step, submitCommand } from '@ss/sim';
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
