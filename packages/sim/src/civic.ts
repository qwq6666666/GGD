import { ECON } from '@ss/content';
import { toDate } from './calendar.js';
import { clamp } from './fixed.js';
import { pushBio, pushEvent } from './history.js';
import { materialsValue, queueWork, PUBLIC_SECTOR } from './econ.js';
import { findSpot, inBuildZone } from './map.js';
import { findPath } from './path.js';
import { addBuilding } from './start.js';
import { FOOD, TOOL, type Household, type Npc, type PendingPolicy, type Proposal, type WorldState } from './types.js';
import { bldOf, hhOf, isAdult, npcOf } from './util.js';
import { householdDaysOfFood } from './econ.js';

export const SALARY_BASELINE = 60;
const FAVOR_MIN_SPEND = 600;
const W = { needs: 300, tax: 150, response: 200, favor: 200, crisis: 150 };

export const playerHousehold = (w: WorldState): Household | undefined => hhOf(w, w.leadership.playerHouseholdId);

// ---------- 提案 ----------

function openProposalFor(w: WorldState, kind: Proposal['kind'], proposerHh: number): boolean {
  // 開啟中，或同一家庭 90 日內才被處理／過期的同類提案（避免重複洗版）
  return w.proposals.some((p) => p.kind === kind && (kind !== 'road' || npcOf(w, p.proposerId)?.householdId === proposerHh) && (p.status === 0 || p.status === 2 || p.createdTick > w.tick - 90));
}

function highThisSeason(w: WorldState): number {
  const d = toDate(w.tick);
  const start = w.tick - (d.dayOfSeason - 1);
  return w.proposals.filter((p) => p.priority === 1 && p.createdTick >= start).length;
}

function roadTilesBetween(w: WorldState, sx: number, sy: number, gx: number, gy: number): { x: number; y: number; type: number }[] | null {
  const p = findPath(w.map, sx, sy, gx, gy);
  if (!p) return null;
  const tiles: { x: number; y: number; type: number }[] = [];
  for (const i of p.steps) {
    if (w.map.road[i] !== 0) continue;
    if (w.map.water[i] !== 0) return null; // V1 不自動架橋
    const x = i % w.map.w;
    const y = Math.floor(i / w.map.w);
    if (!inBuildZone(w.map, x, y)) continue;
    tiles.push({ x, y, type: 1 });
  }
  return tiles;
}

export type RoadMode = 'dirt' | 'stone' | 'bridge' | 'stonebridge';

export function roadCost(w: WorldState, tiles: number, mode: RoadMode = 'dirt'): { materials: number[]; pd: number; cash: number } {
  const U = ECON.upgrade;
  const materials =
    mode === 'dirt' ? [0, tiles * ECON.road.dirtWood, 0, 0, 0] : mode === 'stone' ? [0, 0, tiles * U.stoneRoad.stone, 0, 0] : mode === 'bridge' ? [0, tiles * U.bridge.wood, 0, 0, 0] : [0, 0, tiles * U.bridge.stoneStone, 0, 0];
  const pd = tiles * (mode === 'dirt' ? ECON.road.dirtPersonDays : mode === 'stone' ? U.stoneRoad.personDays : mode === 'bridge' ? U.bridge.personDays : U.bridge.stonePersonDays);
  return { materials, pd, cash: pd * w.settlement.wage[PUBLIC_SECTOR]! + materialsValue(materials) };
}

