import { CALIBRATION } from '@ss/content';
import type { Command, CommandResult } from '@ss/schema';
import { toDate } from './calendar.js';
import {
  aiLeaderRespond, applyPendingPolicies, computeSupport, generateProposals, handleLeaderGone, mintAtSeasonStart, payLeaderSalary, seasonalElectionCheck,
} from './civic.js';
import { applyCommand } from './commands.js';
import {
  adjustWages, decideFallow, dailyConsumption, dailyEmergency, dailyWork, enterpriseLabor, equipTools, harvestSeason, monthlySpoilage, refreshCommutes, runMarket,
  updateExpectedPrices, weeklyJobMatching, weeklyPayroll, weeklyRelief, winterFertility, householdStats,
} from './econ.js';
import { dailyEvents, forestGrowth, fuelMultiplier, monthlyMigration } from './events.js';
import { canonicalize } from './hash.js';
import { compactHistory, pushEvent } from './history.js';
import { compactLedger, totalGoods, totalMoney } from './ledger.js';
import { dailyDeaths, monthlyDemography, yearlyAging } from './npc.js';
import { chance65536 } from './prng.js';
import { dailyShipments, weeklyNodeRecovery } from './trade.js';
import type { WorldState } from './types.js';
import { NCOMM } from './types.js';
import { formatDate } from './calendar.js';

export { createWorld, SIM_VERSION } from './start.js';
export type { WorldState, SimEvent } from './types.js';

export function submitCommand(world: WorldState, command: Command): void {
  world.pendingCommands.push(command);
}

function compareCommands(a: Command, b: Command): number {
  return a.issuedTick - b.issuedTick || a.commandId - b.commandId;
}

/** 步驟 1：接收並排序玩家命令，校驗後套用。尚未到 issuedTick 的命令留到之後；過期命令拒絕。 */
function phaseCommands(world: WorldState): CommandResult[] {
  const due: Command[] = [];
  const later: Command[] = [];
  for (const c of world.pendingCommands) (c.issuedTick <= world.tick ? due : later).push(c);
  due.sort(compareCommands);
  world.pendingCommands = later;
  return due.map((cmd) => {
    // 命令必須在 issuedTick 當日套用，否則重播時套用日會不同，破壞決定性。
    if (cmd.issuedTick < world.tick) return { commandId: cmd.commandId, status: 'rejected', reason: 'late_command' } as CommandResult;
    if (cmd.expectedWorldVersion !== world.version) return { commandId: cmd.commandId, status: 'rejected', reason: 'stale_world_version' } as CommandResult;
    return applyCommand(world, cmd);
  });
}

function seasonSummaryText(w: WorldState): string {
  const d = toDate(w.tick);
  const names = ['春', '夏', '秋', '冬'];
  const S = w.settlement;
  const st = householdStats(w);
  const prices = ['糧', '木', '石', '工具', '家具'].map((n, i) => `${n}${S.prices[i]}`).join(' ');
  return `第${d.year}年${names[d.season]}季結束：收成 ${S.harvestFood}，人口 ${w.npcs.length}，支持度 ${w.leadership.support}，全村存糧約 ${st.foodDays} 日，物價 ${prices}`;
}

function weekly(w: WorldState): void {
  runMarket(w);
  weeklyPayroll(w);
  enterpriseLabor(w);
  refreshCommutes(w);
  weeklyJobMatching(w);
  adjustWages(w);
  weeklyRelief(w);
  weeklyNodeRecovery(w);
  generateProposals(w);
  if (w.leadership.mode === 1) aiLeaderRespond(w);
  for (const e of w.enterprises) {
    e.revenueWeek = 0;
    e.costWeek = 0;
  }
  for (const h of w.households) h.incomeWeek = 0;
}

