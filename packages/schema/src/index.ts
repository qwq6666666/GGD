import { z } from 'zod';

/** 命令封包（GDD 11.2）。payload 依 type 區分；A0 只開放不改變世界規則的命令。 */
export const CommandBaseSchema = z.object({
  commandId: z.number().int().nonnegative(),
  expectedWorldVersion: z.number().int().nonnegative(),
  issuedTick: z.number().int().nonnegative(),
});

export const NoopCommandSchema = CommandBaseSchema.extend({
  type: z.literal('Noop'),
  payload: z.object({ note: z.string().max(200) }),
});

/** 命令名稱完整清單（GDD 11.2）；尚未實作者在模擬核心會以 not_implemented 拒絕。 */
export const COMMAND_TYPES = [
  'Noop',
  'BuildRoad',
  'PlaceBuilding',
  'ZoneLand',
  'SetPolicy',
  'FundProject',
  'RespondProposal',
  'FollowEntity',
  'SetPersonalChoice',
  'NominateHeir',
] as const;

export const GenericCommandSchema = CommandBaseSchema.extend({
  type: z.enum(COMMAND_TYPES),
  payload: z.record(z.unknown()),
});

export const CommandSchema = z.union([NoopCommandSchema, GenericCommandSchema]);
export type Command = z.infer<typeof CommandSchema>;

export type CommandResult =
  | { commandId: number; status: 'accepted' }
  | { commandId: number; status: 'rejected'; reason: string };

/** 存檔外框（GDD 12.1）。entityState 的內部結構由 sim 版本決定，遷移函式負責轉換。 */
export const SaveFileSchema = z.object({
  format: z.literal('shengsheng-save'),
  schemaVersion: z.number().int().positive(),
  simVersion: z.string(),
  worldVersion: z.number().int().nonnegative(),
  seed: z.number().int().nonnegative(),
  tick: z.number().int().nonnegative(),
  state: z.unknown(),
  commandLog: z.array(CommandSchema),
  checksum: z.string().regex(/^[0-9a-f]{16}$/),
});
export type SaveFile = z.infer<typeof SaveFileSchema>;

/** 匯入檔上限（GDD 13 安全）。 */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
