import { SaveError } from './errors.js';

export const CURRENT_SCHEMA_VERSION = 1;

/**
 * schema 遷移表（GDD 12.1）：key 為來源版本，函式把存檔升一版。
 * 每新增一版都必須附遷移函式與測試。
 */
const MIGRATIONS: Record<number, (save: Record<string, unknown>) => Record<string, unknown>> = {};

export function migrate(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  let save = raw as Record<string, unknown>;
  if (typeof save.schemaVersion !== 'number') return raw;
  let v: number = save.schemaVersion;
  if (v > CURRENT_SCHEMA_VERSION) throw new SaveError('unknown_version', `save schema ${v} is newer than ${CURRENT_SCHEMA_VERSION}`);
  while (v < CURRENT_SCHEMA_VERSION) {
    const fn = MIGRATIONS[v];
    if (!fn) throw new SaveError('unknown_version', `no migration from schema ${v}`);
    save = fn(save);
    v = save.schemaVersion as number;
  }
  return save;
}