function seasonEnd(w: WorldState): void {
  const d = toDate(w.tick);
  harvestSeason(w);
  forestGrowth(w);
  if (d.season === 3) winterFertility(w);
  updateExpectedPrices(w);
  computeSupport(w);
  seasonalElectionCheck(w);
  const text = seasonSummaryText(w);
  w.seasonSummary.push({ tick: w.tick, text });
  pushEvent(w, { type: 'SeasonEnded', importance: 1, causeIds: [], actorIds: [], summary: text, data: { rainDays: w.env.rainDaysThisSeason, harvest: w.settlement.harvestFood, support: w.leadership.support } });
  w.env.rainDaysThisSeason = 0;
  w.settlement.harvestFood = 0;
  w.settlement.reliefFoodSeason = 0;
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
  const w = world;
  const commandResults = phaseCommands(w); // 1
  const date = toDate(w.tick);
  // 2 環境與日曆
  if (date.dayOfSeason === 1) {
    applyPendingPolicies(w);
    mintAtSeasonStart(w);
    equipTools(w);
    decideFallow(w);
  }
  w.env.weather = chance65536(w.prng, CALIBRATION.weather.rainChance65536) ? 1 : 0;
  if (w.env.weather) w.env.rainDaysThisSeason++;
  dailyEvents(w);
  // 3 每日需求與緊急行為
  refreshCommutes(w);
  dailyEmergency(w);
  // 4 生產與施工、在途貨物
  dailyWork(w);
  dailyShipments(w);
  // 5 消費與帳務
  const { starved } = dailyConsumption(w, fuelMultiplier(w));
  dailyDeaths(w, starved);
  handleLeaderGone(w);
  // 6 週期觸發
  if (date.dayOfWeek === CALIBRATION.calendar.daysPerWeek) weekly(w);
  if (date.dayOfMonth === CALIBRATION.calendar.daysPerMonth) {
    payLeaderSalary(w);
    monthlySpoilage(w);
    monthlyDemography(w);
    monthlyMigration(w);
  }
  if (date.dayOfSeason === CALIBRATION.calendar.daysPerSeason) seasonEnd(w);
  if (date.dayOfYear === CALIBRATION.calendar.daysPerYear) {
    yearlyAging(w);
    handleLeaderGone(w);
    compactLedger(w, date.year);
    compactHistory(w, w.tick);
  }
  const tick = w.tick;
  w.tick++;
  if (opts.checkInvariants) checkInvariants(w); // 7
  return { tick, commandResults };
}

export function runDays(world: WorldState, days: number, opts: StepOptions = {}): StepResult[] {
  const out: StepResult[] = [];
  for (let i = 0; i < days; i++) out.push(step(world, opts));
  return out;
}

export class InvariantError extends Error {}

/** 守恆與一致性檢查（GDD 7.9、14）。 */
export function checkInvariants(w: WorldState, deep = w.tick % 30 === 0): void {
  if (deep) canonicalize(w); // 只含整數與純物件（較耗時，每 30 日一次）
  for (const v of w.prng) if (v < 0 || v > 0xffffffff) throw new InvariantError('prng state out of range');
  for (let i = 1; i < w.eventLog.length; i++) {
    if (w.eventLog[i]!.id <= w.eventLog[i - 1]!.id) throw new InvariantError('event log out of order');
  }
  const money = totalMoney(w);
  if (money !== w.settlement.moneySupply) throw new InvariantError(`money not conserved: ${money} vs ${w.settlement.moneySupply} (${formatDate(w.tick)})`);
  const goods = totalGoods(w);
  const st = w.stats;
  for (let c = 0; c < NCOMM; c++) {
    const expect = w.settlement.initialGoods[c]! + st.produced[c]! - st.consumed[c]! - st.spoiled[c]! + st.imported[c]! - st.exported[c]!;
    if (goods[c] !== expect) throw new InvariantError(`goods ${c} not conserved: ${goods[c]} vs ${expect} (${formatDate(w.tick)})`);
  }
  const hold = [w.settlement.public, ...w.households, ...w.enterprises];
  for (const h of hold) {
    if (h.cash < 0) throw new InvariantError('negative cash');
    for (let c = 0; c < NCOMM; c++) if (h.stock[c]! < 0) throw new InvariantError('negative stock');
  }
  const seen: number[] = [];
  for (const n of w.npcs) {
    if (seen.includes(n.id)) throw new InvariantError('duplicate npc');
    seen.push(n.id);
    if (n.jobKind === 1) {
      const e = w.enterprises.find((x) => x.id === n.jobId);
      if (!e || !e.employeeIds.includes(n.id)) throw new InvariantError(`npc ${n.id} job mismatch`);
    }
  }
  for (const e of w.enterprises) for (const id of e.employeeIds) {
    const n = w.npcs.find((x) => x.id === id);
    if (!n || n.jobKind !== 1 || n.jobId !== e.id) throw new InvariantError(`enterprise ${e.id} employee ${id} mismatch`);
  }
  for (const h of w.households) for (const id of h.memberIds) {
    const n = w.npcs.find((x) => x.id === id);
    if (!n || n.householdId !== h.id) throw new InvariantError(`household ${h.id} member ${id} mismatch`);
  }
}
