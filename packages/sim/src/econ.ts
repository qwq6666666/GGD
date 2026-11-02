import { ECON } from '@ss/content';
import { toDate } from './calendar.js';
import { clamp } from './fixed.js';
import { addProduced, consume, settleTrade, transferGoods, transferMoney } from './ledger.js';
import { inBounds, tileIdx } from './map.js';
import { commuteFx, pathCost } from './path.js';
import {
  ENT_KINDS,
  FOOD,
  FURN,
  NCOMM,
  OUTPUT_OF,
  STONE,
  TOOL,
  WOOD,
  type Building,
  type Enterprise,
  type Household,
  type Npc,
  type PublicWork,
  type WorldState,
} from './types.js';
import { bldOf, entOf, hhOf, isWorkAge, npcOf, removeFrom, sum } from './util.js';
import { pushEvent } from './history.js';
import { addEnterprise } from './start.js';

export const PUBLIC_SECTOR = 5;
export const sectorOf = (e: Enterprise): number => ENT_KINDS.indexOf(e.kind);
const skillFor = (sector: number): number => (sector === 0 ? 0 : 1);

export function bumpMapVersion(w: WorldState, a: number, b: number): void {
  w.roadVersion = (Math.imul(w.roadVersion, 31) + Math.imul(a, 97) + Math.imul(b, 13) + 7) >>> 0;
}

// ---------- 勞動與生產 ----------

export function canWork(w: WorldState, n: Npc): boolean {
  if (n.age < 16 || n.age > 65) return false;
  if (n.health < 30 || n.hunger >= 95 || n.illnessUntil > w.tick || n.commute < 0) return false;
  if (n.id === w.leadership.leaderId && w.leadership.mode !== 1 && toDate(w.tick).dayOfWeek === 5) return false;
  return true;
}

function effFx(n: Npc, sector: number): number {
  return ECON.laborEff.baseFx + ECON.laborEff.perSkillFx * (n.skills[skillFor(sector)] ?? 0);
}

function contribFx(n: Npc, sector: number, index: number): number {
  const coef = ECON.marginalCoefFx[Math.min(index, ECON.marginalCoefFx.length - 1)]!;
  const tool = n.equipped ? 1000 : ECON.noToolCoefFx;
  const c1 = Math.floor((coef * effFx(n, sector)) / 1000);
  const c2 = Math.floor((c1 * tool) / 1000);
  return Math.floor((c2 * commuteFx(n.commute)) / 1000);
}

function conserved(w: WorldState, x: number, y: number): boolean {
  for (const z of w.zones) if (z.kind === 0 && x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) return true;
  return false;
}

const OFFSETS: Record<number, [number, number][]> = {};
function offsets(r: number): [number, number][] {
  const cached = OFFSETS[r];
  if (cached) return cached;
  const list: { d: number; dx: number; dy: number }[] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) list.push({ d: dx * dx + dy * dy, dx, dy });
  list.sort((a, b) => a.d - b.d || a.dy - b.dy || a.dx - b.dx);
  return (OFFSETS[r] = list.map((o) => [o.dx, o.dy] as [number, number]));
}

function harvestForest(w: WorldState, b: Building, woodUnits: number): number {
  const per = ECON.forest.perWood;
  let need = woodUnits * per;
  let got = 0;
  for (const [dx, dy] of offsets(ECON.lumber.radius)) {
    if (need <= 0) break;
    const x = b.ex + dx;
    const y = b.ey + dy;
    if (!inBounds(w.map, x, y) || conserved(w, x, y)) continue;
    const i = tileIdx(w.map, x, y);
    const f = w.map.forest[i]!;
    if (f <= 0) continue;
    const take = Math.min(f, need);
    w.map.forest[i] = f - take;
    need -= take;
    got += take;
    if (w.map.forest[i] === 0) bumpMapVersion(w, x, y);
  }
  return Math.floor(got / per);
}

function mineStone(w: WorldState, b: Building, units: number): number {
  let need = units;
  let got = 0;
  for (const [dx, dy] of offsets(ECON.quarry.radius)) {
    if (need <= 0) break;
    const x = b.ex + dx;
    const y = b.ey + dy;
    if (!inBounds(w.map, x, y)) continue;
    const i = tileIdx(w.map, x, y);
    const s = w.map.stone[i]!;
    if (s <= 0) continue;
    const take = Math.min(s, need);
    w.map.stone[i] = s - take;
    need -= take;
    got += take;
  }
  return got;
}

function place(w: WorldState, n: Npc, b: Building | undefined): void {
  if (!b) return;
  n.x = b.ex;
  n.y = b.ey;
  n.state = 5;
  void w;
}