/** 每週：依觸發條件生成居民提案（GDD 2.3）。每季最多 3 件高優先。 */
export function generateProposals(w: WorldState): void {
  for (const p of w.proposals) if ((p.status === 0 || p.status === 2) && p.expiry <= w.tick) p.status = 4;
  if (highThisSeason(w) >= 3) return;
  const date = toDate(w.tick);
  // 道路：通勤成本過高
  const walkers = w.npcs.filter((n) => n.jobKind === 1 && n.commute > ECON.road.proposalCommuteCost).sort((a, b) => b.commute - a.commute || a.id - b.id);
  for (const n of walkers) {
    if (openProposalFor(w, 'road', n.householdId)) continue;
    const hh = hhOf(w, n.householdId);
    const home = hh ? bldOf(w, hh.homeId) : undefined;
    const e = w.enterprises.find((x) => x.id === n.jobId);
    const wb = e ? bldOf(w, e.buildingId) : undefined;
    if (!home || !wb) continue;
    const tiles = roadTilesBetween(w, home.ex, home.ey, wb.ex, wb.ey);
    if (!tiles || tiles.length === 0) continue;
    const c = roadCost(w, tiles.length);
    const after = Math.floor(n.commute / 2);
    w.proposals.push({
      id: w.nextIds.proposal++,
      proposerId: n.id,
      kind: 'road',
      target: { x: home.ex, y: home.ey, toX: wb.ex, toY: wb.ey, ent: e!.id },
      evidence: n.commute,
      cost: c.cash,
      materials: c.materials,
      expectedEffects: `${n.name} 往返工作地的通勤成本由 ${n.commute} 降至約 ${after}；需 ${tiles.length} 格土路`,
      createdTick: w.tick,
      expiry: w.tick + 60,
      status: 0,
      priority: n.commute > ECON.road.proposalCommuteCost * 1.4 ? 1 : 0,
    });
    pushEvent(w, { type: 'ProposalCreated', importance: 1, causeIds: [], actorIds: [n.id], summary: `${n.name} 提議修路：通勤成本 ${n.commute}`, data: { kind: 'road' } });
    if (highThisSeason(w) >= 3) return;
    break;
  }
  // 糧食：存糧撐不到下次收成＋10 日
  if (!openProposalFor(w, 'food_crisis', 0)) {
    const stock = w.households.reduce((s, h) => s + h.stock[FOOD]!, 0) + w.settlement.public.stock[FOOD]!;
    const daily = Math.max(1, w.npcs.length);
    const days = Math.floor(stock / daily);
    const toHarvest = date.dayOfSeason <= 90 ? 90 - date.dayOfSeason + (date.season === 2 ? 91 : 0) : 0;
    const need = date.season === 3 ? 90 - date.dayOfSeason + 1 + 10 : toHarvest + 10;
    if (days < need && (date.season >= 2 || days < 20)) {
      const proposer = w.npcs.filter(isAdult)[0];
      if (proposer) {
        w.proposals.push({
          id: w.nextIds.proposal++,
          proposerId: proposer.id,
          kind: 'food_crisis',
          target: { x: 0, y: 0, toX: 0, toY: 0, ent: 0 },
          evidence: days,
          cost: 160,
          materials: [0, 35, 0, 0, 0],
          expectedEffects: `全村存糧僅夠 ${days} 日；開墾農田要到下次收成才增產，並減少森林`,
          createdTick: w.tick,
          expiry: w.tick + 45,
          status: 0,
          priority: 1,
        });
        pushEvent(w, { type: 'ProposalCreated', importance: 2, causeIds: [], actorIds: [proposer.id], summary: `存糧僅夠 ${days} 日，居民請求公共措施`, data: { kind: 'food_crisis' } });
      }
    }
  }
  // 住房：容量不足
  if (!openProposalFor(w, 'housing', 0)) {
    const cap = w.buildings.filter((b) => (b.type === 'home' || b.type === 'publichome') && b.state === 'active').reduce((s, b) => s + b.capacity, 0);
    if (w.npcs.length * 100 > cap * 85 && highThisSeason(w) < 3) {
      const proposer = w.npcs.filter(isAdult)[0];
      if (proposer) {
        w.proposals.push({
          id: w.nextIds.proposal++,
          proposerId: proposer.id,
          kind: 'housing',
          target: { x: 0, y: 0, toX: 0, toY: 0, ent: 0 },
          evidence: Math.floor((w.npcs.length * 100) / Math.max(1, cap)),
          cost: 200,
          materials: [0, ECON.build.home.wood, ECON.build.home.stone, 0, 0],
          expectedEffects: `住房使用率 ${Math.floor((w.npcs.length * 100) / Math.max(1, cap))}%，興建公共住宅`,
          createdTick: w.tick,
          expiry: w.tick + 60,
          status: 0,
          priority: 0,
        });
      }
    }
  }
  // 診療覆蓋不足：一年內發生過疫病且沒有診所
  if (!openProposalFor(w, 'clinic', 0) && w.tick - w.lastEpidemicTick < 360 && !w.buildings.some((b) => b.type === 'clinic') && highThisSeason(w) < 3) {
    const proposer = w.npcs.filter(isAdult)[0];
    if (proposer) {
      w.proposals.push({
        id: w.nextIds.proposal++, proposerId: proposer.id, kind: 'clinic', target: { x: 0, y: 0, toX: 0, toY: 0, ent: 0 }, evidence: 70, cost: 200,
        materials: [0, ECON.build.clinic.wood, ECON.build.clinic.stone, 0, 0], expectedEffects: '疫病後診療覆蓋不足，興建診所；另需設定醫療預算才會運作',
        createdTick: w.tick, expiry: w.tick + 90, status: 0, priority: 1,
      });
    }
  }
  // 工具短缺
  if (!openProposalFor(w, 'tools', 0)) {
    const need = w.enterprises.reduce((s, e) => s + e.employeeIds.length, 0);
    const have = w.enterprises.reduce((s, e) => s + e.stock[TOOL]!, 0);
    if (need > 0 && have * 2 < need && w.settlement.prices[TOOL]! >= (ECON.basePrice[TOOL]! * 3) / 2 && highThisSeason(w) < 3) {
      const proposer = w.npcs.filter(isAdult)[0];
      if (proposer) {
        w.proposals.push({
          id: w.nextIds.proposal++,
          proposerId: proposer.id,
          kind: 'tools',
          target: { x: 0, y: 0, toX: 0, toY: 0, ent: 0 },
          evidence: need - have,
          cost: 4 * w.settlement.prices[TOOL]! * 2,
          materials: [0, 0, 0, 0, 0],
          expectedEffects: `工具缺 ${need - have} 件，補助工坊週轉資金可提高產量`,
          createdTick: w.tick,
          expiry: w.tick + 45,
          status: 0,
          priority: 1,
        });
      }
    }
  }
}

