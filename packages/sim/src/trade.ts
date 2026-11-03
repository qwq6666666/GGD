import { ECON } from '@ss/content';
import { toDate } from './calendar.js';
import { pushEvent } from './history.js';
import { transferMoney } from './ledger.js';
import type { WorldState } from './types.js';
import { NCOMM } from './types.js';

/** 節點當前價：基準價 × (1 + 位移)，位移隨成交量變動（每 100 單位約 ±5%）並逐週回歸。 */
export function nodePrice(w: WorldState, nodeId: number, item: number): number {
  const n = w.nodes.find((x) => x.id === nodeId);
  if (!n) return 0;
  return Math.max(1, Math.floor((n.basePrice[item]! * (1000 + n.drift[item]!)) / 1000));
}

export function weeklyNodeRecovery(w: WorldState): void {
  for (const n of w.nodes) for (let c = 0; c < NCOMM; c++) n.drift[c] = Math.trunc((n.drift[c]! * 9) / 10);
}

export type OrderResult = { ok: true } | { ok: false; reason: string };

/** 公共帳戶向貿易節點採購：商品記為在途 Shipment，運抵日入庫（GDD 7.6）。 */
export function orderImport(w: WorldState, nodeId: number, item: number, qty: number, _commandId: number): OrderResult {
  const n = w.nodes.find((x) => x.id === nodeId);
  if (!n) return { ok: false, reason: 'unknown_node' };
  if (item < 0 || item >= NCOMM || !Number.isInteger(qty) || qty <= 0) return { ok: false, reason: 'invalid_target' };
  const inTransit = w.shipments.filter((s) => s.nodeId === nodeId && s.status === 0).reduce((s, x) => s + x.contents.reduce((a, b) => a + b, 0), 0);
  if (qty + inTransit > n.capacity) return { ok: false, reason: 'node_capacity' };
  const unit = nodePrice(w, nodeId, item);
  const cost = unit * qty;
  if (w.settlement.public.cash < cost) return { ok: false, reason: 'insufficient_budget' };
  if (!transferMoney(w, 'p', 'n' + nodeId, cost, 'import')) return { ok: false, reason: 'insufficient_budget' };
  const lost = Math.floor((qty * n.lossPermille) / 1000);
  const contents = [0, 0, 0, 0, 0];
  contents[item] = qty - lost;
  w.stats.imported[item]! += qty - lost;
  n.drift[item] = Math.min(400, n.drift[item]! + Math.floor((qty * 50) / 100));
  w.shipments.push({ id: w.nextIds.shipment++, nodeId, contents, cost, departTick: w.tick, arriveTick: w.tick + n.transitDays, status: 0 });
  w.leadership.publicSpendSeason[3]! += cost;
  pushEvent(w, { type: 'ShipmentDeparted', importance: 1, causeIds: [], actorIds: [], summary: `向${n.name}採購 ${qty}（${ECON.basePrice.length > item ? ['糧食', '木材', '石材', '工具', '家具'][item] : ''}），${n.transitDays} 日後運抵，運費損耗 ${lost}`, data: { nodeId, item, qty } });
  return { ok: true };
}

/**
 * 常平倉賣出盈餘：公共糧倉在「保留天數」之外的糧食，每週最多賣一批給出價最高的貿易節點，
 * 價格打折，賣出會壓低節點糧價；貨幣與商品都記入帳本，出口計入 stats.exported（ADR-0010）。
 * 公庫已經寬裕（高於 cashCeiling）時不賣，避免無謂壓低節點價格。
 */
export function granaryAutoSell(w: WorldState): void {
  const G = ECON.granarySale;
  const pub = w.settlement.public;
  if (pub.cash >= G.cashCeiling || w.nodes.length === 0) return;
  // 乾旱期間或預警中不賣，糧倉是防災的最後一道線
  if (w.env.yieldPermille < 1000 || w.env.effects.some((e) => e.type === 'drought' && e.untilTick > w.tick) || w.env.warnings.some((x) => x.type === 'drought')) return;
  const keep = w.npcs.length * G.keepDays;
  const surplus = pub.stock[0]! - keep;
  const qty = Math.min(surplus, G.weeklyMax);
  if (qty < G.minBatch) return;
  let best = w.nodes[0]!;
  for (const n of w.nodes) if (nodePrice(w, n.id, 0) > nodePrice(w, best.id, 0)) best = n;
  const unit = Math.max(1, Math.floor((nodePrice(w, best.id, 0) * (1000 - G.discountPermille)) / 1000));
  const q = Math.min(qty, best.capacity, Math.floor(best.cash / unit));
  if (q < G.minBatch) return;
  if (!transferMoney(w, 'n' + best.id, 'p', unit * q, 'granary-sale')) return;
  pub.stock[0]! -= q;
  w.stats.exported[0]! += q;
  best.drift[0] = Math.max(-400, best.drift[0]! - Math.floor((q * G.driftStep) / 100));
  pushEvent(w, { type: 'GranarySold', importance: 1, causeIds: [], actorIds: [], summary: `糧倉盈餘賣給${best.name} ${q} 糧，得 ${unit * q} 文`, data: { nodeId: best.id, qty: q } });
}

/** 每日：到期的在途貨物入庫。 */
export function dailyShipments(w: WorldState): void {
  for (const s of w.shipments) {
    if (s.status !== 0 || s.arriveTick > w.tick) continue;
    s.status = 1;
    for (let c = 0; c < NCOMM; c++) w.settlement.public.stock[c]! += s.contents[c]!;
    pushEvent(w, { type: 'ShipmentArrived', importance: 1, causeIds: [], actorIds: [], summary: '貿易貨物運抵，入公共庫存', data: { shipmentId: s.id } });
  }
  void toDate;
}