/** GDD 3.1 步驟 4：生產與施工結算。休息日不生產。 */
export function dailyWork(w: WorldState): void {
  const date = toDate(w.tick);
  // 非工作者回家（供渲染）
  for (const n of w.npcs) {
    if (date.isRestDay || n.jobKind === 0) {
      const hh = hhOf(w, n.householdId);
      const home = hh ? bldOf(w, hh.homeId) : undefined;
      if (home) {
        n.x = home.ex;
        n.y = home.ey;
      }
      n.state = n.jobKind === 0 ? 0 : 7;
    }
  }
  if (date.isRestDay) return;

  // 採集與漁獲：無業成年人每日自行覓食，是缺糧時的最後生計（GDD 5.4「缺糧會尋找糧食」）
  const forage = ECON.forage.foodPerDayBySeason[date.season] ?? 0;
  if (forage > 0) {
    for (const n of w.npcs) {
      if (n.jobKind !== 0 || n.age < 16 || n.age > 65 || n.health < 30 || n.illnessUntil > w.tick) continue;
      const hh = hhOf(w, n.householdId);
      if (hh) addProduced(w, hh, FOOD, forage);
    }
  }

  const seasonFx = ECON.farm.seasonFx[date.season] ?? 0;
  for (const e of w.enterprises) {
    if (!e.active) continue;
    const sector = sectorOf(e);
    const b = bldOf(w, e.buildingId);
    if (!b || b.state !== 'active') continue;
    let sumC = 0;
    let idx = 0;
    for (const id of e.employeeIds) {
      const n = npcOf(w, id);
      if (!n || !canWork(w, n)) continue;
      sumC += contribFx(n, sector, idx);
      idx++;
      n.workDaysWeek++;
      n.lastSector = sector;
      place(w, n, b);
    }
    if (sumC === 0) continue;
    switch (e.kind) {
      case 'farm':
        if (seasonFx > 0 && !e.fallow) e.accumFx += Math.floor((sumC * seasonFx) / 1000);
        break;
      case 'lumber': {
        e.progressFx += ECON.lumber.perDay * sumC;
        const units = Math.floor(e.progressFx / 1000);
        e.progressFx -= units * 1000;
        if (units > 0) addProduced(w, e, WOOD, harvestForest(w, b, units));
        break;
      }
      case 'quarry': {
        e.progressFx += ECON.quarry.perDay * sumC;
        const units = Math.floor(e.progressFx / 1000);
        e.progressFx -= units * 1000;
        if (units > 0) addProduced(w, e, STONE, mineStone(w, b, units));
        break;
      }
      case 'toolshop': {
        e.progressFx += sumC;
        const C = ECON.toolshop;
        while (e.progressFx >= C.batchPD * 1000 && e.stock[WOOD]! >= C.inWood && e.stock[STONE]! >= C.inStone) {
          e.progressFx -= C.batchPD * 1000;
          consume(w, e, WOOD, C.inWood);
          consume(w, e, STONE, C.inStone);
          addProduced(w, e, TOOL, C.batchOut);
        }
        e.progressFx = Math.min(e.progressFx, C.batchPD * 2000);
        break;
      }
      case 'furnshop': {
        e.progressFx += sumC;
        const C = ECON.furnshop;
        while (e.progressFx >= C.batchPD * 1000 && e.stock[WOOD]! >= C.inWood) {
          e.progressFx -= C.batchPD * 1000;
          consume(w, e, WOOD, C.inWood);
          addProduced(w, e, FURN, C.batchOut);
        }
        e.progressFx = Math.min(e.progressFx, C.batchPD * 2000);
        break;
      }
    }
  }

  // 公共工程施工：工資每日由公共帳戶轉入工人家庭
  for (const wk of w.works) {
    if (wk.state !== 1) continue;
    const b = wk.buildingId ? bldOf(w, wk.buildingId) : undefined;
    let idx = 0;
    for (const n of w.npcs) {
      if (n.jobKind !== 2 || n.jobId !== wk.id || !canWork(w, n)) continue;
      const wage = wk.kind === 'maintenance' ? ECON.wage.min : w.settlement.wage[PUBLIC_SECTOR]!;
      if (!transferMoney(w, 'p', 'h' + n.householdId, wage, 'wage:work' + wk.id)) {
        n.reason = '公共帳戶無力支付工資';
        continue;
      }
      wk.cost += wage;
      if (wk.kind !== 'maintenance') w.leadership.publicSpendSeason[3]! += wage;
      wk.progressFx += contribFx(n, PUBLIC_SECTOR, idx);
      idx++;
      n.workDaysWeek++;
      n.lastSector = PUBLIC_SECTOR;
      const hh = hhOf(w, n.householdId);
      if (hh) hh.incomeWeek += wage;
      if (b) place(w, n, b);
      else {
        const t = wk.tiles[0];
        if (t) {
          n.x = t.x;
          n.y = t.y;
        }
      }
    }
    if (wk.kind !== 'maintenance' && wk.progressFx >= wk.requiredPDFx) completeWork(w, wk);
  }
}

// ---------- 公共工程 ----------

export const materialsValue = (m: number[]): number => {
  let v = 0;
  for (let i = 0; i < NCOMM; i++) v += m[i]! * ECON.basePrice[i]!;
  return v;
};

export function queueWork(w: WorldState, wk: Omit<PublicWork, 'id' | 'reserved' | 'state' | 'progressFx' | 'startedTick' | 'cost' | 'openSlots'>): PublicWork {
  const work: PublicWork = {
    ...wk,
    id: w.nextIds.work++,
    reserved: [0, 0, 0, 0, 0],
    state: 0,
    progressFx: 0,
    startedTick: w.tick,
    cost: 0,
    openSlots: 0,
  };
  w.works.push(work);
  reserveMaterials(w, work);
  return work;
}

/** 從公共庫存預約材料；齊備後轉為施工中。 */
export function reserveMaterials(w: WorldState, wk: PublicWork): void {
  if (wk.state !== 0) return;
  const pub = w.settlement.public;
  for (let i = 0; i < NCOMM; i++) {
    const miss = wk.needed[i]! - wk.reserved[i]!;
    if (miss <= 0) continue;
    const take = Math.min(miss, pub.stock[i]!);
    pub.stock[i]! -= take;
    wk.reserved[i]! += take;
  }
  if (wk.needed.every((n, i) => wk.reserved[i]! >= n)) wk.state = 1;
}

export function completeWork(w: WorldState, wk: PublicWork): void {
  wk.state = 2;
  for (let i = 0; i < NCOMM; i++) w.stats.consumed[i]! += wk.reserved[i]!;
  const released: number[] = [];
  for (const n of w.npcs) {
    if (n.jobKind === 2 && n.jobId === wk.id) {
      n.jobKind = 0;
      n.jobId = 0;
      n.unemployedWeeks = 0;
      released.push(n.id);
    }
  }
  const served: number[] = [];
  if (wk.kind === 'building') {
    const b = bldOf(w, wk.buildingId);
    if (b) {
      b.state = 'active';
      b.builtTick = w.tick;
      b.workId = 0;
      if (b.type === 'field' || b.type === 'lumber' || b.type === 'quarry' || b.type === 'toolshop' || b.type === 'furnshop') {
        addEnterprise(w, b, wk.beneficiaryHouseholdId, 0, 0);
      }
      for (const h of w.households) {
        const home = bldOf(w, h.homeId);
        if (home && Math.abs(home.ex - b.ex) + Math.abs(home.ey - b.ey) <= 8) served.push(h.id);
      }
      pushEvent(w, { type: 'BuildingCompleted', importance: 1, causeIds: [], actorIds: [], summary: `${buildingLabel(b.type)}落成`, data: { buildingId: b.id, workId: wk.id } });
    }
  } else {
    for (const t of wk.tiles) {
      const i = tileIdx(w.map, t.x, t.y);
      w.map.road[i] = t.type;
      w.map.forest[i] = 0;
      bumpMapVersion(w, t.x, t.y);
    }
    for (const h of w.households) {
      const home = bldOf(w, h.homeId);
      if (!home) continue;
      const near = wk.tiles.some((t) => Math.abs(home.ex - t.x) + Math.abs(home.ey - t.y) <= 6);
      if (near) served.push(h.id);
    }
    for (const e of w.enterprises) {
      const b = bldOf(w, e.buildingId);
      if (b && e.kind === 'farm' && wk.tiles.some((t) => Math.abs(b.ex - t.x) + Math.abs(b.ey - t.y) <= 4)) {
        const hh = e.ownerHouseholdId;
        if (!served.includes(hh)) served.push(hh);
      }
    }
    pushEvent(w, { type: 'RoadBuilt', importance: 1, causeIds: [], actorIds: [], summary: `道路完工（${wk.tiles.length} 格）`, data: { workId: wk.id } });
  }
  served.sort((a, b) => a - b);
  w.benefits.push({ tick: w.tick, workId: wk.id, households: served, cost: wk.cost + materialsValue(wk.needed) });
  w.leadership.publicSpendSeason[3]! += materialsValue(wk.needed);
  w.leadership.favorTotal[3]! += served.length;
  const mine = served.filter((h) => h === w.leadership.playerHouseholdId).length;
  w.leadership.favorRelatives[3]! += mine;
  // 通勤快取失效：下週重算
  for (const n of w.npcs) n.commute = -2;
  void released;
}