export type RespondResult = { ok: true } | { ok: false; reason: string };

/** 核准、延後或拒絕提案（GDD 2.3）。確認前不扣款；預算不足則拒絕命令。 */
export function respondProposal(w: WorldState, id: number, response: string): RespondResult {
  const p = w.proposals.find((x) => x.id === id);
  if (!p) return { ok: false, reason: 'unknown_proposal' };
  if (p.status !== 0 && p.status !== 2) return { ok: false, reason: 'not_open' };
  const proposer = npcOf(w, p.proposerId);
  const hh = proposer ? hhOf(w, proposer.householdId) : undefined;
  if (response === 'defer') {
    p.status = 2;
    if (hh) hh.trustLeader = clamp(hh.trustLeader - 2, 0, 100);
    return { ok: true };
  }
  if (response === 'reject') {
    p.status = 3;
    if (hh) hh.trustLeader = clamp(hh.trustLeader - 8, 0, 100);
    pushEvent(w, { type: 'ProposalRejected', importance: 1, causeIds: [], actorIds: [p.proposerId], summary: `提案被拒絕（${p.kind}）`, data: { proposalId: p.id } });
    return { ok: true };
  }
  if (response !== 'approve') return { ok: false, reason: 'bad_response' };
  const r = applyProposal(w, p);
  if (!r.ok) return r;
  p.status = 1;
  if (hh) hh.trustLeader = clamp(hh.trustLeader + 8, 0, 100);
  pushEvent(w, { type: 'ProposalApproved', importance: 1, causeIds: [], actorIds: [p.proposerId], summary: `核准提案（${p.kind}）：${p.expectedEffects}`, data: { proposalId: p.id } });
  return { ok: true };
}

