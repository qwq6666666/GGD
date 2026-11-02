import { MAX_IMPORT_BYTES, SaveFileSchema, type Command, type SaveFile } from '@ss/schema';
import { SIM_VERSION, canonicalize, hash64, type WorldState } from '@ss/sim';
import { SaveError } from './errors.js';
import { migrate, CURRENT_SCHEMA_VERSION } from './migrations.js';

export { SaveError };

function checksumOf(body: Omit<SaveFile, 'checksum'>): string {
  return hash64(canonicalize(body));
}

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

/** 解析與驗證存檔：大小限制 → JSON → 遷移 → schema → checksum。 */
export function parseSave(text: string): { save: SaveFile; world: WorldState } {
  if (text.length > MAX_IMPORT_BYTES) throw new SaveError('too_large', 'save exceeds size limit');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SaveError('bad_json', 'save is not valid JSON');
  }
  const migrated = migrate(raw);
  const parsed = SaveFileSchema.safeParse(migrated);
  if (!parsed.success) throw new SaveError('bad_schema', parsed.error.message);
  const { checksum, ...body } = parsed.data;
  if (checksumOf(body) !== checksum) throw new SaveError('bad_checksum', 'checksum mismatch');
  return { save: parsed.data, world: structuredClone(parsed.data.state) as WorldState };
}