export function buildingLabel(t: string): string {
  const m: Record<string, string> = { home: '住宅', field: '農田', lumber: '林場', quarry: '採石場', toolshop: '工具工坊', furnshop: '家具工坊', market: '市場', storage: '倉庫', school: '學堂', clinic: '診所', publichome: '公共住宅' };
  return m[t] ?? t;
}

// ---------- 通勤 ----------

export function workplaceOf(w: WorldState, n: Npc): Building | undefined {
  if (n.jobKind === 1) {
    const e = entOf(w, n.jobId);
    return e ? bldOf(w, e.buildingId) : undefined;
  }
  if (n.jobKind === 2) {
    const wk = w.works.find((x) => x.id === n.jobId);
    if (!wk) return undefined;
    if (wk.buildingId) return bldOf(w, wk.buildingId);
    return undefined;
  }
  return undefined;
}

export function commuteCostFor(w: WorldState, n: Npc, to: { ex: number; ey: number } | { x: number; y: number }): number {
  const hh = hhOf(w, n.householdId);
  const home = hh ? bldOf(w, hh.homeId) : undefined;
  if (!home) return -1;
  const gx = 'ex' in to ? to.ex : to.x;
  const gy = 'ey' in to ? to.ey : to.y;
  return pathCost(w.map, w.id, w.roadVersion, home.ex, home.ey, gx, gy);
}

/** 重算有工作者的通勤成本；不可達則取消任務（A1 門檻）。 */
export function refreshCommutes(w: WorldState): void {
  for (const n of w.npcs) {
    if (n.jobKind === 0) {
      n.commute = 0;
      continue;
    }
    if (n.commute !== -2 && n.commute >= 0) continue;
    let dest: { ex: number; ey: number } | { x: number; y: number } | undefined = workplaceOf(w, n);
    if (!dest && n.jobKind === 2) {
      const wk = w.works.find((x) => x.id === n.jobId);
      dest = wk?.tiles[0] ?? (wk?.kind === 'maintenance' ? w.buildings.find((b) => b.type === 'market') : undefined);
    }
    if (!dest) {
      releaseJob(w, n, '工作地消失');
      continue;
    }
    const c = commuteCostFor(w, n, dest);
    if (c < 0) {
      releaseJob(w, n, '工作地不可達，取消任務');
      continue;
    }
    n.commute = c;
  }
}

export function releaseJob(w: WorldState, n: Npc, reason: string): void {
  if (n.jobKind === 1) {
    const e = entOf(w, n.jobId);
    if (e) removeFrom(e.employeeIds, n.id);
  }
  n.jobKind = 0;
  n.jobId = 0;
  n.commute = 0;
  n.unemployedWeeks = 0;
  n.reason = reason;
  n.state = 0;
}

// ---------- 收成、倉儲、工資 ----------

export function harvestSeason(w: WorldState): void {
  const date = toDate(w.tick);
  if (date.season > 2) return;
  for (const e of w.enterprises) {
    if (e.kind !== 'farm' || !e.active) continue;
    if (e.fallow) {
      e.fallow = 0;
      e.accumFx = 0;
      e.fertility = Math.min(ECON.fertility.max, e.fertility + ECON.fertility.fallowGain);
      pushEvent(w, { type: 'FallowEnded', importance: 0, causeIds: [], actorIds: [], summary: `農田休耕一季，肥力回升至 ${e.fertility}`, data: { enterpriseId: e.id } });
      continue;
    }
    const quality = 500 + Math.floor((500 * e.fertility) / 100);
    let y = Math.floor((ECON.farm.perPersonSeason * e.accumFx * quality) / (ECON.farm.workDaysPerSeason * 1000 * 1000));
    y = Math.floor((y * w.env.yieldPermille) / 1000);
    e.accumFx = 0;
    e.fertility = Math.max(0, e.fertility - ECON.fertility.harvestLoss);
    if (y <= 0) continue;
    addProduced(w, e, FOOD, y);
    w.settlement.harvestFood += y;
    const tax = Math.floor((y * w.policies.harvestTaxPermille) / 1000);
    if (tax > 0) transferGoods(w, 'e' + e.id, 'p', FOOD, tax, 'harvest-tax');
    if (w.policies.agriSubsidy > 0) {
      if (transferMoney(w, 'p', 'e' + e.id, w.policies.agriSubsidy, 'agri-subsidy')) w.leadership.publicSpendSeason[3]! += w.policies.agriSubsidy;
    }
  }
}

export function winterFertility(w: WorldState): void {
  for (const e of w.enterprises) if (e.kind === 'farm') e.fertility = Math.min(ECON.fertility.max, e.fertility + ECON.fertility.winterGain);
}

export function monthlySpoilage(w: WorldState): void {
  const p = ECON.spoilFoodPermillePerMonth;
  const apply = (s: number[]): void => {
    const loss = Math.floor((s[FOOD]! * p) / 1000);
    if (loss > 0) {
      s[FOOD]! -= loss;
      w.stats.spoiled[FOOD]! += loss;
    }
  };
  apply(w.settlement.public.stock);
  for (const h of w.households) apply(h.stock);
  for (const e of w.enterprises) apply(e.stock);
}

/** 季初：肥力偏低的農田輪流休耕一季（GDD 8.2，每次休耕 +6）。 */
export function decideFallow(w: WorldState): void {
  const d = toDate(w.tick);
  if (d.season !== 1) return;
  const farms = w.enterprises.filter((e) => e.kind === 'farm' && e.active);
  if (farms.some((e) => e.fallow)) return;
  const low = farms.filter((e) => e.fertility < 55).sort((a, b) => a.fertility - b.fertility || a.id - b.id)[0];
  if (low) {
    low.fallow = 1;
    pushEvent(w, { type: 'FallowStarted', importance: 1, causeIds: [], actorIds: [], summary: `肥力降至 ${low.fertility}，農田本季休耕`, data: { enterpriseId: low.id } });
  }
}

export function equipTools(w: WorldState): void {
  for (const n of w.npcs) {
    n.equipped = 0;
    if (n.jobKind === 0) continue;
    const hh = hhOf(w, n.householdId);
    if (hh && hh.stock[TOOL]! > 0) {
      consume(w, hh, TOOL, 1);
      n.equipped = 1;
    }
  }
}