function applyProposal(w: WorldState, p: Proposal): RespondResult {
  const S = w.settlement;
  if (p.kind === 'road') {
    const tiles = roadTilesBetween(w, p.target.x, p.target.y, p.target.toX, p.target.toY);
    if (!tiles || tiles.length === 0) return { ok: false, reason: 'nothing_to_build' };
    const c = roadCost(w, tiles.length);
    if (S.public.cash < c.pd * S.wage[PUBLIC_SECTOR]!) return { ok: false, reason: 'insufficient_budget' };
    queueWork(w, { kind: 'road', buildingId: 0, tiles, requiredPDFx: c.pd * 1000, needed: c.materials, causeCommandId: 0, proposalId: p.id, beneficiaryHouseholdId: 0 });
    return { ok: true };
  }
  if (p.kind === 'food_crisis') {
    const hhId = npcOf(w, p.proposerId)?.householdId ?? 0;
    const spot = findSpot(w.map, w.buildings, 'field', 46, 58);
    if (!spot) return { ok: false, reason: 'no_space' };
    if (S.public.cash < p.cost) return { ok: false, reason: 'insufficient_budget' };
    const b = addBuilding(w, 'field', spot.x, spot.y, hhId, 'building');
    const cfg = ECON.build.field;
    const wk = queueWork(w, { kind: 'building', buildingId: b.id, tiles: [], requiredPDFx: cfg.personDays * 1000, needed: [0, cfg.wood, 0, 0, 0], causeCommandId: 0, proposalId: p.id, beneficiaryHouseholdId: hhId });
    b.workId = wk.id;
    return { ok: true };
  }
  if (p.kind === 'clinic') {
    const spot = findSpot(w.map, w.buildings, 'clinic', 46, 40);
    if (!spot) return { ok: false, reason: 'no_space' };
    if (S.public.cash < p.cost) return { ok: false, reason: 'insufficient_budget' };
    const b = addBuilding(w, 'clinic', spot.x, spot.y, 0, 'building');
    const cfg = ECON.build.clinic;
    const wk = queueWork(w, { kind: 'building', buildingId: b.id, tiles: [], requiredPDFx: cfg.personDays * 1000, needed: [0, cfg.wood, cfg.stone, 0, 0], causeCommandId: 0, proposalId: p.id, beneficiaryHouseholdId: 0 });
    b.workId = wk.id;
    return { ok: true };
  }
  if (p.kind === 'housing') {
    const spot = findSpot(w.map, w.buildings, 'publichome', 44, 58);
    if (!spot) return { ok: false, reason: 'no_space' };
    if (S.public.cash < p.cost) return { ok: false, reason: 'insufficient_budget' };
    const b = addBuilding(w, 'publichome', spot.x, spot.y, 0, 'building');
    const cfg = ECON.build.home;
    const wk = queueWork(w, { kind: 'building', buildingId: b.id, tiles: [], requiredPDFx: cfg.personDays * 1000, needed: [0, cfg.wood, cfg.stone, 0, 0], causeCommandId: 0, proposalId: p.id, beneficiaryHouseholdId: 0 });
    b.workId = wk.id;
    return { ok: true };
  }
  // tools：補助缺工具的企業週轉金
  const need = w.enterprises.filter((e) => e.employeeIds.length > e.stock[TOOL]!).slice(0, 3);
  const each = 2 * S.prices[TOOL]!;
  for (const e of need) {
    if (S.public.cash >= each) {
      S.public.cash -= each;
      e.cash += each;
      w.leadership.publicSpendSeason[3]! += each;
    }
  }
  return { ok: true };
}

/** AI 代理領袖：只維持現行政策；成本 ≤ 公共資金 20% 且證據分數達門檻才核准，否則延後。 */
export function aiLeaderRespond(w: WorldState): void {
  for (const p of w.proposals) {
    if (p.status !== 0 && p.status !== 2) continue;
    const ok = p.cost * 100 <= w.settlement.public.cash * 20 && p.evidence >= 60 && p.priority === 1;
    if (ok) respondProposal(w, p.id, 'approve');
    else if (p.status === 0) p.status = 2;
  }
}

// ---------- 政策 ----------

