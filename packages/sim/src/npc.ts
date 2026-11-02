import { NAMES } from '@ss/content';
import { nextInt } from './prng.js';
import { transferGoods, transferMoney } from './ledger.js';
import { pushEvent } from './history.js';
import { releaseJob } from './econ.js';
import { FOOD, type Household, type Npc, type WorldState } from './types.js';
import { hhOf, insertSorted, npcOf, removeFrom } from './util.js';

/** 年齡別年死亡機率（千分比），查表。 */
const MORTALITY_PERMILLE: [number, number][] = [
  [1, 40], [5, 8], [15, 4], [40, 5], [50, 12], [60, 30], [70, 80], [80, 200], [200, 500],
];

function mortality(age: number): number {
  for (const [lim, p] of MORTALITY_PERMILLE) if (age < lim) return p;
  return 500;
}

export function livingMembers(w: WorldState, h: Household): Npc[] {
  const out: Npc[] = [];
  for (const id of h.memberIds) {
    const n = npcOf(w, id);
    if (n) out.push(n);
  }
  return out;
}

/** 死亡原子化處理：職缺釋出、家戶移除、關係清理、遺產與墓碑（GDD 5.3）。 */
export function killNpc(w: WorldState, n: Npc, cause: string): void {
  releaseJob(w, n, '死亡');
  const hh = hhOf(w, n.householdId);
  if (hh) removeFrom(hh.memberIds, n.id);
  const keyIds: number[] = [];
  const ev = pushEvent(w, {
    type: 'DeathRecorded',
    importance: n.id === w.leadership.leaderId || n.controller === 'player' ? 3 : 2,
    causeIds: [],
    actorIds: [n.id],
    summary: `${n.name}（${n.age} 歲）因${cause}逝世`,
    data: { cause, householdId: n.householdId },
  });
  keyIds.push(ev.id);
  w.tombstones.push({ id: n.id, name: n.name, birthTick: n.birthTick, deathTick: w.tick, householdId: n.householdId, keyEventIds: keyIds });
  for (const o of w.npcs) {
    if (o.spouseId === n.id) o.spouseId = 0;
    if (o.relations.some((r) => r.targetId === n.id)) o.relations = o.relations.filter((r) => r.targetId !== n.id);
  }
  const i = w.npcs.findIndex((x) => x.id === n.id);
  if (i >= 0) w.npcs.splice(i, 1);
  if (hh && hh.memberIds.length === 0) dissolveHousehold(w, hh);
}

/** 家戶無人：資產歸公共，名下企業轉公有（保留世界紀錄）。 */
function dissolveHousehold(w: WorldState, h: Household): void {
  if (h.cash > 0) transferMoney(w, 'h' + h.id, 'p', h.cash, 'escheat');
  for (let c = 0; c < 5; c++) if (h.stock[c]! > 0) transferGoods(w, 'h' + h.id, 'p', c, h.stock[c]!, 'escheat');
  for (const e of w.enterprises) if (e.ownerHouseholdId === h.id) e.ownerHouseholdId = 0;
  pushEvent(w, { type: 'HouseholdExtinct', importance: 2, causeIds: [], actorIds: [], summary: `${h.name} 已無成員`, data: { householdId: h.id } });
}

export function dailyDeaths(w: WorldState, starved: number[]): void {
  for (const id of starved) {
    const n = npcOf(w, id);
    if (n) killNpc(w, n, '飢餓');
  }
}

/** 重病：領袖年長時偶發，從重病到死亡至少 30 日（GDD 2.0.1）。 */
export function yearlyAging(w: WorldState): void {
  const toKill: Npc[] = [];
  for (const n of w.npcs) {
    n.age++;
    // 技能成長（遞減）
    if (n.lastSector >= 0) {
      const s = n.lastSector === 0 ? 0 : 1;
      n.skills[s] = Math.min(100, n.skills[s]! + Math.floor((100 - n.skills[s]!) / 15) + 1);
    }
    if (n.age >= 16 && n.age <= 60) n.skills[3] = Math.min(100, n.skills[3]! + 1);
    n.lastSector = -1;
    const p = mortality(n.age);
    const sick = n.age >= 55 && nextInt(w.prng, 1000) < Math.floor(p / 2);
    if (sick && n.illnessUntil <= w.tick) {
      n.illnessUntil = w.tick + 30 + nextInt(w.prng, 30);
      if (n.id === w.leadership.leaderId || n.controller === 'player') {
        pushEvent(w, { type: 'LeaderIll', importance: 3, causeIds: [], actorIds: [n.id], summary: `${n.name} 重病，請考慮指定繼承人`, data: {} });
      }
    }
  }
  // 死亡判定：以年死亡率抽籤；重病者死亡率加倍；領袖須先重病（V1 不設即死事件）
  for (const n of [...w.npcs]) {
    let p = mortality(n.age);
    const ill = n.illnessUntil > w.tick;
    if (ill) p *= 2;
    const isLeader = n.id === w.leadership.leaderId;
    if (isLeader && !ill) continue;
    if (nextInt(w.prng, 1000) < p) toKill.push(n);
  }
  for (const n of toKill) {
    const stillThere = npcOf(w, n.id);
    if (stillThere) killNpc(w, stillThere, stillThere.age >= 60 ? '年邁' : '疾病');
  }
  for (const h of w.households) {
    // 家具折舊
    const lose = Math.floor(h.stock[4]! / 5) + (h.stock[4]! % 5 > nextInt(w.prng, 5) ? 1 : 0);
    if (lose > 0) {
      h.stock[4]! -= Math.min(lose, h.stock[4]!);
      w.stats.consumed[4]! += Math.min(lose, h.stock[4]! + lose);
    }
  }
}