export function weeklyPayroll(w: WorldState): void {
  const wageNow = w.settlement.wage;
  for (const e of w.enterprises) {
    if (!e.active) continue;
    const sector = sectorOf(e);
    const wage = wageNow[sector]!;
    let bill = 0;
    for (const id of e.employeeIds) {
      const n = npcOf(w, id);
      if (n) bill += n.workDaysWeek * wage;
    }
    // 業主注資
    if (e.cash < bill && !e.ownerHouseholdId) {
      const give = Math.min(bill - e.cash, Math.max(0, w.settlement.public.cash - 500));
      if (give > 0) transferMoney(w, 'p', 'e' + e.id, give, 'public-capital');
    }
    if (e.cash < bill && e.ownerHouseholdId) {
      const owner = hhOf(w, e.ownerHouseholdId);
      if (owner) {
        const reserve = owner.memberIds.length * 7 * ECON.basePrice[FOOD]!;
        const give = Math.min(bill - e.cash, Math.max(0, owner.cash - reserve));
        if (give > 0) transferMoney(w, 'h' + owner.id, 'e' + e.id, give, 'capital');
      }
    }
    let paidTotal = 0;
    for (const id of e.employeeIds) {
      const n = npcOf(w, id);
      if (!n || n.workDaysWeek === 0) continue;
      const due = n.workDaysWeek * wage;
      const pay = Math.min(due, Math.max(0, e.cash));
      if (pay > 0 && transferMoney(w, 'e' + e.id, 'h' + n.householdId, pay, 'wage:e' + e.id)) {
        paidTotal += pay;
        const hh = hhOf(w, n.householdId);
        if (hh) hh.incomeWeek += pay;
      }
      if (pay < due) {
        n.arrears += due - pay;
        n.tags.push({ type: '欠薪', strength: 600, expiresTick: w.tick + 360, causeId: e.id });
        pushEvent(w, { type: 'WageArrears', importance: 1, causeIds: [], actorIds: [n.id], summary: `${n.name} 被 ${e.kind} 欠薪`, data: { enterpriseId: e.id } });
      }
    }
    e.costWeek += paidTotal;
    // 分紅：保留兩週工資與緩衝，餘額 60% 歸業主
    const keep = bill * 2 + 400;
    if (e.cash > keep && e.ownerHouseholdId) {
      const dividend = Math.floor(((e.cash - keep) * 60) / 100);
      if (dividend > 0) transferMoney(w, 'e' + e.id, 'h' + e.ownerHouseholdId, dividend, 'dividend');
    } else if (e.cash > keep && !e.ownerHouseholdId) {
      const d = Math.floor(((e.cash - keep) * 60) / 100);
      if (d > 0) transferMoney(w, 'e' + e.id, 'p', d, 'dividend-public');
    }
  }
  for (const n of w.npcs) n.workDaysWeek = 0;
}

// ---------- 勞動市場 ----------

function seasonPriceFx(w: WorldState): number {
  return ECON.farm.seasonFx[toDate(w.tick).season] ?? 0;
}

/** 第 index（0 起算）位工人的邊際日產值。 */
export function marginalValue(w: WorldState, e: Enterprise, index: number): number {
  const P = w.settlement.prices;
  const coef = ECON.marginalCoefFx[Math.min(index, ECON.marginalCoefFx.length - 1)]!;
  const eff = ECON.laborEff.baseFx + ECON.laborEff.perSkillFx * 40;
  const base = Math.floor((coef * eff) / 1000);
  if (e.fallow) return 0;
  const capOut = ECON.stockCap[OUTPUT_OF[e.kind]]!;
  if (e.stock[OUTPUT_OF[e.kind]]! > capOut) return 0;
  switch (e.kind) {
    case 'farm': {
      const quality = 500 + Math.floor((500 * e.fertility) / 100);
      const perDay = (ECON.farm.perPersonSeason * 1000) / ECON.farm.workDaysPerSeason;
      const out = Math.floor((perDay * base * quality) / 1_000_000);
      return Math.floor((out * P[FOOD]! * seasonPriceFx(w)) / 1_000_000);
    }
    case 'lumber':
      return Math.floor((ECON.lumber.perDay * base * P[WOOD]!) / 1000);
    case 'quarry':
      return Math.floor((ECON.quarry.perDay * base * P[STONE]!) / 1000);
    case 'toolshop': {
      const C = ECON.toolshop;
      const val = C.batchOut * P[TOOL]! - C.inWood * P[WOOD]! - C.inStone * P[STONE]!;
      return Math.floor((val * base) / (C.batchPD * 1000));
    }
    case 'furnshop': {
      const C = ECON.furnshop;
      const val = C.batchOut * P[FURN]! - C.inWood * P[WOOD]!;
      return Math.floor((val * base) / (C.batchPD * 1000));
    }
  }
}

function maxWorkers(e: Enterprise): number {
  return (ECON[e.kind] as { maxWorkers: number }).maxWorkers;
}

/** 企業每週：判斷雇用與解雇（連續 2 週邊際產值低於工資才解雇）。 */
export function enterpriseLabor(w: WorldState): void {
  for (const e of w.enterprises) {
    e.openSlots = 0;
    if (!e.active) continue;
    const sector = sectorOf(e);
    const wage = w.settlement.wage[sector]!;
    const n = e.employeeIds.length;
    let fired = false;
    if (n > 0 && marginalValue(w, e, n - 1) < wage) e.lowWeeks++;
    else e.lowWeeks = 0;
    if (e.lowWeeks >= 2) {
      const id = e.employeeIds[e.employeeIds.length - 1]!;
      const emp = npcOf(w, id);
      if (emp) releaseJob(w, emp, '被解雇：邊際產值低於工資');
      e.lowWeeks = 0;
      fired = true;
    }
    const now = e.employeeIds.length;
    if (!fired && e.strategy !== 3) {
      let slots = 0;
      while (slots < 3 && now + slots < maxWorkers(e) && marginalValue(w, e, now + slots) >= wage && e.cash + ownerCash(w, e) >= (now + slots + 1) * 5 * wage) slots++;
      e.openSlots = slots;
    }
  }
  ensureReliefWork(w);
  for (const wk of w.works) {
    wk.openSlots = 0;
    if (wk.state !== 1) continue;
    if (wk.kind === 'maintenance') {
      const working = w.npcs.filter((n) => n.jobKind === 2 && n.jobId === wk.id).length;
      const idle = unemployedCount(w);
      wk.openSlots = w.policies.workRelief && w.settlement.public.cash > 800 ? Math.max(0, Math.min(4, idle + working) - working) : 0;
      continue;
    }
    const working = w.npcs.filter((n) => n.jobKind === 2 && n.jobId === wk.id).length;
    const remainingPd = Math.max(0, Math.floor((wk.requiredPDFx - wk.progressFx) / 1000));
    const want = Math.min(5, Math.ceil(remainingPd / 12));
    wk.openSlots = Math.max(0, want - working);
  }
}