export function setPolicy(w: WorldState, key: string, value: number, commandId: number): RespondResult {
  const limits: Record<string, [number, number]> = {
    harvestTaxPermille: [0, ECON.tax.harvestMaxPermille],
    commerceTaxPermille: [0, 100],
    agriSubsidy: [0, 200],
    housingSubsidy: [0, 200],
    mintPerSeason: [0, 5000],
    leaderSalaryMonthly: [0, 400],
    roadPriority: [0, 3],
    workRelief: [0, 1],
    educationBudget: [0, ECON.edu.budgetPerSeasonMax],
    healthBudget: [0, ECON.edu.budgetPerSeasonMax],
  };
  const lim = limits[key];
  if (!lim) return { ok: false, reason: 'unknown_policy' };
  if (!Number.isInteger(value) || value < lim[0] || value > lim[1]) return { ok: false, reason: 'out_of_range' };
  const d = toDate(w.tick);
  const nextSeasonStart = w.tick + (90 - d.dayOfSeason + 1);
  const delay = w.leadership.support >= 60 ? 0 : w.leadership.support >= 40 ? 90 : 0;
  w.policies.pending = w.policies.pending.filter((p) => p.key !== key);
  w.policies.pending.push({ key, value, effectiveTick: nextSeasonStart + delay, commandId });
  return { ok: true };
}

export function applyPendingPolicies(w: WorldState): void {
  const due: PendingPolicy[] = [];
  const rest: PendingPolicy[] = [];
  for (const p of w.policies.pending) (p.effectiveTick <= w.tick ? due : rest).push(p);
  w.policies.pending = rest;
  due.sort((a, b) => a.commandId - b.commandId);
  for (const p of due) {
    const pol = w.policies as unknown as Record<string, number>;
    const old = pol[p.key]!;
    pol[p.key] = p.value;
    pushEvent(w, { type: 'PolicyApplied', importance: 1, causeIds: [], actorIds: [], summary: `政策生效：${p.key} ${old} → ${p.value}`, data: { key: p.key, old, value: p.value, commandId: p.commandId } });
    // 損失趨避：記錄政策變動造成的滿意度衝擊，於下次結算計入（見 computeSupport 的 lastFactor）
  }
}

export function mintAtSeasonStart(w: WorldState): void {
  const m = w.policies.mintPerSeason;
  if (m > 0) {
    w.settlement.public.cash += m;
    w.settlement.moneySupply += m;
    pushEvent(w, { type: 'MoneyMinted', importance: 1, causeIds: [], actorIds: [], summary: `領袖發行貨幣 ${m}`, data: { amount: m } });
  }
}

export function payLeaderSalary(w: WorldState): void {
  const leader = npcOf(w, w.leadership.leaderId);
  if (!leader) return;
  const pay = Math.min(w.policies.leaderSalaryMonthly, w.settlement.public.cash);
  if (pay <= 0) return;
  w.settlement.public.cash -= pay;
  const hh = hhOf(w, leader.householdId);
  if (hh) hh.cash += pay;
  if (pay > SALARY_BASELINE) w.leadership.salaryOverPaid += pay - SALARY_BASELINE;
}

// ---------- 支持度 ----------

export function groupOf(w: WorldState, n: Npc): number {
  if (n.jobKind === 0) return 3;
  const hh = hhOf(w, n.householdId);
  if (hh?.kind === 2) return 2;
  const e = w.enterprises.find((x) => x.id === n.jobId);
  if (n.jobKind === 1 && e) return e.kind === 'farm' ? 0 : 1;
  return 1;
}

export function favoritismRatioFx(w: WorldState): number {
  const L = w.leadership;
  const spend = L.publicSpendSeason.reduce((a, b) => a + b, 0);
  if (spend < FAVOR_MIN_SPEND) return 0;
  const rel = L.favorRelatives.reduce((a, b) => a + b, 0);
  const tot = L.favorTotal.reduce((a, b) => a + b, 0);
  if (tot === 0) return 0;
  const hh = playerHousehold(w);
  if (!hh || w.npcs.length === 0) return 0;
  const relShare = Math.floor((rel * 1000) / tot);
  const popShare = Math.max(1, Math.floor((hh.memberIds.length * 1000) / w.npcs.length));
  return Math.floor((relShare * 1000) / popShare);
}

