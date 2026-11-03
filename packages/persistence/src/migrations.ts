import { createWorld, runDays } from '@ss/sim';
import { SaveError } from './errors.js';

/** 目前存檔 schema 版本。每新增一版都必須附遷移函式與測試（GDD 12.1）。 */
export const CURRENT_SCHEMA_VERSION = 3;

type Raw = Record<string, unknown>;

/**
 * 遷移表：key 為來源版本，函式把存檔升一版。
 * v1（A0 骨架，只含天氣的世界）→ v2（完整聚落）：舊世界沒有人口與經濟，無法逐欄轉換，
 * 因此以相同 seed 重建開局世界並推進到相同的日期；命令日誌清空。這是明示的資料損失，載入時會提示。
 */
const MIGRATIONS: Record<number, (save: Raw) => Raw> = {
  1: (save) => {
    const seed = typeof save.seed === 'number' ? save.seed : 0;
    const tick = typeof save.tick === 'number' ? save.tick : 59;
    const w = createWorld(seed, 0);
    if (tick > w.tick) runDays(w, tick - w.tick);
    return { ...save, schemaVersion: 2, worldVersion: w.version, tick: w.tick, state: w, commandLog: [], migratedFrom: 1 };
  },
  /** v2 → v3：補上村級階段（從營地起算，可建區維持原本 48 格）與地圖可建區欄位。不損失任何既有資料。 */
  2: (save) => {
    const state = (typeof save.state === 'object' && save.state !== null ? save.state : {}) as Raw;
    const map = (typeof state.map === 'object' && state.map !== null ? state.map : {}) as Raw;
    const next: Raw = { ...state, progress: state.progress ?? { stage: 0, done: [] }, map: { ...map, zmin: map.zmin ?? 24, zmax: map.zmax ?? 72 } };
    return { ...save, schemaVersion: 3, state: next };
  },
};

export function migrate(raw: unknown): { save: unknown; from: number } {
  if (typeof raw !== 'object' || raw === null) return { save: raw, from: CURRENT_SCHEMA_VERSION };
  let save = raw as Raw;
  if (typeof save.schemaVersion !== 'number') return { save: raw, from: CURRENT_SCHEMA_VERSION };
  const from: number = save.schemaVersion;
  let v = from;
  if (v > CURRENT_SCHEMA_VERSION) throw new SaveError('unknown_version', `save schema ${v} is newer than ${CURRENT_SCHEMA_VERSION}`);
  while (v < CURRENT_SCHEMA_VERSION) {
    const fn = MIGRATIONS[v];
    if (!fn) throw new SaveError('unknown_version', `no migration from schema ${v}`);
    save = fn(save);
    v = save.schemaVersion as number;
  }
  return { save, from };
}
