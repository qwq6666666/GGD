import { ECON } from '@ss/content';
import type { Command } from '@ss/schema';
import { roadCost } from './civic.js';
import { goalStatus } from './progress.js';
import { findPath } from './path.js';
import { findSpot, inBuildZone, tileBuildable } from './map.js';
import { FOOD, type BuildingType, type WorldState } from './types.js';

/** 電腦自動模式的一項建議行動。只讀世界狀態，不含隨機；由呼叫端決定何時以命令送出。 */
export interface AutoAction {
  type: Command['type'];
  payload: Record<string, unknown>;
  /** 給玩家看的簡短說明 */
  note: string;
}

/** 核准提案時公庫要留的底；蓋新東西時留更多，讓提案優先 */
const RESERVE = 400;
const BUILD_RESERVE = 1500;
const BUILD_CFG = ECON.build as Record<string, { wood: number; stone: number; personDays: number }>;

/** 每週最後一日（tick % 6 === 5）規劃；呼叫端每天最多送出一項，避免世界版本衝突。 */
export const isAutoPlanDay = (tick: number): boolean => tick % 6 === 5;

export function planAuto(w: WorldState): AutoAction[] {
  const L = w.leadership;
  const out: AutoAction[] = [];
  if (L.mode === 1 && L.nextElectionTick >= 0 && w.tick >= L.nextElectionTick) return [{ type: 'StandForElection', payload: {}, note: '🙋 參選領袖' }];
  if (!L.playerIsLeader || L.mode !== 0) return out;
  const pub = w.settlement.public;
  let cash = pub.cash;
  const wood = pub.stock[1] ?? 0;
  const stone = pub.stock[2] ?? 0;
  let woodLeft = wood;
  let stoneLeft = stone;

  // 1. 提案：付得起且材料夠就核准；否則先延後（只對尚未延後的）
  const props = [...w.proposals].sort((a, b) => a.id - b.id);
  for (const p of props) {
    if (p.status !== 0 && p.status !== 2) continue;
    const needWood = p.materials[1] ?? 0;
    const needStone = p.materials[2] ?? 0;
    // 工資是隨工程進度逐日支付，不是一次扣完，所以只要求先備齊約六成成本
    if (cash - Math.floor(p.cost * 0.6) >= RESERVE && woodLeft >= needWood && stoneLeft >= needStone) {
      out.push({ type: 'RespondProposal', payload: { proposalId: p.id, response: 'approve' }, note: `✔ 核准提案 #${p.id}` });
      cash -= Math.floor(p.cost * 0.6);
      woodLeft -= needWood;
      stoneLeft -= needStone;
    } else if (p.status === 0) {
      out.push({ type: 'RespondProposal', payload: { proposalId: p.id, response: 'defer' }, note: `⏳ 延後提案 #${p.id}（錢或材料不足）` });
    }
  }

  // 2. 春荒前：存糧不足向貿易節點採購
  const season = Math.floor((w.tick % 360) / 90);
  const foodPerCap = Math.floor((w.households.reduce((a, h) => a + h.stock[FOOD]!, 0) + (pub.stock[FOOD] ?? 0)) / Math.max(1, w.npcs.length));
  const inTransit = w.shipments.some((s) => s.status === 0);
  if ((season === 3 || season === 0) && foodPerCap < 28 && !inTransit && cash > 1500) {
    const qty = Math.min(400, Math.floor((cash - 800) / 14));
    if (qty >= 50) {
      out.push({ type: 'OrderImport', payload: { nodeId: 1, item: FOOD, qty }, note: `🚚 採購糧食 ${qty}` });
      cash -= qty * 14;
    }
  }

  // 3. 學堂、診所啟用後設定預算（只在尚未設定時）
  const active = (t: BuildingType): number => w.buildings.filter((b) => b.type === t && b.state === 'active').length;
  if (active('school') > 0 && w.policies.educationBudget === 0 && !w.policies.pending.some((p) => p.key === 'educationBudget')) out.push({ type: 'SetPolicy', payload: { key: 'educationBudget', value: 40 }, note: '🏫 編列教育預算' });
  if (active('clinic') > 0 && w.policies.healthBudget === 0 && !w.policies.pending.some((p) => p.key === 'healthBudget')) out.push({ type: 'SetPolicy', payload: { key: 'healthBudget', value: 40 }, note: '⚕ 編列醫療預算' });

  // 4. 支持度偏低：降低收成稅（低於 45 且稅率高於 20‰）
  if (L.support < 45 && w.policies.harvestTaxPermille > 20 && !w.policies.pending.some((p) => p.key === 'harvestTaxPermille')) {
    out.push({ type: 'SetPolicy', payload: { key: 'harvestTaxPermille', value: Math.max(20, w.policies.harvestTaxPermille - 10) }, note: '📉 支持度低，降收成稅' });
  }

  // 5. 朝目標推進：一次只開一項新工程
  const busy = w.works.some((x) => x.kind !== 'maintenance' && x.state < 2);
  if (!busy) {
    const goals = goalStatus(w).filter((g) => !g.done);
    const wage = w.settlement.wage[5] ?? 0;
    const place = (type: BuildingType, nx: number, ny: number, label: string): AutoAction | null => {
      const cfg = BUILD_CFG[type === 'publichome' ? 'home' : type === 'school' || type === 'clinic' ? 'storage' : type];
      if (!cfg || cash - cfg.personDays * wage < BUILD_RESERVE || woodLeft < cfg.wood || stoneLeft < cfg.stone) return null;
      const spot = findSpot(w.map, w.buildings, type, nx, ny);
      return spot ? { type: 'PlaceBuilding', payload: { type, x: spot.x, y: spot.y }, note: label } : null;
    };
    const cx = (w.map.zmin + w.map.zmax) >> 1;
    for (const g of goals) {
      let a: AutoAction | null = null;
      if (g.id === 's0-field') a = place('field', 46, 60, '🌾 開墾新農田');
      else if (g.id === 's0-road') a = roadAction(w, cash, woodLeft, wage);
      else if (g.id === 's1-school') a = place('school', cx, cx, '🏫 興建學堂');
      else if (g.id === 's2-home') a = place('publichome', cx - 4, cx + 4, '🏘 興建公共住宅');
      else if (g.id === 's2-stone') a = stoneRoadAction(w, cash, stoneLeft, wage);
      if (a) {
        out.push(a);
        break;
      }
    }
    // 目標以外的基本建設：村階段後蓋診所、劃商業用地帶動企業
    if (!out.some((x) => x.type === 'PlaceBuilding' || x.type === 'BuildRoad') && w.progress.stage >= 1) {
      if (active('clinic') === 0 && w.npcs.length >= 28) {
        const a = place('clinic', cx + 3, cx, '⚕ 興建診所');
        if (a) out.push(a);
      } else if (w.zones.every((z) => z.kind !== 1) && cash > 3000) {
        const r = findZoneRect(w, 6, 4);
        if (r) out.push({ type: 'ZoneLand', payload: { ...r, kind: 1 }, note: '💼 劃設商業用地' });
      }
    }
  }
  return out;
}

