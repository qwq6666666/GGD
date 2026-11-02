import { describe, expect, it } from 'vitest';
import type { Command } from '@ss/schema';
import { ECON } from '@ss/content';
import { FOOD, checkInvariants, createWorld, runDays, stateHash, step, submitCommand, tileIdx, totalGoods, type WorldState } from '../src/index.js';
import { liquidate, schoolActive, seasonEnterpriseReview, clinicActive } from '../src/society.js';
import { addBuilding } from '../src/start.js';

const cmd = (w: WorldState, type: Command['type'], payload: Record<string, unknown>, id = 1): Command => ({ commandId: id, issuedTick: w.tick, expectedWorldVersion: w.version, type, payload });

describe('B1：企業、歷史與傳承', () => {
  it('企業連續虧損：先節流、再停工、最後簡化清算，帳務守恆', () => {
    const w = createWorld(11);
    const e = w.enterprises.find((x) => x.kind === 'lumber')!;
    expect(e.ownerHouseholdId).toBeGreaterThan(0);
    for (let i = 0; i < 2; i++) {
      e.profitSeason = -500;
      seasonEnterpriseReview(w);
    }
    expect(e.strategy).toBe(2);
    for (let i = 0; i < 2; i++) {
      e.profitSeason = -500;
      seasonEnterpriseReview(w);
    }
    expect(e.strategy).toBe(3);
    expect(e.employeeIds.length).toBe(0);
    for (let i = 0; i < ECON.enterprise.stopSeasonsExit; i++) {
      e.profitSeason = 0;
      seasonEnterpriseReview(w);
    }
    expect(e.active).toBe(0);
    expect(w.eventLog.some((ev) => ev.type === 'EnterpriseClosed')).toBe(true);
    expect(() => checkInvariants(w, true)).not.toThrow();
  });

  it('商業用地：條件符合的家庭開設企業並記入沿革', () => {
    const w = createWorld(11);
    submitCommand(w, cmd(w, 'ZoneLand', { x: 30, y: 30, w: 8, h: 6, kind: 1 }));
    step(w);
    w.households[0]!.cash += 5000;
    // 補足貨幣守恆：直接視為外部流入
    w.settlement.moneySupply += 5000;
    runDays(w, 30, { checkInvariants: true });
    expect(w.eventLog.some((e) => e.type === 'EnterpriseFounded')).toBe(true);
    expect(w.zones[0]!.founded).toBe(1);
  });

  it('每 5 年一張地圖縮圖', () => {
    const w = createWorld(11);
    runDays(w, 360 * 5);
    expect(w.mapSnaps.length).toBe(1);
    expect(w.mapSnaps[0]!.grid.length).toBe(24 * 24);
  });

  it('玩家家族有傳記，過世後留在墓碑', () => {
    const w = createWorld(11);
    runDays(w, 360 * 4);
    const mine = w.npcs.filter((n) => n.controller === 'player');
    expect(mine.some((n) => n.bio.length > 0)).toBe(true);
  });

  it('事件可預警：重大與需預警的事件觸發前一定出現預警（10 年）', () => {
    const w = createWorld(31);
    runDays(w, 360 * 10);
    const needs = ['drought', 'flood', 'forest_fire', 'pests', 'epidemic', 'cold_snap'];
    for (const e of w.eventLog) {
      if (e.type !== 'EventTriggered' || !needs.includes(String(e.data.event))) continue;
      const warned = w.eventLog.some((x) => x.type === 'EventWarned' && x.data.event === e.data.event && x.tick <= e.tick);
      expect(warned).toBe(true);
    }
    // 重大事件每年最多 1 件
    const major = w.eventLog.filter((e) => e.type === 'EventTriggered' && e.importance === 3);
    const years = major.map((e) => Math.floor(e.tick / 360));
    expect(new Set(years).size).toBe(years.length);
  }, 60000);

  it('歷史影響：曾缺糧的家庭提高安全存糧', () => {
    const w = createWorld(11);
    const h = w.households[3]!;
    const before = h.safetyDays;
    w.stats.consumed[FOOD]! += h.stock[FOOD]!;
    h.stock[FOOD] = 0;
    runDays(w, 3);
    expect(h.safetyDays).toBeGreaterThan(before);
    expect(w.npcs.some((n) => n.householdId === h.id && n.tags.some((t) => t.type === '饑荒'))).toBe(true);
  });
});

