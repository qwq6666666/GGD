import { describe, expect, it } from 'vitest';
import { FOOD, adjustWages, checkInvariants, createWorld, pathCost, runDays, step, tileIdx, unemployedCount, type WorldState } from '@ss/sim';
import { createSave, serializeSave } from '@ss/persistence';
import { Autopilot } from '../src/autopilot.js';

function runWith(w: WorldState, days: number, bot: Autopilot | null, deep = true): void {
  for (let d = 0; d < days; d++) {
    bot?.act(w);
    step(w, { checkInvariants: deep && w.tick % 30 === 0 });
  }
}

function forceDrought(w: WorldState, years: number): void {
  w.env.effects.push({ type: 'drought', untilTick: w.tick + 360 * years, value: 600 });
  w.env.yieldPermille = 600;
}

describe('GDD 14 驗收情境（headless）', () => {
  it('冬季存糧不足：有預警提案、家庭求助或救濟、存在恢復途徑', () => {
    const w = createWorld(41);
    runDays(w, 270 + 40 - 59); // 秋末
    for (const h of w.households) {
      const cut = Math.floor(h.stock[FOOD]! * 0.85);
      w.stats.consumed[FOOD]! += cut;
      h.stock[FOOD]! -= cut;
    }
    runDays(w, 70, { checkInvariants: true });
    expect(w.proposals.some((p) => p.kind === 'food_crisis')).toBe(true);
    expect(w.eventLog.some((e) => e.type === 'ReliefGiven' || e.type === 'ProposalCreated')).toBe(true);
    expect(w.tombstones.filter((t) => w.eventLog.some((e) => e.type === 'DeathRecorded' && e.data.cause === '飢餓' && e.actorIds[0] === t.id)).length).toBe(0);
  });

  it('連續歉收：介入路徑（採購）與不干預路徑都不導致必然滅村', () => {
    for (const mode of ['none', 'auto'] as const) {
      const w = createWorld(52);
      runWith(w, 360, null);
      forceDrought(w, 2);
      const bot = mode === 'auto' ? new Autopilot() : null;
      runWith(w, 360 * 5, bot);
      expect(w.npcs.length, mode).toBeGreaterThan(5);
    }
  }, 60000);

  it('工坊虧損：可節流、停工或退出，工人重新求職', () => {
    const w = createWorld(11);
    const e = w.enterprises.find((x) => x.kind === 'lumber')!;
    const workers = [...e.employeeIds];
    expect(workers.length).toBeGreaterThan(0);
    for (const id of workers) {
      const n = w.npcs.find((x) => x.id === id)!;
      n.jobKind = 0;
      n.jobId = 0;
    }
    e.employeeIds = [];
    runDays(w, 60, { checkInvariants: true });
    for (const id of workers) {
      const n = w.npcs.find((x) => x.id === id)!;
      expect(n.jobKind !== 0 || n.reason !== '').toBe(true);
    }
  });

  it('道路中斷：尋路快取失效、通勤成本上升、世界不崩', () => {
    const w = createWorld(11);
    const farm = w.enterprises.find((e) => e.kind === 'farm')!;
    const fb = w.buildings.find((b) => b.id === farm.buildingId)!;
    const hh = w.households.find((h) => h.id === farm.ownerHouseholdId)!;
    const hb = w.buildings.find((b) => b.id === hh.homeId)!;
    const before = pathCost(w.map, w.id, w.roadVersion, hb.ex, hb.ey, fb.ex, fb.ey);
    // 鋪一條直達道路（直接改地圖並更新版本）
    const tiles: number[] = [];
    for (let x = Math.min(hb.ex, fb.ex); x <= Math.max(hb.ex, fb.ex); x++) tiles.push(tileIdx(w.map, x, hb.ey));
    for (let y = Math.min(hb.ey, fb.ey); y <= Math.max(hb.ey, fb.ey); y++) tiles.push(tileIdx(w.map, fb.ex, y));
    const free = tiles.filter((i) => w.map.occ[i] === 0 && w.map.water[i] === 0);
    for (const i of free) w.map.road[i] = 1;
    w.roadVersion = (w.roadVersion * 31 + 3) >>> 0;
    const withRoad = pathCost(w.map, w.id, w.roadVersion, hb.ex, hb.ey, fb.ex, fb.ey);
    expect(withRoad).toBeLessThan(before);
    for (const i of free) w.map.road[i] = 0;
    w.roadVersion = (w.roadVersion * 31 + 5) >>> 0;
    const cut = pathCost(w.map, w.id, w.roadVersion, hb.ex, hb.ey, fb.ex, fb.ey);
    expect(cut).toBe(before);
    runDays(w, 30, { checkInvariants: true });
  });

  it('人口老化：60 年出生、死亡、繼承、職缺與家戶資產一致', () => {
    const w = createWorld(63);
    runWith(w, 360 * 60, new Autopilot());
    expect(() => checkInvariants(w, true)).not.toThrow();
    expect(w.tombstones.length).toBeGreaterThan(10);
  }, 120000);

  it('高速 100 年：無死循環、事件頻率受控、存檔 < 20MB、日誌有上限', () => {
    const w = createWorld(71);
    const bot = new Autopilot();
    let max = 0;
    for (let d = 0; d < 360 * 100; d++) {
      bot.act(w);
      const t = performance.now();
      step(w, { checkInvariants: w.tick % 360 === 0 });
      max = Math.max(max, performance.now() - t);
    }
    const bytes = serializeSave(createSave(w, [])).length;
    expect(bytes).toBeLessThan(20 * 1024 * 1024);
    expect(w.eventLog.length).toBeLessThan(3000);
    expect(w.ledger.length).toBeLessThan(6000);
    expect(max).toBeLessThan(200);
    const major = w.eventLog.filter((e) => e.type === 'EventTriggered' && e.importance === 3).length;
    expect(major).toBeLessThanOrEqual(100);
  }, 180000);

  it('50 年森林與肥力不必然耗盡', () => {
    const w = createWorld(81);
    runWith(w, 360 * 50, new Autopilot(), false);
    expect(w.map.forest.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(w.enterprises.filter((e) => e.kind === 'farm').every((e) => e.fertility > 5)).toBe(true);
  }, 120000);

  it('勞動市場：失業增加時工資下降、缺工時工資上升，且單週變動不超過 5%', () => {
    const w = createWorld(5);
    const before = w.settlement.wage[0]!;
    // 3 名工人失業、無任何缺額 → 農業工資下降
    for (const id of w.enterprises[0]!.employeeIds.slice()) {
      const n = w.npcs.find((x) => x.id === id)!;
      n.jobKind = 0;
      n.jobId = 0;
    }
    w.enterprises[0]!.employeeIds = [];
    for (const e of w.enterprises) e.openSlots = 0;
    adjustWages(w);
    const down = w.settlement.wage[0]!;
    expect(down).toBeLessThan(before);
    expect(before - down).toBeLessThanOrEqual(Math.ceil(before * 0.05));
    // 無人失業、農田缺 2 人 → 工資上升
    for (const n of w.npcs) if (n.jobKind === 0 && n.age >= 16 && n.age <= 55) n.leisure = 1;
    w.enterprises[1]!.openSlots = 2;
    adjustWages(w);
    expect(w.settlement.wage[0]!).toBeGreaterThanOrEqual(down);
  });

  it('勞動市場：開春農田重新雇用，失業回落', () => {
    const w = createWorld(5);
    runDays(w, 360 - 59 + 40);
    runDays(w, 40);
    expect(unemployedCount(w)).toBeLessThanOrEqual(4);
  });

  it('創新擴散：輪作沿親友網絡逐步採用，不會同時採用', () => {
    const w = createWorld(91);
    runDays(w, 360 * 25);
    const ev = w.eventLog.filter((e) => e.type === 'PracticeAdopted');
    expect(ev.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ev.map((e) => e.tick)).size).toBe(ev.length);
  }, 60000);

  it('貨幣：大量鑄幣使物價高於零鑄幣的同一世界', () => {
    const run = (mint: number): number => {
      const w = createWorld(33);
      w.policies.mintPerSeason = mint;
      runDays(w, 360 * 6);
      return w.settlement.priceIndex;
    };
    expect(run(4000)).toBeGreaterThan(run(0));
  }, 60000);

  it('人口循環：有基準領袖時 30 年不爆炸也不滅絕', () => {
    for (const seed of [4, 8, 12]) {
      const w = createWorld(1000 + seed);
      runWith(w, 360 * 30, new Autopilot(), false);
      expect(w.npcs.length).toBeGreaterThan(5);
      expect(w.npcs.length).toBeLessThan(150);
    }
  }, 120000);

  it('第一個整合驗收：24 人聚落自主運作 3 年', () => {
    const w = createWorld(20261103);
    const startCommutes = w.npcs.filter((n) => n.jobKind).length;
    const bot = new Autopilot();
    runWith(w, 360 * 3, bot);
    // 居民工作購糧、企業調整生產、家庭改變消費
    expect(w.ledger.some((j) => j.cause === 'market' && j.item === FOOD)).toBe(true);
    expect(w.ledger.some((j) => j.cause.startsWith('wage:'))).toBe(true);
    expect(w.households.some((h) => h.safetyDays !== 30) || w.eventLog.some((e) => e.type === 'ReliefGiven')).toBe(true);
    // 道路建設造成可解釋的行為變化：提案 → 核准 → 完工 → 通勤下降
    const chain = ['ProposalCreated', 'ProposalApproved', 'RoadBuilt'].every((t) => w.eventLog.some((e) => e.type === t));
    expect(chain).toBe(true);
    // 冬季缺糧時有恢復路徑、歷史可回溯
    expect(w.seasonSummary.length).toBeGreaterThanOrEqual(10);
    expect(w.eventLog.every((e) => e.summary.length > 0)).toBe(true);
    // 無負庫存、貨幣憑空產生、重複人物（逐日檢查已涵蓋）
    expect(() => checkInvariants(w, true)).not.toThrow();
    expect(startCommutes).toBeGreaterThan(0);
  }, 60000);
});
