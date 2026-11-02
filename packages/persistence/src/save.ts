import { MAX_IMPORT_BYTES, SaveFileSchema, type Command, type SaveFile } from '@ss/schema';
import { SIM_VERSION, canonicalize, type WorldState } from '@ss/sim';
import { checksumOf } from './checksum.js';
import { SaveError } from './errors.js';
import { CURRENT_SCHEMA_VERSION, migrate } from './migrations.js';

export { SaveError };

/** 建立存檔（GDD 12.1）。commandLog 為已套用命令，供回放驗證。 */
export function createSave(world: WorldState, commandLog: Command[]): SaveFile {
  const body: Omit<SaveFile, 'checksum'> = {
    format: 'shengsheng-save',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    simVersion: SIM_VERSION,
    worldVersion: world.version,
    seed: world.seed,
    tick: world.tick,
    state: structuredClone(world),
    commandLog: structuredClone(commandLog),
  };
  return { ...body, checksum: checksumOf(body) };
}

export function serializeSave(save: SaveFile): string {
  return canonicalize(save);
}

export interface ParsedSave {
  save: SaveFile;
  world: WorldState;
  /** 載入時要提示玩家的事項（遷移、規則版本不同等）。 */
  warnings: string[];
}

/** 解析與驗證存檔：大小限制 → JSON → 檢查碼 → 遷移 → schema。 */
export function parseSave(text: string): ParsedSave {
  if (text.length > MAX_IMPORT_BYTES) throw new SaveError('too_large', 'save exceeds size limit');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SaveError('bad_json', 'save is not valid JSON');
  }
  const warnings: string[] = [];
  const ver = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).schemaVersion : undefined;
  if (typeof ver === 'number' && ver > CURRENT_SCHEMA_VERSION) throw new SaveError('unknown_version', `save schema ${ver} is newer than ${CURRENT_SCHEMA_VERSION}`);
  // 先驗證原檔的檢查碼（遷移前），再遷移並重算
  if (typeof raw === 'object' && raw !== null && typeof (raw as Record<string, unknown>).checksum === 'string') {
    const { checksum, ...body } = raw as Record<string, unknown>;
    let ok = false;
    try {
      ok = checksumOf(body) === checksum;
    } catch {
      ok = false;
    }
    if (!ok) throw new SaveError('bad_checksum', 'checksum mismatch');
  }
  const { save: migrated, from } = migrate(raw);
  let candidate = migrated;
  if (from < CURRENT_SCHEMA_VERSION && typeof migrated === 'object' && migrated !== null) {
    const { checksum: _old, migratedFrom: _m, ...body } = migrated as Record<string, unknown>;
    void _old;
    void _m;
    candidate = { ...body, checksum: checksumOf(body) };
    warnings.push(`存檔由舊版本（schema ${from}）遷移而來：聚落以相同種子重建並推進到相同日期，原有的人口與經濟細節無法保留。`);
  }
  const parsed = SaveFileSchema.safeParse(candidate);
  if (!parsed.success) throw new SaveError('bad_schema', parsed.error.message);
  if (parsed.data.simVersion !== SIM_VERSION) warnings.push(`存檔的規則版本（${parsed.data.simVersion}）與目前（${SIM_VERSION}）不同，無法保證重播一致。`);
  return { save: parsed.data, world: structuredClone(parsed.data.state) as WorldState, warnings };
}
