import { ECON } from '@ss/content';
import { marginalValue, releaseJob } from './econ.js';
import { pushBio, pushEvent } from './history.js';
import { inBounds, tileIdx, validatePlacement } from './map.js';
import { transferGoods, transferMoney } from './ledger.js';
import { addBuilding, addEnterprise } from './start.js';
import type { Enterprise, WorldState } from './types.js';
import { bldOf, hhOf, npcOf } from './util.js';

const KIND_LABEL: Record<string, string> = { farm: '農田', lumber: '林場', quarry: '採石場', toolshop: '工具工坊', furnshop: '家具工坊' };

// ---------- 企業策略、停工與退出（GDD 7.7） ----------

/** 每季評估策略：擴產／維持／節流／停工；連續兩季虧損只觸發評估；退出採簡化清算。 */
export function seasonEnterpriseReview(w: WorldState): void {
  const C = ECON.enterprise;
  for (const e of w.enterprises) {
    if (e.kind === 'farm') {
      e.profitSeason = 0; // 農業收入集中於收成季，不以單季損益評估
      continue;
    }
    if (!e.active && e.strategy !== 3) continue;
    const profit = e.profitSeason;
    e.profitSeason = 0;
    if (e.strategy === 3) {
      e.lossSeasons++;
      if (e.lossSeasons >= C.lossSeasonsStop + C.stopSeasonsExit && e.ownerHouseholdId > 0) liquidate(w, e);
      continue;
    }
    if (profit >= 0) {
      if (e.strategy === 2 || e.lossSeasons > 0) {
        e.strategy = 1;
        pushEvent(w, { type: 'StrategyChanged', importance: 1, causeIds: [], actorIds: [], summary: `${KIND_LABEL[e.kind]}轉虧為盈，恢復維持經營`, data: { enterpriseId: e.id, strategy: 1 } });
      } else if (profit > 600 && e.strategy === 1) e.strategy = 0;
      e.lossSeasons = 0;
      continue;
    }
    e.lossSeasons++;
    if (e.ownerHouseholdId <= 0) continue; // 公有企業由公共帳戶補貼，不退出
    if (e.lossSeasons >= C.lossSeasonsStop) {
      e.strategy = 3;
      for (const id of [...e.employeeIds]) {
        const n = npcOf(w, id);
        if (n) releaseJob(w, n, '企業停工，需重新求職');
      }
      const hh = hhOf(w, e.ownerHouseholdId);
      pushEvent(w, { type: 'EnterpriseSuspended', importance: 2, causeIds: [], actorIds: [], summary: `${hh?.name ?? ''}的${KIND_LABEL[e.kind]}連續虧損，停工；工人重新求職`, data: { enterpriseId: e.id } });
    } else if (e.lossSeasons >= C.lossSeasonsCut && e.strategy !== 2) {
      e.strategy = 2;
      pushEvent(w, { type: 'StrategyChanged', importance: 1, causeIds: [], actorIds: [], summary: `${KIND_LABEL[e.kind]}連續 ${e.lossSeasons} 季虧損，改為節流（不再徵人）`, data: { enterpriseId: e.id, strategy: 2 } });
    }
  }
}

/** 簡化清算：出售庫存（公共帳戶按基準價折價收購）→ 剩餘現金歸業主 → 企業停止營運。 */
export function liquidate(w: WorldState, e: Enterprise): void {
  const pub = w.settlement.public;
  for (let c = 0; c < 5; c++) {
    const qty = e.stock[c]!;
    if (qty <= 0) continue;
    const price = Math.floor((ECON.basePrice[c]! * ECON.enterprise.liquidatePermille) / 1000);
    const pay = Math.min(qty * price, Math.max(0, pub.cash));
    const take = price > 0 ? Math.min(qty, Math.floor(pay / price)) : 0;
    if (take > 0 && transferGoods(w, 'e' + e.id, 'p', c, take, 'liquidate')) transferMoney(w, 'p', 'e' + e.id, take * price, 'liquidate');
  }
  for (const id of [...e.employeeIds]) {
    const n = npcOf(w, id);
    if (n) releaseJob(w, n, '企業結業');
  }
  const hh = hhOf(w, e.ownerHouseholdId);
  if (e.cash > 0 && hh) transferMoney(w, 'e' + e.id, 'h' + hh.id, e.cash, 'liquidate-owner');
  e.active = 0;
  const b = bldOf(w, e.buildingId);
  if (b) b.state = 'ruined';
  pushEvent(w, { type: 'EnterpriseClosed', importance: 2, causeIds: [], actorIds: [], summary: `${hh?.name ?? ''}的${KIND_LABEL[e.kind]}結業，庫存折價出售、餘額歸業主`, data: { enterpriseId: e.id } });
}