function ownerCash(w: WorldState, e: Enterprise): number {
  if (!e.ownerHouseholdId) return Math.max(0, w.settlement.public.cash - 500);
  const o = hhOf(w, e.ownerHouseholdId);
  return o ? Math.max(0, o.cash - o.memberIds.length * 70) : 0;
}

const TRAIT_PREF: Record<number, (sector: number) => number> = {
  0: (s) => (s === 0 ? 200 : -100),
  1: (s) => (s === 1 || s === 2 || s === 5 ? 200 : 0),
  2: () => 0,
  3: () => 100,
  4: (s) => (s === 3 || s === 4 ? 200 : 0),
  5: (s) => (s === 5 ? 150 : 0),
};

export interface JobOption {
  kind: number;
  id: number;
  sector: number;
  utility: number;
  commute: number;
  reason: string;
}

function jobUtility(w: WorldState, n: Npc, kind: number, id: number, sector: number, wageIn: number, commute: number, owner: number, lowWeeks: number, switching: boolean): { u: number; reason: string } {
  const W = ECON.npc.weights;
  let wage = wageIn;
  // 自家企業：業主保有邊際產值與工資的差額，收入以兩者較高者計
  if (owner === n.householdId && kind === 1) {
    const e = entOf(w, id);
    if (e) wage = Math.max(wage, marginalValue(w, e, Math.max(0, e.employeeIds.length - (e.employeeIds.includes(n.id) ? 1 : 0))));
  }
  const income = Math.min(1000, Math.floor((wage * 1000) / ECON.npc.wageRef));
  let family = 400;
  if (owner === n.householdId) family = 1000;
  else {
    const hh = hhOf(w, n.householdId);
    if (hh && kind === 1) {
      const e = entOf(w, id);
      if (e && hh.memberIds.some((m) => e.employeeIds.includes(m))) family = 800;
    }
  }
  const skill = (n.skills[skillFor(sector)] ?? 0) * 10;
  let stability = kind === 2 ? 600 : 1000 - (lowWeeks > 0 ? 300 : 0);
  for (const t of n.tags) if (t.type === '欠薪' && t.causeId === id && kind === 1 && t.expiresTick > w.tick) stability -= t.strength;
  stability = clamp(stability, 0, 1000);
  let pref = 500;
  for (const t of n.traits) pref += TRAIT_PREF[t]?.(sector) ?? 0;
  pref = clamp(pref, 0, 1000);
  let u = Math.floor((W.income * income + W.family * family + W.skill * skill + W.stability * stability + W.preference * pref) / 1000);
  u -= commute * ECON.npc.commutePenaltyPerCost;
  const risk = ECON.npc.sectorRisk[sector] ?? 300;
  u -= Math.floor((risk * (100 - n.riskPreference)) / 100 / 4);
  if (switching) u -= ECON.npc.switchCost;
  return { u, reason: `收入${income} 家庭${family} 技能${skill} 穩定${stability} 偏好${pref} 通勤${commute}` };
}

function leisureUtility(w: WorldState, n: Npc): number {
  const hh = hhOf(w, n.householdId);
  if (!hh) return 0;
  const weeklyNeed = hh.memberIds.length * 7 * (w.settlement.prices[FOOD] ?? 10);
  const buffer = hh.cash - weeklyNeed * 4;
  const bonus = buffer > 0 ? Math.min(150, Math.floor((buffer * 150) / (weeklyNeed * 8))) : 0;
  return ECON.npc.leisureBase + bonus - (n.unemployedWeeks > 8 ? 100 : 0);
}

/** 每週：失業者與想轉職者依效用申請職缺（GDD 5.2 三段式決策＋慣性）。 */
export function weeklyJobMatching(w: WorldState): void {
  const cands = w.npcs.filter((n) => isWorkAge(n) && n.illnessUntil <= w.tick);
  const jobless = cands.filter((n) => n.jobKind === 0).sort((a, b) => b.unemployedWeeks - a.unemployedWeeks || a.id - b.id);
  const switchers = cands.filter((n) => n.jobKind !== 0 && n.cooldownUntil <= w.tick && n.id !== w.leadership.leaderId).sort((a, b) => a.id - b.id);
  const order = [...jobless, ...switchers];
  for (const n of order) {
    const hh = hhOf(w, n.householdId);
    const home = hh ? bldOf(w, hh.homeId) : undefined;
    if (!home) continue;
    const currentSwitching = n.jobKind !== 0;
    let cur = -Infinity;
    if (currentSwitching) {
      if (n.jobKind === 1) {
        const e = entOf(w, n.jobId);
        if (e) cur = jobUtility(w, n, 1, e.id, sectorOf(e), w.settlement.wage[sectorOf(e)]!, Math.max(0, n.commute), e.ownerHouseholdId, e.lowWeeks, false).u;
      } else {
        const kind = w.works.find((x) => x.id === n.jobId)?.kind;
      cur = jobUtility(w, n, 2, n.jobId, PUBLIC_SECTOR, kind === 'maintenance' ? ECON.wage.min : w.settlement.wage[PUBLIC_SECTOR]!, Math.max(0, n.commute), 0, 0, false).u;
      }
    }
    let best: JobOption | null = null;
    for (const e of w.enterprises) {
      if (!e.active || e.openSlots <= 0 || (n.jobKind === 1 && n.jobId === e.id)) continue;
      const b = bldOf(w, e.buildingId);
      if (!b) continue;
      const c = pathCost(w.map, w.id, w.roadVersion, home.ex, home.ey, b.ex, b.ey);
      if (c < 0) continue;
      const sector = sectorOf(e);
      const r = jobUtility(w, n, 1, e.id, sector, w.settlement.wage[sector]!, c, e.ownerHouseholdId, e.lowWeeks, currentSwitching);
      if (!best || r.u > best.utility) best = { kind: 1, id: e.id, sector, utility: r.u, commute: c, reason: r.reason };
    }
    for (const wk of w.works) {
      if (wk.state !== 1 || wk.openSlots <= 0 || (n.jobKind === 2 && n.jobId === wk.id)) continue;
      const tile = wk.buildingId ? bldOf(w, wk.buildingId) : undefined;
      const mk = w.buildings.find((b) => b.type === 'market');
      const gx = tile ? tile.ex : (wk.tiles[0]?.x ?? mk?.ex);
      const gy = tile ? tile.ey : (wk.tiles[0]?.y ?? mk?.ey);
      if (gx === undefined || gy === undefined) continue;
      const c = pathCost(w.map, w.id, w.roadVersion, home.ex, home.ey, gx, gy);
      if (c < 0) continue;
      const r = jobUtility(w, n, 2, wk.id, PUBLIC_SECTOR, wk.kind === 'maintenance' ? ECON.wage.min : w.settlement.wage[PUBLIC_SECTOR]!, c, 0, 0, currentSwitching);
      if (!best || r.u > best.utility) best = { kind: 2, id: wk.id, sector: PUBLIC_SECTOR, utility: r.u, commute: c, reason: r.reason };
    }
    if (!currentSwitching) {
      const leis = leisureUtility(w, n);
      if (best && best.utility >= leis) {
        takeJob(w, n, best);
        n.leisure = 0;
        n.reason = `應徵成功：${best.reason}`;
      } else {
        n.unemployedWeeks++;
        n.leisure = best && leis > best.utility ? 1 : 0;
        n.reason = best ? `選擇休閒（${leis} > ${best.utility}）` : '無職缺';
      }
    } else if (best && best.utility >= cur + ECON.npc.inertia) {
      releaseJob(w, n, '轉職');
      takeJob(w, n, best);
      n.reason = `轉職：${best.reason}（${best.utility} ≥ ${cur}+${ECON.npc.inertia}）`;
      pushEvent(w, { type: 'JobChanged', importance: 0, causeIds: [], actorIds: [n.id], summary: `${n.name} 轉職`, data: { kind: best.kind, id: best.id } });
    }
  }
}

