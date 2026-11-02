import { COMM_NAMES, NCOMM, type Holder, type WorldState } from './types.js';

/** 主體參照：h<id> 家庭、e<id> 企業、p 公共、n<id> 貿易節點。 */
export type Ref = string;

export function holderOf(w: WorldState, ref: Ref): Holder {
  const kind = ref[0];
  const id = Number(ref.slice(1));
  let h: Holder | undefined;
  if (kind === 'h') h = w.households.find((x) => x.id === id);
  else if (kind === 'e') h = w.enterprises.find((x) => x.id === id);
  else if (kind === 'p') h = w.settlement.public;
  else if (kind === 'n') h = w.nodes.find((x) => x.id === id);
  if (!h) throw new Error(`unknown holder ${ref}`);
  return h;
}

function log(w: WorldState, from: Ref, to: Ref, item: number, qty: number, unit: number, tax: number, cause: string): void {
  w.ledger.push({ id: w.nextIds.journal++, tick: w.tick, from, to, item, qty, unit, tax, cause });
}

/** 轉移貨幣；餘額不足則整筆不生效並回傳 false（原子化）。 */
export function transferMoney(w: WorldState, from: Ref, to: Ref, amount: number, cause: string): boolean {
  if (amount <= 0) return amount === 0;
  const a = holderOf(w, from);
  if (a.cash < amount) return false;
  const b = holderOf(w, to);
  a.cash -= amount;
  b.cash += amount;
  log(w, from, to, -1, amount, 1, 0, cause);
  return true;
}

/** 轉移商品；庫存不足則不生效。 */
export function transferGoods(w: WorldState, from: Ref, to: Ref, item: number, qty: number, cause: string): boolean {
  if (qty <= 0) return qty === 0;
  const a = holderOf(w, from);
  if (a.stock[item]! < qty) return false;
  const b = holderOf(w, to);
  a.stock[item]! -= qty;
  b.stock[item]! += qty;
  log(w, from, to, item, qty, 0, 0, cause);
  return true;
}

/**
 * 成交：商品與貨幣一併原子轉移；稅由賣方收入扣除並入公共帳戶。
 * 任一側不足則整筆回滾並回傳 false。
 */
export function settleTrade(w: WorldState, buyer: Ref, seller: Ref, item: number, qty: number, unit: number, taxPermille: number, cause: string): boolean {
  if (qty <= 0) return false;
  const b = holderOf(w, buyer);
  const s = holderOf(w, seller);
  const total = qty * unit;
  if (b.cash < total || s.stock[item]! < qty) return false;
  const tax = Math.floor((total * taxPermille) / 1000);
  b.cash -= total;
  s.cash += total - tax;
  w.settlement.public.cash += tax;
  s.stock[item]! -= qty;
  b.stock[item]! += qty;
  log(w, buyer, seller, item, qty, unit, tax, cause);
  return true;
}

export function addProduced(w: WorldState, h: Holder, item: number, qty: number): void {
  h.stock[item]! += qty;
  w.stats.produced[item]! += qty;
}

export function consume(w: WorldState, h: Holder, item: number, qty: number): number {
  const q = Math.min(qty, h.stock[item]!);
  h.stock[item]! -= q;
  w.stats.consumed[item]! += q;
  return q;
}

export function totalMoney(w: WorldState): number {
  let t = w.settlement.public.cash;
  for (const h of w.households) t += h.cash;
  for (const e of w.enterprises) t += e.cash;
  for (const n of w.nodes) t += n.cash;
  return t;
}

export function totalGoods(w: WorldState): number[] {
  const out = [0, 0, 0, 0, 0];
  const add = (s: number[]): void => {
    for (let i = 0; i < NCOMM; i++) out[i]! += s[i]!;
  };
  add(w.settlement.public.stock);
  for (const h of w.households) add(h.stock);
  for (const e of w.enterprises) add(e.stock);
  for (const x of w.works) if (x.state < 2) add(x.reserved);
  for (const s of w.shipments) if (s.status === 0) add(s.contents);
  return out;
}

export const commName = (i: number): string => COMM_NAMES[i] ?? String(i);

/** 年度檢查點：2 年以前的帳本明細壓縮為年度摘要（GDD 7.9、12.2）。 */
export function compactLedger(w: WorldState, currentYear: number): void {
  const keepFrom = (currentYear - 2) * 360;
  const old = w.ledger.filter((j) => j.tick < keepFrom);
  if (old.length === 0) return;
  const byYear: Record<number, { moneyMoved: number; goodsMoved: number; tax: number }> = {};
  for (const j of old) {
    const y = Math.floor(j.tick / 360) + 1;
    const e = (byYear[y] ??= { moneyMoved: 0, goodsMoved: 0, tax: 0 });
    if (j.item < 0) e.moneyMoved += j.qty;
    else e.goodsMoved += j.qty;
    e.tax += j.tax;
  }
  for (const y of Object.keys(byYear).map(Number).sort((a, b) => a - b)) {
    const e = byYear[y]!;
    w.ledgerSummary.push({ year: y, ...e });
  }
  w.ledger = w.ledger.filter((j) => j.tick >= keepFrom);
}
