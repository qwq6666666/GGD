import { CALIBRATION } from '@ss/content';
import type { Command, CommandResult } from '@ss/schema';
import { isMonthEnd, isSeasonEnd, isWeekEnd, isYearEnd, toTick } from './calendar.js';
import { canonicalize } from './hash.js';
import { chance65536, seedPrng, type PrngState } from './prng.js';

/** 模擬邏輯版本；規則改變時遞增，存檔與重播會比對（GDD 11.3）。 */
export const SIM_VERSION = '0.1.0-a0';

export type Importance = 0 | 1 | 2 | 3;

/** 已提交的權威事件（GDD 9、附錄 A）。 */
export interface SimEvent {
  id: number;
  tick: number;
  type: string;
  actorIds: number[];
  causeIds: number[];
  importance: Importance;
  data: Record<string, number | string>;
}

/**
 * 權威世界狀態。必須是純 JSON（無 Map/Set/class/浮點數），以保證存檔與 hash 一致。
 * A0 只有骨架欄位；人口、經濟等於 A1/A2 依任務卡加入。
 */
export interface WorldState {
  id: string;
  seed: number;
  prng: PrngState;
  /** 已完成的日數；下一次 step 處理第 tick 日。 */
  tick: number;
  /** 世界版本：每個被接受且改變世界結構的命令 +1（用於 expectedWorldVersion）。 */
  version: number;
  leadership: {
    leaderId: number;
    playerHouseholdId: number;
    support: number;
    termStartTick: number;
    nextElectionTick: number;
  };
  env: {
    /** 0=晴 1=雨（A0 佔位） */
    weather: number;
    rainDaysThisSeason: number;
  };
  nextEventId: number;
  /** 等待處理的命令（依 issuedTick, commandId 排序後處理）。 */
  pendingCommands: Command[];
  eventLog: SimEvent[];
}

export function createWorld(seed: number): WorldState {
  const s = CALIBRATION.start;
  const tick = toTick(1, s.startSeason, s.startDayOfSeason);
  return {
    id: `world-${seed >>> 0}`,
    seed: seed >>> 0,
    prng: seedPrng(seed),
    tick,
    version: 0,
    leadership: {
      leaderId: 0,
      playerHouseholdId: 0,
      support: s.initialSupport,
      termStartTick: tick,
      nextElectionTick: -1,
    },
    env: { weather: 0, rainDaysThisSeason: 0 },
    nextEventId: 1,
    pendingCommands: [],
    eventLog: [],
  };
}

export function submitCommand(world: WorldState, command: Command): void {
  world.pendingCommands.push(command);
}

function compareCommands(a: Command, b: Command): number {
  return a.issuedTick - b.issuedTick || a.commandId - b.commandId;
}

function recordEvent(world: WorldState, e: Omit<SimEvent, 'id' | 'tick'>): SimEvent {
  const ev: SimEvent = { id: world.nextEventId++, tick: world.tick, ...e };
  world.eventLog.push(ev);
  return ev;
}

function applyCommand(world: WorldState, cmd: Command): CommandResult {
  // 命令必須在 issuedTick 當日套用，否則重播時套用日會不同，破壞決定性。
  if (cmd.issuedTick < world.tick) {
    return { commandId: cmd.commandId, status: 'rejected', reason: 'late_command' };
  }
  if (cmd.expectedWorldVersion !== world.version) {
    return { commandId: cmd.commandId, status: 'rejected', reason: 'stale_world_version' };
  }
  switch (cmd.type) {
    case 'Noop':
      return { commandId: cmd.commandId, status: 'accepted' };
    default:
      return { commandId: cmd.commandId, status: 'rejected', reason: 'not_implemented' };
  }
}

/** 步驟 1：接收並排序玩家命令，校驗後套用。尚未到 issuedTick 的命令留到之後；過期命令拒絕。 */
function phaseCommands(world: WorldState): CommandResult[] {
  const due: Command[] = [];
  const later: Command[] = [];
  for (const c of world.pendingCommands) (c.issuedTick <= world.tick ? due : later).push(c);
  due.sort(compareCommands);
  world.pendingCommands = later;
  return due.map((c) => applyCommand(world, c));
}

/** 步驟 2：環境與日曆更新（A0 佔位：天氣）。 */
function phaseEnvironment(world: WorldState): void {
  const rain = chance65536(world.prng, CALIBRATION.weather.rainChance65536);
  world.env.weather = rain ? 1 : 0;
  if (rain) world.env.rainDaysThisSeason++;
}

/** 步驟 6：週期觸發。 */
function phasePeriodic(world: WorldState): void {
  const t = world.tick;
  if (isWeekEnd(t)) {
    // 每週市場與 NPC 計畫（A2）
  }
  if (isMonthEnd(t)) {
    // 每月工資與遷徙（A2）
  }
  if (isSeasonEnd(t)) {
    recordEvent(world, {
      type: 'SeasonEnded',
      actorIds: [],
      causeIds: [],
      importance: 1,
      data: { rainDays: world.env.rainDaysThisSeason },
    });
    world.env.rainDaysThisSeason = 0;
  }
  if (isYearEnd(t)) {
    // 每年年齡與快照（B1）
  }
}

export interface StepResult {
  tick: number;
  commandResults: CommandResult[];
}

export interface StepOptions {
  /** debug／CI 模式下每日執行不變量檢查（GDD 3.1 步驟 7）。 */
  checkInvariants?: boolean;
}

/** 推進一日。依 GDD 3.1 的固定順序處理。會就地修改 world。 */
export function step(world: WorldState, opts: StepOptions = {}): StepResult {
  const commandResults = phaseCommands(world); // 1
  phaseEnvironment(world); // 2
  // 3 每日需求與緊急行為（A1）
  // 4 移動、生產與施工（A1/A2）
  // 5 消費與帳務（A2）
  phasePeriodic(world); // 6
  const tick = world.tick;
  world.tick++;
  if (opts.checkInvariants) checkInvariants(world); // 7
  return { tick, commandResults };
}

export function runDays(world: WorldState, days: number, opts: StepOptions = {}): StepResult[] {
  const out: StepResult[] = [];
  for (let i = 0; i < days; i++) out.push(step(world, opts));
  return out;
}

export class InvariantError extends Error {}

export function checkInvariants(world: WorldState): void {
  canonicalize(world); // 只含整數與純物件
  for (const v of world.prng) {
    if (v < 0 || v > 0xffffffff) throw new InvariantError('prng state out of range');
  }
  for (let i = 1; i < world.eventLog.length; i++) {
    const prev = world.eventLog[i - 1]!;
    const cur = world.eventLog[i]!;
    if (cur.id <= prev.id || cur.tick < prev.tick) throw new InvariantError('event log out of order');
  }
}