/** 從家到農田的土路：只鋪還沒有路、不在水上的格子。 */
function roadAction(w: WorldState, cash: number, woodLeft: number, wage: number): AutoAction | null {
  const homes = w.buildings.filter((b) => (b.type === 'home' || b.type === 'publichome') && b.state === 'active').sort((a, b) => a.id - b.id);
  const fields = w.buildings.filter((b) => b.type === 'field' && b.state === 'active').sort((a, b) => a.id - b.id);
  for (const f of fields) {
    for (const h of homes) {
      const p = findPath(w.map, h.ex, h.ey, f.ex, f.ey);
      if (!p) continue;
      const tiles: { x: number; y: number }[] = [];
      for (const i of p.steps) {
        const x = i % w.map.w;
        const y = Math.floor(i / w.map.w);
        if (w.map.road[i] === 0 && w.map.water[i] === 0 && w.map.occ[i] === 0 && w.map.stone[i] === 0 && inBuildZone(w.map, x, y)) tiles.push({ x, y });
        if (tiles.length >= 30) break;
      }
      if (tiles.length < 2) continue;
      const c = roadCost(w, tiles.length);
      if (cash - c.pd * wage < BUILD_RESERVE || woodLeft < (c.materials[1] ?? 0)) continue;
      return { type: 'BuildRoad', payload: { mode: 'dirt', tiles }, note: `🟫 鋪路 ${tiles.length} 格` };
    }
  }
  return null;
}

/** 把既有土路升級為石路（最多 15 格，石材夠才做）。 */
function stoneRoadAction(w: WorldState, cash: number, stoneLeft: number, wage: number): AutoAction | null {
  const tiles: { x: number; y: number }[] = [];
  for (let i = 0; i < w.map.road.length && tiles.length < 15; i++) {
    if (w.map.road[i] === 1 && w.map.occ[i] === 0) tiles.push({ x: i % w.map.w, y: Math.floor(i / w.map.w) });
  }
  if (tiles.length < 5) return null;
  const c = roadCost(w, tiles.length, 'stone');
  if (cash - c.pd * wage < BUILD_RESERVE || stoneLeft < (c.materials[2] ?? 0)) return null;
  return { type: 'BuildRoad', payload: { mode: 'stone', tiles }, note: `🪨 升級石路 ${tiles.length} 格` };
}

/** 在中心附近找一塊整片可建的空地（由內向外掃描）。 */
function findZoneRect(w: WorldState, rw: number, rh: number): { x: number; y: number; w: number; h: number } | null {
  const c = (w.map.zmin + w.map.zmax) >> 1;
  for (let r = 0; r < 24; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = c + dx;
        const y = c + dy;
        let ok = true;
        for (let yy = y; yy < y + rh && ok; yy++) for (let xx = x; xx < x + rw; xx++) if (!tileBuildable(w.map, xx, yy)) { ok = false; break; }
        if (ok) return { x, y, w: rw, h: rh };
      }
    }
  }
  return null;
}