function takeJob(w: WorldState, n: Npc, o: JobOption): void {
  n.jobKind = o.kind;
  n.jobId = o.id;
  n.jobSince = w.tick;
  n.commute = o.commute;
  n.unemployedWeeks = 0;
  n.cooldownUntil = w.tick + ECON.npc.cooldownWeeks * 6;
  n.equipped = 0;
  if (o.kind === 1) {
    const e = entOf(w, o.id)!;
    e.employeeIds.push(n.id);
    e.employeeIds.sort((a, b) => a - b);
    e.openSlots--;
  } else {
    const wk = w.works.find((x) => x.id === o.id)!;
    wk.openSlots--;
  }
}

/** 各部門工資依勞動超額需求調整，單週上限 ±5%，下限為最低生活費。 */
export function adjustWages(w: WorldState): void {
  const unfilled = [0, 0, 0, 0, 0, 0];
  const posted = [0, 0, 0, 0, 0, 0];
  for (const e of w.enterprises) {
    if (e.active && e.openSlots > 0) unfilled[sectorOf(e)]! += e.openSlots;
    if (e.active && e.employeeIds.length > 0) posted[sectorOf(e)]! += 1;
  }
  for (const wk of w.works) if (wk.state === 1) {
    unfilled[PUBLIC_SECTOR]! += wk.openSlots;
    posted[PUBLIC_SECTOR]! += 1;
  }
  const jobless = w.npcs.filter((n) => isWorkAge(n) && n.jobKind === 0 && n.leisure === 0 && n.illnessUntil <= w.tick).length;
  const cap = ECON.wage.weeklyMaxPermille;
  for (let s = 0; s < 6; s++) {
    const excess = unfilled[s]! * 2 - jobless;
    if (excess === 0) continue;
    const delta = clamp(excess * 25, -cap, cap);
    if (delta < 0 && posted[s]! === 0) continue;
    const cur = w.settlement.wage[s]!;
    w.settlement.wage[s] = clamp(cur + Math.trunc((cur * delta) / 1000) + (delta > 0 && Math.trunc((cur * delta) / 1000) === 0 ? 1 : 0), ECON.wage.min, ECON.wage.start[s]! * 2);
  }
}

/** 以工代賑：公共帳戶有餘裕時開出公共雜役（維護道路與水渠），工資取最低生活費。 */
function ensureReliefWork(w: WorldState): void {
  if (w.works.some((x) => x.kind === 'maintenance' && x.state === 1)) return;
  w.works.push({
    id: w.nextIds.work++, kind: 'maintenance', buildingId: 0, tiles: [], requiredPDFx: 1_000_000_000, progressFx: 0, needed: [0, 0, 0, 0, 0], reserved: [0, 0, 0, 0, 0],
    state: 1, startedTick: w.tick, causeCommandId: 0, proposalId: 0, beneficiaryHouseholdId: 0, openSlots: 0, cost: 0,
  });
}

export function unemployedCount(w: WorldState): number {
  return w.npcs.filter((n) => isWorkAge(n) && n.jobKind === 0 && n.leisure === 0 && n.illnessUntil <= w.tick).length;
}

export function workforce(w: WorldState): number {
  return w.npcs.filter((n) => isWorkAge(n)).length;
}

// ---------- 市場 ----------

interface Order {
  ref: string;
  qty: number;
  prio: number;
  sort: number;
}

function daysUntilSpring(tick: number): number {
  const d = toDate(tick);
  return d.season === 3 ? 90 - d.dayOfSeason + 1 : d.season === 2 ? 90 - d.dayOfSeason + 91 : 0;
}

function householdOrders(w: WorldState, c: number, orders: Order[]): void {
  const date = toDate(w.tick);
  const S = w.settlement;
  for (const h of w.households) {
    const members = h.memberIds.length;
    if (members === 0) continue;
    const weeklyFoodCost = members * 7 * S.prices[FOOD]!;
    if (c === FOOD) {
      let days = h.safetyDays;
      const exp = S.expectedPrice[date.season]![FOOD]!;
      const ratio = Math.floor((S.prices[FOOD]! * 1000) / Math.max(1, exp));
      if (ratio < 900) days += Math.min(ECON.household.arbitrageMaxExtraDays, Math.floor((900 - ratio) / 10));
      else if (ratio > 1100) days -= Math.min(10, Math.floor((ratio - 1100) / 10));
      days = Math.max(14, days);
      const want = members * days - h.stock[FOOD]!;
      if (want > 0) orders.push({ ref: 'h' + h.id, qty: want, prio: Math.floor((1000 * h.stock[FOOD]!) / members) * -1 + 100000, sort: h.id });
    } else if (c === WOOD) {
      if (date.season >= 2) {
        const need = Math.min(90, daysUntilSpring(w.tick) + 10) * ECON.fuelPerHouseholdDay - h.stock[WOOD]!;
        if (need > 0) orders.push({ ref: 'h' + h.id, qty: need, prio: 50000, sort: h.id });
      }
    } else if (c === TOOL) {
      const workers = h.memberIds.reduce((k, id) => k + ((npcOf(w, id)?.jobKind ?? 0) > 0 ? 1 : 0), 0);
      const want = workers - h.stock[TOOL]!;
      if (want > 0 && h.cash > weeklyFoodCost * 2) orders.push({ ref: 'h' + h.id, qty: want, prio: 40000, sort: h.id });
    } else if (c === FURN) {
      const comfortTarget = Math.min(ECON.household.furnitureMax, 1 + Math.floor(members / 2) + Math.floor(h.cash / (members * ECON.household.furnitureWealthStep)));
      if (h.stock[FURN]! < comfortTarget && h.cash > weeklyFoodCost * 3) orders.push({ ref: 'h' + h.id, qty: 1, prio: 1000, sort: h.id });
    }
  }
}