/** 損失趨避（2 倍）與享樂適應（每季向基準回歸 25%）。回傳新的滿意度。 */
export function satisfactionStep(sat: number, baseline: number, lastFactor: number, factor: number): { sat: number; baseline: number } {
  const delta = factor - lastFactor;
  const impact = delta >= 0 ? delta : delta * 2; // 損失權重為收益的 2 倍
  const level = clamp(60 + Math.trunc((factor - 650) / 12), 0, 100);
  const prevShock = sat - baseline;
  const shock = Math.trunc((prevShock * 75) / 100) + Math.trunc(impact / 8); // 每季衰減 25%
  return { sat: clamp(level + shock, 0, 100), baseline: level };
}

/** 季末：計算每位成年居民滿意度，依利益群體匯總為支持度（GDD 2.0）。 */
export function computeSupport(w: WorldState): void {
  const S = w.settlement;
  const L = w.leadership;
  const ratio = favoritismRatioFx(w);
  const favorPenalty = ratio > 1500 ? Math.min(700, Math.floor((ratio - 1500) / 5)) : 0;
  const salaryPenalty = Math.min(300, L.salaryOverPaid * 2);
  const groups = [0, 0, 0, 0];
  const counts = [0, 0, 0, 0];
  let fNeeds = 0, fTax = 0, fResp = 0, fFavor = 0, fCrisis = 0, cnt = 0;
  for (const n of w.npcs) {
    if (!isAdult(n)) continue;
    const hh = hhOf(w, n.householdId);
    if (!hh) continue;
    const days = householdDaysOfFood(hh);
    const needs = clamp(Math.min(1000, days * 70) - n.hunger * 5, 0, 1000);
    const tax = clamp(1000 - w.policies.harvestTaxPermille * 4 - w.policies.commerceTaxPermille * 3, 0, 1000);
    const resp = hh.trustLeader * 10;
    const fav = hh.id === L.playerHouseholdId ? 1000 : 1000 - favorPenalty;
    const famineRecent = w.tick - hh.famineTick < 180;
    const crisis = clamp((famineRecent ? 550 : 1000) - salaryPenalty, 0, 1000);
    const factor = Math.floor((W.needs * needs + W.tax * tax + W.response * resp + W.favor * fav + W.crisis * crisis) / 1000);
    const next = satisfactionStep(n.satisfaction, n.satisfactionBaseline, n.lastFactor, factor);
    n.satisfaction = next.sat;
    n.satisfactionBaseline = next.baseline;
    n.lastFactor = factor;
    const g = groupOf(w, n);
    n.interestGroup = g;
    groups[g]! += n.satisfaction;
    counts[g]! += 1;
    fNeeds += needs; fTax += tax; fResp += resp; fFavor += fav; fCrisis += crisis; cnt++;
  }
  const avgs = groups.map((s, i) => (counts[i]! > 0 ? Math.floor(s / counts[i]!) : 0));
  const total = counts.reduce((a, b) => a + b, 0);
  const support = total > 0 ? Math.floor(groups.reduce((a, b) => a + b, 0) / total) : L.support;
  L.support = support;
  const c = Math.max(1, cnt);
  w.supportLog.push({
    tick: w.tick,
    support,
    groups: avgs,
    factors: [
      { name: '需求滿足', value: Math.floor(fNeeds / c) },
      { name: '稅負', value: Math.floor(fTax / c) },
      { name: '提案回應', value: Math.floor(fResp / c) },
      { name: '偏袒感知', value: Math.floor(fFavor / c) },
      { name: '危機處理', value: Math.floor(fCrisis / c) },
    ],
  });
  // 提案信任向 50 回歸
  for (const h of w.households) h.trustLeader += Math.trunc((50 - h.trustLeader) / 10);
  // 偏袒窗口滾動（連續 4 季）
  for (const arr of [L.favorRelatives, L.favorTotal, L.publicSpendSeason]) {
    arr.shift();
    arr.push(0);
  }
  L.salaryOverPaid = Math.trunc((L.salaryOverPaid * 3) / 4);
  void S;
}