function newName(w: WorldState, surnameSeed: number): string {
  return NAMES.surnames[surnameSeed % NAMES.surnames.length]! + NAMES.given[nextInt(w.prng, NAMES.given.length)]!;
}

/** 每月：出生與婚配。出生率隨人均存糧與住房餘裕上升（GDD 5.5）。 */
export function monthlyDemography(w: WorldState): void {
  const totalFood = w.households.reduce((s, h) => s + h.stock[FOOD]!, 0);
  const pop = w.npcs.length;
  if (pop === 0) return;
  const perCap = Math.floor(totalFood / pop);
  const capacity = w.buildings.filter((b) => (b.type === 'home' || b.type === 'publichome') && b.state === 'active').reduce((s, b) => s + b.capacity, 0);
  const slack = capacity - pop;
  // 婚配：成年未婚、不同家戶、年齡相近、雙方同意（以效用與抽籤）
  const singles = w.npcs.filter((n) => n.age >= 18 && n.age <= 40 && n.spouseId === 0);
  for (const a of singles) {
    if (a.spouseId !== 0) continue;
    const cand = singles.find((b) => b.id > a.id && b.spouseId === 0 && b.sex !== a.sex && b.householdId !== a.householdId && Math.abs(b.age - a.age) <= 8 && a.relations.some((r) => r.targetId === b.id && r.trust >= 50));
    if (cand && nextInt(w.prng, 100) < 4) {
      a.spouseId = cand.id;
      cand.spouseId = a.id;
      a.relations.push({ targetId: cand.id, type: 0, trust: 70, lastInteraction: w.tick });
      cand.relations.push({ targetId: a.id, type: 0, trust: 70, lastInteraction: w.tick });
      // 女方遷入男方家戶（V1 簡化）
      const mover = a.sex === 1 ? a : cand;
      const stayer = mover === a ? cand : a;
      const from = hhOf(w, mover.householdId);
      const to = hhOf(w, stayer.householdId);
      if (from && to && to.memberIds.length < 8) {
        if (mover.jobKind === 1) releaseJob(w, mover, '婚後遷居');
        removeFrom(from.memberIds, mover.id);
        insertSorted(to.memberIds, mover.id);
        mover.householdId = to.id;
      }
      pushEvent(w, { type: 'MarriageRecorded', importance: a.controller === 'player' || cand.controller === 'player' ? 3 : 1, causeIds: [], actorIds: [a.id, cand.id], summary: `${a.name} 與 ${cand.name} 結為夫妻`, data: {} });
    }
  }
  // 出生
  const chance = perCap < 20 ? 0 : clamp1(10 + Math.floor(perCap / 4) + (slack > 0 ? 10 : -5), 0, 60);
  for (const n of w.npcs) {
    if (n.sex !== 1 || n.spouseId === 0 || n.age < 18 || n.age > 40) continue;
    const hh = hhOf(w, n.householdId);
    if (!hh || hh.memberIds.length >= 8) continue;
    if (nextInt(w.prng, 1000) < chance) {
      const id = w.nextIds.npc++;
      const child: Npc = {
        id,
        householdId: hh.id,
        name: newName(w, hh.id * 5),
        age: 0,
        birthTick: w.tick,
        sex: nextInt(w.prng, 2),
        health: 100,
        hunger: 0,
        energy: 80,
        mood: 70,
        skills: [5, 5, 5, 5],
        traits: [nextInt(w.prng, 3), 3 + nextInt(w.prng, 3)].sort((x, y) => x - y),
        riskPreference: 20 + nextInt(w.prng, 60),
        jobKind: 0, jobId: 0, jobSince: 0, cooldownUntil: 0, unemployedWeeks: 0, leisure: 0, commute: 0, equipped: 0, workDaysWeek: 0, arrears: 0, lastSector: -1,
        x: 0, y: 0, state: 0, reason: '', controller: n.controller, interestGroup: 3, satisfaction: 60, satisfactionBaseline: 60, lastFactor: 600,
        relations: [{ targetId: n.id, type: 0, trust: 90, lastInteraction: w.tick }],
        tags: [], spouseId: 0, parentIds: [n.id, n.spouseId], illnessUntil: 0,
      };
      w.npcs.push(child);
      hh.memberIds.push(id);
      hh.memberIds.sort((a, b) => a - b);
      n.relations.push({ targetId: id, type: 0, trust: 90, lastInteraction: w.tick });
      pushEvent(w, { type: 'BirthRecorded', importance: n.controller === 'player' ? 3 : 1, causeIds: [], actorIds: [id, n.id], summary: `${hh.name} 添了新成員 ${child.name}`, data: {} });
    }
  }
}

function clamp1(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 成年轉換：16 歲以上的孩子自然進入勞動市場（由 weeklyJobMatching 處理）。 */
export function adultsOf(w: WorldState, h: Household): Npc[] {
  return livingMembers(w, h).filter((n) => n.age >= 16 && n.age <= 55);
}

