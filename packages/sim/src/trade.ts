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