/** 每週：商業用地內，條件符合的家庭依決定性順序開設企業（GDD 7.7）。 */
export function foundEnterprises(w: WorldState): void {
  for (const z of w.zones) {
    if (z.kind !== 1 || z.founded) continue;
    const cand = [...w.households].filter((h) => h.memberIds.length > 0 && h.cash >= ECON.enterprise.foundMinCash).sort((a, b) => b.cash - a.cash || a.id - b.id)[0];
    if (!cand) continue;
    // 依目前市價選邊際產值最高的一種
    const kinds: ('toolshop' | 'furnshop' | 'lumber')[] = ['toolshop', 'furnshop', 'lumber'];
    const probe = (k: string): number => {
      const tmp = w.enterprises.find((x) => x.kind === k);
      return tmp ? marginalValue(w, tmp, 0) : 0;
    };
    const kind = kinds.sort((a, b) => probe(b) - probe(a))[0]!;
    const type = kind;
    let spot: { x: number; y: number } | null = null;
    for (let y = z.y; y < z.y + z.h && !spot; y++) for (let x = z.x; x < z.x + z.w && !spot; x++) if (validatePlacement(w.map, w.buildings, type, x, y) === null) spot = { x, y };
    if (!spot) continue;
    if (!transferMoney(w, 'h' + cand.id, 'p', ECON.enterprise.foundCost, 'permit')) continue;
    const b = addBuilding(w, type, spot.x, spot.y, cand.id, 'active');
    const e = addEnterprise(w, b, cand.id, 0, 0);
    transferMoney(w, 'h' + cand.id, 'e' + e.id, Math.min(800, Math.floor(cand.cash / 2)), 'capital');
    z.founded = 1;
    pushEvent(w, { type: 'EnterpriseFounded', importance: 2, causeIds: [], actorIds: [], summary: `${cand.name}在商業用地開設${KIND_LABEL[kind]}`, data: { enterpriseId: e.id, householdId: cand.id } });
  }
}

// ---------- 教育、醫療、技能傳承 ----------

function hasActive(w: WorldState, type: string): boolean {
  return w.buildings.some((b) => b.type === type && b.state === 'active');
}

function payStaff(w: WorldState, amount: number, label: string): number {
  const hs = w.households.filter((h) => h.memberIds.length > 0);
  const pay = Math.min(amount, w.settlement.public.cash);
  if (pay <= 0 || hs.length === 0) return 0;
  const share = Math.floor(pay / hs.length);
  let paid = 0;
  for (const h of hs) if (share > 0 && transferMoney(w, 'p', 'h' + h.id, share, label)) paid += share;
  const rest = pay - paid;
  if (rest > 0 && transferMoney(w, 'p', 'h' + hs[0]!.id, rest, label)) paid += rest;
  return paid;
}

export function schoolActive(w: WorldState): boolean {
  return hasActive(w, 'school') && w.policies.educationBudget > 0;
}
export function clinicActive(w: WorldState): boolean {
  return hasActive(w, 'clinic') && w.policies.healthBudget > 0;
}

/** 季初：教育與醫療預算付給學堂教師與診所人員（記入帳本，付費不足則該季無效）。 */
export function seasonalServices(w: WorldState): void {
  if (hasActive(w, 'school') && w.policies.educationBudget > 0) {
    const paid = payStaff(w, w.policies.educationBudget, 'education');
    w.leadership.publicSpendSeason[3]! += paid;
    if (paid < w.policies.educationBudget) pushEvent(w, { type: 'ServiceUnderfunded', importance: 1, causeIds: [], actorIds: [], summary: '公共資金不足，學堂經費未付足', data: {} });
  }
  if (hasActive(w, 'clinic') && w.policies.healthBudget > 0) {
    const paid = payStaff(w, w.policies.healthBudget, 'health');
    w.leadership.publicSpendSeason[3]! += paid;
  }
}

/** 年度：學堂提升學齡兒童技能；父母工藝技能傳承給孩子（GDD 9 歷史影響）。 */
export function yearlyEducation(w: WorldState, parentSectorOf: Record<number, number>): void {
  const school = schoolActive(w);
  const [lo, hi] = ECON.edu.ages;
  for (const n of w.npcs) {
    if (n.age >= 16) continue;
    // 技能傳承：父母本年主要從事的部門，對應技能 +2（上限 40）
    for (const pid of n.parentIds) {
      const sec = parentSectorOf[pid];
      if (sec !== undefined && sec >= 0) {
        const k = sec === 0 ? 0 : 1;
        n.skills[k] = Math.min(40, n.skills[k]! + 2);
      }
    }
    if (school && n.age >= lo! && n.age <= hi!) {
      const best = n.skills.indexOf(Math.max(...n.skills));
      for (let i = 0; i < 4; i++) n.skills[i] = Math.min(100, n.skills[i]! + (i === best ? ECON.edu.skillGainPerYear : 1));
      pushBio(w, n, '在學堂讀書，技能有所增長');
    }
  }
}

// ---------- 地圖對照 ----------

export function snapshotMap(w: WorldState): void {
  const m = w.map;
  const N = 24;
  const cell = m.w / N;
  const grid: number[] = [];
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      const count = [0, 0, 0, 0, 0];
      for (let y = gy * cell; y < (gy + 1) * cell; y++) {
        for (let x = gx * cell; x < (gx + 1) * cell; x++) {
          const i = tileIdx(m, x, y);
          if (m.occ[i]) count[4]!++;
          else if (m.road[i]) count[3]!++;
          else if (m.water[i]) count[0]!++;
          else if (m.forest[i]! > 0) count[2]!++;
          else count[1]!++;
        }
      }
      // 建築與道路優先顯示（只要有就標記），其餘取多數
      grid.push(count[4]! > 0 ? 4 : count[3]! > 1 ? 3 : count.indexOf(Math.max(count[0]!, count[1]!, count[2]!)));
    }
  }
  w.mapSnaps.push({ tick: w.tick, grid });
  if (w.mapSnaps.length > 12) w.mapSnaps.shift();
  void inBounds;
}