function enterpriseOrders(w: WorldState, c: number, orders: Order[]): void {
  for (const e of w.enterprises) {
    if (!e.active) continue;
    const reserve = e.employeeIds.length * 5 * (w.settlement.wage[sectorOf(e)] ?? 20);
    let want = 0;
    if (c === WOOD && e.kind === 'toolshop' && e.employeeIds.length > 0) want = Math.max(0, 14 * e.employeeIds.length - e.stock[WOOD]!);
    else if (c === STONE && e.kind === 'toolshop' && e.employeeIds.length > 0) want = Math.max(0, 7 * e.employeeIds.length - e.stock[STONE]!);
    else if (c === WOOD && e.kind === 'furnshop' && e.employeeIds.length > 0) want = Math.max(0, 20 * e.employeeIds.length - e.stock[WOOD]!);
    void reserve;
    if (want > 0) orders.push({ ref: 'e' + e.id, qty: want, prio: 20000, sort: e.id });
  }
}

function publicOrders(w: WorldState, c: number, orders: Order[]): void {
  // 常平倉：公共存糧低於目標且糧價不高時，由公共帳戶採購糧食（GDD 7.5 救濟的來源）
  if (c === FOOD) {
    const target = w.npcs.length * ECON.relief.reserveDays;
    const priceOk = w.settlement.prices[FOOD]! * 1000 <= ECON.basePrice[FOOD]! * ECON.relief.buyMaxPriceFx;
    const want = target - w.settlement.public.stock[FOOD]!;
    if (want > 0 && priceOk && w.settlement.public.cash > 800) orders.push({ ref: 'p', qty: want, prio: 60000, sort: 0 });
    return;
  }
  let miss = 0;
  for (const wk of w.works) if (wk.state === 0) miss += Math.max(0, wk.needed[c]! - wk.reserved[c]! - w.settlement.public.stock[c]!);
  if (miss > 0) orders.push({ ref: 'p', qty: miss, prio: 30000, sort: 0 });
}

export function runMarket(w: WorldState): void {
  const S = w.settlement;
  const date = toDate(w.tick);
  for (let c = 0; c < NCOMM; c++) {
    const orders: Order[] = [];
    householdOrders(w, c, orders);
    enterpriseOrders(w, c, orders);
    publicOrders(w, c, orders);
    orders.sort((a, b) => b.prio - a.prio || a.sort - b.sort);
    const sellers = w.enterprises.filter((e) => e.active && OUTPUT_OF[e.kind] === c && e.stock[c]! > 0).sort((a, b) => a.id - b.id);
    const supply = sum(sellers.map((e) => e.stock[c]!));
    const price = S.prices[c]!;
    let demand = 0;
    let bought = 0;
    for (const o of orders) {
      const h = o.ref === 'p' ? S.public : o.ref[0] === 'h' ? hhOf(w, Number(o.ref.slice(1)))! : entOf(w, Number(o.ref.slice(1)))!;
      if (o.ref[0] === 'e') {
        // 營運週轉：企業採購原料時，由業主（家庭或公共）補足不足的現金
        const ent = h as Enterprise;
        const lack = o.qty * price - ent.cash;
        if (lack > 0) {
          const give = Math.min(lack, ownerCash(w, ent));
          if (give > 0) transferMoney(w, ent.ownerHouseholdId ? 'h' + ent.ownerHouseholdId : 'p', o.ref, give, 'working-capital');
        }
      }
      const afford = Math.floor(h.cash / price);
      let want = Math.min(o.qty, afford);
      demand += want;
      if (want < o.qty && o.ref[0] === 'h') hhOf(w, Number(o.ref.slice(1)))!.shortWeeks++;
      for (const s of sellers) {
        if (want <= 0) break;
        const q = Math.min(want, s.stock[c]!);
        if (q <= 0) continue;
        if (settleTrade(w, o.ref, 'e' + s.id, c, q, price, w.policies.commerceTaxPermille, 'market')) {
          want -= q;
          bought += q;
          s.revenueWeek += q * price;
        }
      }
    }
    void bought;
    // 價格：P_next = P × (1 + 0.10 × (D − S) / max(D, S, 1))，單週 ±10%，限 0.5–2.5 × P_base
    const denom = Math.max(demand, supply, 1);
    let next = price + Math.trunc((price * ECON.price.stepPermille * (demand - supply)) / (1000 * denom));
    const cap = Math.max(1, Math.floor((price * ECON.price.weeklyMaxPermille) / 1000));
    next = clamp(next, price - cap, price + cap);
    const base = ECON.basePrice[c]!;
    next = clamp(next, Math.floor((base * ECON.price.minFx) / 1000), Math.floor((base * ECON.price.maxFx) / 1000));
    S.prices[c] = Math.max(1, next);
    S.seasonPriceSum[c]! += S.prices[c]!;
  }
  S.seasonPriceN++;
  void date;
}

export function updateExpectedPrices(w: WorldState): void {
  const S = w.settlement;
  const season = toDate(w.tick).season;
  if (S.seasonPriceN > 0) {
    for (let c = 0; c < NCOMM; c++) {
      const avg = Math.floor(S.seasonPriceSum[c]! / S.seasonPriceN);
      S.expectedPrice[season]![c] = Math.floor((S.expectedPrice[season]![c]! * 3 + avg) / 4);
    }
  }
  S.seasonPriceSum = [0, 0, 0, 0, 0];
  S.seasonPriceN = 0;
  let idx = 0;
  let wsum = 0;
  const wts = [500, 100, 50, 200, 150];
  for (let c = 0; c < NCOMM; c++) {
    idx += Math.floor((S.prices[c]! * 1000 * wts[c]!) / ECON.basePrice[c]!);
    wsum += wts[c]!;
  }
  S.priceIndex = Math.floor(idx / wsum);
}

// ---------- 缺糧求助與救濟 ----------

export function householdDaysOfFood(h: Household): number {
  return h.memberIds.length === 0 ? 999 : Math.floor(h.stock[FOOD]! / h.memberIds.length);
}