// ---------- 改選與繼任 ----------

function adultsOtherThan(w: WorldState, hhId: number): Npc[] {
  return w.npcs.filter((n) => isAdult(n) && n.age >= 18 && n.householdId !== hhId);
}

function bestCandidate(w: WorldState, excludeHh: number): Npc | undefined {
  return adultsOtherThan(w, excludeHh).sort((a, b) => b.satisfaction * 10 + b.skills[3]! - (a.satisfaction * 10 + a.skills[3]!) || a.id - b.id)[0];
}

function headOf(w: WorldState, h: Household): Npc | undefined {
  const adults = h.memberIds.map((id) => npcOf(w, id)).filter((n): n is Npc => !!n && n.age >= 18);
  return adults.sort((a, b) => b.age - a.age || a.id - b.id)[0];
}

function setPlayerControl(w: WorldState, hhId: number): void {
  for (const n of w.npcs) n.controller = n.householdId === hhId ? 'player' : 'ai';
}

export function holdElection(w: WorldState, challengerIsPlayer: boolean): void {
  const L = w.leadership;
  const pHh = playerHousehold(w);
  const incumbent = npcOf(w, L.leaderId);
  const challenger = challengerIsPlayer ? (pHh ? headOf(w, pHh) : undefined) : bestCandidate(w, L.playerHouseholdId);
  if (!challenger || !incumbent) return;
  let forInc = 0;
  let forCh = 0;
  for (const v of w.npcs) {
    if (!isAdult(v) || v.age < 18) continue;
    if (v.householdId === incumbent.householdId && v.householdId !== challenger.householdId) forInc++;
    else if (v.householdId === challenger.householdId && v.householdId !== incumbent.householdId) forCh++;
    else {
      const likesIncumbent = v.satisfaction >= (challengerIsPlayer ? 55 : 50);
      if (likesIncumbent) forInc++;
      else forCh++;
    }
  }
  L.lastElectionTick = w.tick;
  const challengerWins = forCh > forInc;
  pushBio(w, incumbent, forInc >= forCh ? '在改選中勝出' : '在改選中落敗');
  pushEvent(w, { type: 'ElectionHeld', importance: 3, causeIds: [], actorIds: [incumbent.id, challenger.id], summary: `改選：${incumbent.name} ${forInc} 票 對 ${challenger.name} ${forCh} 票`, data: { forInc, forCh } });
  if (!challengerWins) {
    L.lowSupportSeasons = 0;
    if (challengerIsPlayer) {
      L.nextElectionTick = w.tick + 360;
    } else {
      L.support = Math.max(L.support, 45);
    }
    return;
  }
  L.leaderId = challenger.id;
  L.termStartTick = w.tick;
  L.lowSupportSeasons = 0;
  if (challengerIsPlayer) {
    L.playerIsLeader = 1;
    L.mode = 0;
    L.nextElectionTick = -1;
    L.support = 50;
    pushBio(w, challenger, '重新當選領袖');
    pushEvent(w, { type: 'LeaderChanged', importance: 3, causeIds: [], actorIds: [challenger.id], summary: `${challenger.name} 重新當選領袖`, data: {} });
  } else {
    L.playerIsLeader = 0;
    L.mode = 1;
    L.nextElectionTick = w.tick + 360;
    L.support = 50;
    pushEvent(w, { type: 'LeaderChanged', importance: 3, causeIds: [], actorIds: [challenger.id], summary: `${challenger.name} 當選新領袖，玩家家族成為一般村民`, data: {} });
  }
}