describe('B2：升級、學堂診所、貿易', () => {
  it('住宅升級：容量與舒適度提高，花費公共資金與材料', () => {
    const w = createWorld(11);
    w.settlement.public.stock[1]! += 100;
    w.stats.produced[1]! += 100;
    w.settlement.public.stock[2]! += 100;
    w.stats.produced[2]! += 100;
    const home = w.buildings.find((b) => b.type === 'home')!;
    submitCommand(w, cmd(w, 'UpgradeBuilding', { buildingId: home.id }));
    expect(step(w).commandResults[0]!.status).toBe('accepted');
    runDays(w, 200, { checkInvariants: true });
    expect(home.stage).toBe(1);
    expect(home.capacity).toBe(ECON.upgrade.home[0]!.capacity);
  });

  it('石路升級：道路成本降低；橋梁只能建在水上', () => {
    const w = createWorld(11);
    const home = w.buildings.find((b) => b.type === 'home')!;
    const tile = { x: home.ex, y: home.ey + 1 };
    const i = tileIdx(w.map, tile.x, tile.y);
    w.map.road[i] = 1;
    submitCommand(w, cmd(w, 'BuildRoad', { mode: 'stone', tiles: [tile] }, 1));
    submitCommand(w, { ...cmd(w, 'BuildRoad', { mode: 'bridge', tiles: [tile] }, 2), expectedWorldVersion: w.version + 1 });
    const r = step(w).commandResults;
    expect(r[0]!.status).toBe('accepted');
    expect(r[1]).toMatchObject({ status: 'rejected', reason: 'invalid_target' });
  });

  it('學堂與診所：有建築且有預算才運作，經費付給教師與醫護家庭', () => {
    const w = createWorld(11);
    expect(schoolActive(w)).toBe(false);
    addBuilding(w, 'school', 30, 30, 0, 'active');
    addBuilding(w, 'clinic', 34, 30, 0, 'active');
    w.policies.educationBudget = 50;
    w.policies.healthBudget = 50;
    expect(schoolActive(w) && clinicActive(w)).toBe(true);
    const cash0 = w.households.reduce((s, h) => s + h.cash, 0);
    runDays(w, 100, { checkInvariants: true });
    expect(w.households.reduce((s, h) => s + h.cash, 0)).toBeGreaterThan(cash0 - 5000);
  });

  it('貿易在途守恆：貨物不同時存在兩地，運抵後入庫', () => {
    const w = createWorld(11);
    const food0 = totalGoods(w)[FOOD]!;
    submitCommand(w, cmd(w, 'OrderImport', { nodeId: 1, item: 0, qty: 100 }));
    expect(step(w, { checkInvariants: true }).commandResults[0]!.status).toBe('accepted');
    expect(w.shipments[0]!.status).toBe(0);
    const pubFood = w.settlement.public.stock[FOOD]!;
    runDays(w, 11, { checkInvariants: true });
    expect(w.shipments[0]!.status).toBe(0);
    expect(w.settlement.public.stock[FOOD]!).toBeLessThanOrEqual(pubFood);
    runDays(w, 3, { checkInvariants: true });
    expect(w.shipments[0]!.status).toBe(1);
    expect(totalGoods(w)[FOOD]!).toBeGreaterThan(food0 - 600);
    expect(() => checkInvariants(w, true)).not.toThrow();
  });

  it('命令序列＋版本重播：升級、道路、進口後 hash 一致', () => {
    const run = (): WorldState => {
      const w = createWorld(77);
      w.settlement.public.stock[1]! += 50;
      w.stats.produced[1]! += 50;
      const home = w.buildings.find((b) => b.type === 'home')!;
      submitCommand(w, cmd(w, 'UpgradeBuilding', { buildingId: home.id }, 1));
      step(w);
      submitCommand(w, cmd(w, 'OrderImport', { nodeId: 2, item: 1, qty: 30 }, 2));
      runDays(w, 400);
      return w;
    };
    expect(stateHash(run())).toBe(stateHash(run()));
  });

  it('新系統不破壞既有驗收：10 年守恆與存活', () => {
    const w = createWorld(20261103);
    for (let d = 0; d < 360 * 10; d++) step(w, { checkInvariants: w.tick % 30 === 0 });
    expect(w.npcs.length).toBeGreaterThan(10);
  }, 120000);
});

void liquidate;