function addFamineTag(w: WorldState, h: Household, cause: number): void {
  h.famineTick = w.tick;
  h.safetyDays = Math.min(ECON.household.safetyDays + 30, h.safetyDays + 5);
  for (const id of h.memberIds) {
    const n = npcOf(w, id);
    if (n && !n.tags.some((t) => t.type === '饑荒' && t.expiresTick > w.tick + 300)) n.tags.push({ type: '饑荒', strength: 700, expiresTick: w.tick + 720, causeId: cause });
  }
}

/** 每日緊急行為：存糧 < 3 日 → 親友借糧 → 公共救濟（A1 門檻：連續缺糧會求助）。 */
export function dailyEmergency(w: WorldState): void {
  for (const h of w.households) {
    const members = h.memberIds.length;
    if (members === 0 || h.stock[FOOD]! >= members * 5) continue;
    const need = members * 10 - h.stock[FOOD]!;
    let got = 0;
    // 1. 親友（依信任由高到低，同分依家戶 id）
    const friends: { hh: number; trust: number }[] = [];
    for (const id of h.memberIds) {
      const n = npcOf(w, id);
      if (!n) continue;
      for (const r of n.relations) {
        const other = npcOf(w, r.targetId);
        if (other && other.householdId !== h.id && r.trust >= 40) friends.push({ hh: other.householdId, trust: r.trust });
      }
    }
    friends.sort((a, b) => b.trust - a.trust || a.hh - b.hh);
    const tried: number[] = [];
    for (const f of friends) {
      if (got >= need || tried.includes(f.hh)) continue;
      tried.push(f.hh);
      const d = hhOf(w, f.hh);
      if (!d) continue;
      const spare = d.stock[FOOD]! - d.memberIds.length * 14;
      if (spare <= 0) continue;
      const give = Math.min(spare, need - got);
      if (transferGoods(w, 'h' + d.id, 'h' + h.id, FOOD, give, 'kin-help')) {
        got += give;
        adjustReciprocity(w, d, h, give);
      }
    }
    // 2. 公共救濟
    if (got < need) {
      const give = Math.min(need - got, w.settlement.public.stock[FOOD]!);
      if (give > 0 && transferGoods(w, 'p', 'h' + h.id, FOOD, give, 'relief')) {
        got += give;
        w.settlement.reliefFoodSeason += give;
        pushEvent(w, { type: 'ReliefGiven', importance: 1, causeIds: [], actorIds: [], summary: `${h.name} 缺糧，領取公共救濟 ${give}`, data: { householdId: h.id, qty: give } });
      }
    }
    if (got > 0) addFamineTag(w, h, 0);
  }
}

function adjustReciprocity(w: WorldState, donor: Household, taker: Household, qty: number): void {
  const bump = (h: Household, other: number, delta: number): void => {
    const r = h.reciprocity.find((x) => x.targetHouseholdId === other);
    if (r) {
      r.balance += delta;
      r.lastTick = w.tick;
    } else h.reciprocity.push({ targetHouseholdId: other, balance: delta, lastTick: w.tick });
    h.reciprocity.sort((a, b) => a.targetHouseholdId - b.targetHouseholdId);
  };
  bump(donor, taker.id, qty);
  bump(taker, donor.id, -qty);
}

/** 每週：存糧低於 7 日由公共存糧救濟；有人情債且有餘裕者優先回報。 */
export function weeklyRelief(w: WorldState): void {
  const S = w.settlement;
  const list = w.households.filter((h) => h.memberIds.length > 0 && householdDaysOfFood(h) < ECON.relief.triggerDays).sort((a, b) => householdDaysOfFood(a) - householdDaysOfFood(b) || a.id - b.id);
  for (const h of list) {
    const want = h.memberIds.length * ECON.relief.topUpDays - h.stock[FOOD]!;
    const give = Math.min(want, S.public.stock[FOOD]!);
    if (give > 0 && transferGoods(w, 'p', 'h' + h.id, FOOD, give, 'relief-weekly')) {
      S.reliefFoodSeason += give;
      addFamineTag(w, h, 0);
      pushEvent(w, { type: 'ReliefGiven', importance: 1, causeIds: [], actorIds: [], summary: `${h.name} 存糧不足 7 日，領取救濟 ${give}`, data: { householdId: h.id, qty: give } });
    }
  }
  for (const h of w.households) {
    for (const r of h.reciprocity) {
      if (r.balance >= 0) continue;
      const donor = hhOf(w, r.targetHouseholdId);
      if (!donor) continue;
      const surplus = h.stock[FOOD]! - h.memberIds.length * 25;
      if (surplus <= 0) continue;
      const pay = Math.min(-r.balance, surplus);
      if (pay > 0 && transferGoods(w, 'h' + h.id, 'h' + donor.id, FOOD, pay, 'reciprocity')) {
        r.balance += pay;
        const back = donor.reciprocity.find((x) => x.targetHouseholdId === h.id);
        if (back) back.balance -= pay;
      }
    }
  }
}

// ---------- 每日消費 ----------

/** GDD 3.1 步驟 5：每日進食與冬季燃料。 */
export function dailyConsumption(w: WorldState, fuelMult = 1): { starved: number[] } {
  const starved: number[] = [];
  const winter = toDate(w.tick).season === 3;
  for (const h of w.households) {
    let cold = false;
    if (winter) {
      const need = ECON.fuelPerHouseholdDay * fuelMult;
      if (h.stock[WOOD]! >= need) consume(w, h, WOOD, need);
      else {
        consume(w, h, WOOD, h.stock[WOOD]!);
        cold = true;
      }
    }
    for (const id of h.memberIds) {
      const n = npcOf(w, id);
      if (!n) continue;
      const fed = h.stock[FOOD]! >= ECON.foodPerPersonDay;
      if (fed) consume(w, h, FOOD, ECON.foodPerPersonDay);
      n.hunger = fed ? Math.max(0, n.hunger - 25) : Math.min(100, n.hunger + 20);
      if (n.hunger > 70) n.health -= 3;
      else if (n.hunger === 0 && n.health < 100 && n.illnessUntil <= w.tick) n.health += 1;
      if (cold) n.health -= 1;
      n.mood = clamp(n.mood + Math.trunc((70 - Math.floor(n.hunger / 2) - (cold ? 20 : 0) + Math.min(15, h.stock[FURN]! * 5) - n.mood) / 10), 0, 100);
      if (n.health <= 0) starved.push(n.id);
    }
  }
  return { starved };
}

export function householdStats(w: WorldState): { foodDays: number; unemployed: number; workforce: number } {
  const food = w.households.reduce((s, h) => s + h.stock[FOOD]!, 0) + w.settlement.public.stock[FOOD]! + w.enterprises.reduce((s, e) => s + e.stock[FOOD]!, 0);
  return { foodDays: Math.floor(food / Math.max(1, w.npcs.length)), unemployed: unemployedCount(w), workforce: workforce(w) };
}