/** 領袖死亡：支持度 ≥ 50 由指定繼承人繼任，否則改選（GDD 2.0）。 */
export function handleLeaderGone(w: WorldState): void {
  const L = w.leadership;
  if (npcOf(w, L.leaderId)) return;
  const pHh = playerHousehold(w);
  const pAlive = !!pHh && pHh.memberIds.length > 0;
  if (L.playerIsLeader) {
    if (!pAlive) {
      L.mode = 2;
      L.playerIsLeader = 0;
      const c = bestCandidate(w, -1);
      if (c) L.leaderId = c.id;
      pushEvent(w, { type: 'DynastyEnded', importance: 3, causeIds: [], actorIds: [], summary: '玩家家族已斷絕，請選擇另一個家族或封存紀錄', data: {} });
      return;
    }
    const heir = npcOf(w, L.heirId);
    const eligible = pHh!.memberIds.map((id) => npcOf(w, id)).filter((n): n is Npc => !!n && n.age >= 18);
    if (L.support >= 50 && eligible.length > 0) {
      const next = heir && heir.householdId === pHh!.id && heir.age >= 18 ? heir : eligible.sort((a, b) => b.age - a.age || a.id - b.id)[0]!;
      L.leaderId = next.id;
      L.termStartTick = w.tick;
      L.heirId = 0;
      setPlayerControl(w, pHh!.id);
      pushBio(w, next, '繼任為領袖');
      pushEvent(w, { type: 'LeaderChanged', importance: 3, causeIds: [], actorIds: [next.id], summary: `${next.name} 繼任領袖`, data: {} });
      return;
    }
    const c = bestCandidate(w, pHh!.id);
    if (c) {
      L.leaderId = c.id;
      L.termStartTick = w.tick;
      L.playerIsLeader = 0;
      L.mode = 1;
      L.nextElectionTick = w.tick + 360;
      L.support = 50;
      setPlayerControl(w, pHh!.id);
      pushEvent(w, { type: 'LeaderChanged', importance: 3, causeIds: [], actorIds: [c.id], summary: `支持度不足，改選由 ${c.name} 當選；玩家家族成為一般村民`, data: {} });
    } else if (eligible.length > 0) {
      L.leaderId = eligible[0]!.id;
    }
    return;
  }
  const c = bestCandidate(w, L.playerHouseholdId) ?? w.npcs.filter(isAdult)[0];
  if (c) {
    L.leaderId = c.id;
    L.termStartTick = w.tick;
    pushEvent(w, { type: 'LeaderChanged', importance: 2, causeIds: [], actorIds: [c.id], summary: `${c.name} 接任代理領袖`, data: {} });
  }
}

export function switchFamily(w: WorldState, hhId: number): RespondResult {
  const L = w.leadership;
  if (L.mode !== 2) return { ok: false, reason: 'not_allowed' };
  const hh = hhOf(w, hhId);
  if (!hh || hh.memberIds.length === 0) return { ok: false, reason: 'unknown_household' };
  const head = headOf(w, hh);
  if (!head) return { ok: false, reason: 'no_adult' };
  L.playerHouseholdId = hh.id;
  L.leaderId = head.id;
  L.playerIsLeader = 1;
  L.mode = 0;
  L.support = 50;
  L.termStartTick = w.tick;
  setPlayerControl(w, hh.id);
  pushEvent(w, { type: 'LeaderChanged', importance: 3, causeIds: [], actorIds: [head.id], summary: `玩家改為經營 ${hh.name}，${head.name} 擔任領袖`, data: {} });
  return { ok: true };
}

/** 季末政治：支持度結算後處理改選觸發。 */
export function seasonalElectionCheck(w: WorldState): void {
  const L = w.leadership;
  if (L.mode === 1 && L.nextElectionTick > 0 && w.tick >= L.nextElectionTick) {
    pushEvent(w, { type: 'ElectionWindow', importance: 2, causeIds: [], actorIds: [], summary: '可以再次參選領袖了', data: {} });
  }
  if (!L.playerIsLeader) return;
  if (L.support < 30) L.lowSupportSeasons++;
  else L.lowSupportSeasons = 0;
  if (L.lowSupportSeasons >= 2 && (L.lastElectionTick < 0 || w.tick - L.lastElectionTick >= 360)) holdElection(w, false);
}

export function nominateHeir(w: WorldState, npcId: number): RespondResult {
  const n = npcOf(w, npcId);
  const L = w.leadership;
  if (!n || n.householdId !== L.playerHouseholdId || n.age < 18) return { ok: false, reason: 'invalid_target' };
  L.heirId = npcId;
  return { ok: true };
}

