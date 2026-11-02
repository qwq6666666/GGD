import { CALIBRATION, ECON, NAMES } from '@ss/content';
import { toTick } from './calendar.js';
import { entranceOf, footprintOf, findSpot, generateMap, occupy } from './map.js';
import { nextInt, seedPrng } from './prng.js';
import type { Building, BuildingType, EntKind, Enterprise, Household, Npc, WorldState } from './types.js';
import { zeroStock } from './types.js';

export const SIM_VERSION = '0.2.0-a1';

interface HhPlan {
  name: string;
  kind: number;
  adults: number;
  elders: number;
  children: number;
}

const HH_PLANS: HhPlan[] = [
  { name: '農耕世家', kind: 0, adults: 3, elders: 0, children: 1 },
  { name: '老農之家', kind: 0, adults: 2, elders: 1, children: 1 },
  { name: '新墾之家', kind: 0, adults: 2, elders: 0, children: 2 },
  { name: '工匠家族', kind: 1, adults: 2, elders: 1, children: 1 },
  { name: '樵夫之家', kind: 0, adults: 3, elders: 0, children: 1 },
  { name: '商旅家族', kind: 2, adults: 2, elders: 1, children: 1 },
];

/** 家族種類 → 玩家家戶 id：0 農耕世家、1 工匠家族、2 商旅家族。 */
export const FAMILY_HOUSEHOLD = [1, 4, 6];

// [家戶序, 該戶第幾位成年人] → 職位（見 7.8：9 農 + 5 其他）
const JOB_PLAN: Record<string, string> = {
  '1:0': 'farm1', '1:1': 'farm1', '1:2': 'farm1',
  '2:0': 'farm2', '2:1': 'farm2',
  '3:0': 'farm2', '3:1': 'farm3',
  '4:0': 'toolshop', '4:1': 'furnshop',
  '5:0': 'lumber', '5:1': 'farm3',
  '6:0': 'farm3', '6:1': 'quarry',
};

const BUILD_SPOTS: { key: string; type: BuildingType; x: number; y: number; hh: number }[] = [
  { key: 'market', type: 'market', x: 46, y: 44, hh: 0 },
  { key: 'storage', type: 'storage', x: 51, y: 44, hh: 0 },
  { key: 'home1', type: 'home', x: 40, y: 42, hh: 1 },
  { key: 'home2', type: 'home', x: 43, y: 38, hh: 2 },
  { key: 'home3', type: 'home', x: 52, y: 38, hh: 3 },
  { key: 'home4', type: 'home', x: 56, y: 44, hh: 4 },
  { key: 'home5', type: 'home', x: 39, y: 47, hh: 5 },
  { key: 'home6', type: 'home', x: 55, y: 49, hh: 6 },
  { key: 'farm1', type: 'field', x: 38, y: 52, hh: 1 },
  { key: 'farm2', type: 'field', x: 44, y: 52, hh: 2 },
  { key: 'farm3', type: 'field', x: 58, y: 54, hh: 3 },
  { key: 'lumber', type: 'lumber', x: 35, y: 44, hh: 5 },
  { key: 'quarry', type: 'quarry', x: 60, y: 43, hh: 6 },
  { key: 'toolshop', type: 'toolshop', x: 48, y: 50, hh: 4 },
  { key: 'furnshop', type: 'furnshop', x: 50, y: 40, hh: 4 },
];

export function addBuilding(w: WorldState, type: BuildingType, x: number, y: number, ownerHouseholdId: number, state: Building['state']): Building {
  const fp = footprintOf(type)!;
  const { ex, ey } = entranceOf(type, x, y, fp.w, fp.h);
  const b: Building = {
    id: w.nextIds.building++,
    type,
    x,
    y,
    w: fp.w,
    h: fp.h,
    ex,
    ey,
    ownerHouseholdId,
    stage: 0,
    state,
    builtTick: w.tick,
    workId: 0,
    capacity: type === 'home' || type === 'publichome' ? 5 : 0,
  };
  w.buildings.push(b);
  occupy(w.map, b);
  return b;
}

const FIELD_KIND: Record<string, EntKind> = { field: 'farm', lumber: 'lumber', quarry: 'quarry', toolshop: 'toolshop', furnshop: 'furnshop' };

export function addEnterprise(w: WorldState, b: Building, ownerHouseholdId: number, cash: number, tools = 0): Enterprise {
  const kind = FIELD_KIND[b.type]!;
  const soil = w.map.soil[b.y * w.map.w + b.x] ?? 60;
  const e: Enterprise = {
    id: w.nextIds.enterprise++,
    kind,
    buildingId: b.id,
    ownerHouseholdId,
    cash,
    stock: zeroStock(),
    employeeIds: [],
    openSlots: 0,
    lowWeeks: 0,
    accumFx: 0,
    progressFx: 0,
    fertility: kind === 'farm' ? soil : 0,
    fallow: 0,
    strategy: 1,
    lossSeasons: 0,
    revenueWeek: 0,
    costWeek: 0,
    profitSeason: 0,
    foundedTick: w.tick,
    active: 1,
  };
  e.stock[3] = tools;
  w.enterprises.push(e);
  return e;
}

function makeNpc(w: WorldState, hh: Household, age: number, role: 'adult' | 'elder' | 'child', specialty: number, idxInHh: number): Npc {
  const p = w.prng;
  const sk = (base: boolean): number => (base ? 50 + nextInt(p, 21) : 20 + nextInt(p, 26));
  const skills = [sk(specialty === 0), sk(specialty === 1), sk(specialty === 2), 20 + nextInt(p, 40)];
  if (role === 'child') for (let i = 0; i < 4; i++) skills[i] = 5 + nextInt(p, 10);
  const traits: number[] = [];
  const nTraits = 2 + nextInt(p, 2);
  while (traits.length < nTraits) {
    const t = nextInt(p, 6);
    if (!traits.includes(t)) traits.push(t);
  }
  const surname = NAMES.surnames[(hh.id * 5) % NAMES.surnames.length]!;
  const given = NAMES.given[(hh.id * 7 + idxInHh * 3 + nextInt(p, 4)) % NAMES.given.length]!;
  const id = w.nextIds.npc++;
  return {
    id,
    householdId: hh.id,
    name: surname + given,
    age,
    birthTick: w.tick - age * 360,
    sex: nextInt(p, 2),
    health: 90 + nextInt(p, 11),
    hunger: 0,
    energy: 80,
    mood: 65,
    skills,
    traits: traits.sort((a, b) => a - b),
    riskPreference: 20 + nextInt(p, 60),
    jobKind: 0,
    jobId: 0,
    jobSince: 0,
    cooldownUntil: 0,
    unemployedWeeks: 0,
    leisure: 0,
    commute: 0,
    equipped: 0,
    workDaysWeek: 0,
    arrears: 0,
    lastSector: -1,
    x: 0,
    y: 0,
    state: 0,
    reason: '',
    controller: 'ai',
    interestGroup: 3,
    satisfaction: 60,
    satisfactionBaseline: 60,
    lastFactor: 600,
    relations: [],
    tags: [],
    spouseId: 0,
    parentIds: [],
    illnessUntil: 0,
    bio: [],
  };
}

/** 建立開局世界：6 戶 24 人、3 塊田、5 種商品的生產鏈（GDD 7.8）。 */
export function createWorld(seed: number, family = 0): WorldState {
  const s = CALIBRATION.start;
  const tick = toTick(1, s.startSeason, s.startDayOfSeason);
  const prng = seedPrng(seed);
  const map = generateMap(prng);
  const w: WorldState = {
    id: `world-${seed >>> 0}-${family}`,
    seed: seed >>> 0,
    prng,
    tick,
    version: 0,
    leadership: {
      leaderId: 0,
      playerHouseholdId: FAMILY_HOUSEHOLD[family] ?? 1,
      support: s.initialSupport,
      termStartTick: tick,
      nextElectionTick: -1,
      lowSupportSeasons: 0,
      lastElectionTick: -1,
      heirId: 0,
      playerIsLeader: 1,
      mode: 0,
      favorRelatives: [0, 0, 0, 0],
      favorTotal: [0, 0, 0, 0],
      publicSpendSeason: [0, 0, 0, 0],
      salaryOverPaid: 0,
    },
    env: { weather: 0, rainDaysThisSeason: 0, yieldPermille: 1000, effects: [], warnings: [], lastMajorTick: -1000, mediumThisSeason: 0, eventCooldowns: [] },
    map,
    roadVersion: 1,
    zones: [],
    buildings: [],
    enterprises: [],
    households: [],
    npcs: [],
    tombstones: [],
    works: [],
    proposals: [],
    policies: {
      harvestTaxPermille: ECON.tax.harvestPermille,
      commerceTaxPermille: ECON.tax.commercePermille,
      agriSubsidy: 0,
      housingSubsidy: 0,
      mintPerSeason: 0,
      leaderSalaryMonthly: 60,
      roadPriority: 0,
      workRelief: 1,
      educationBudget: 0,
      healthBudget: 0,
      pending: [],
    },
    settlement: {
      public: { cash: ECON.start.cashPublic, stock: [...ECON.start.publicStock] },
      moneySupply: 0,
      initialMoney: 0,
      initialGoods: [0, 0, 0, 0, 0],
      prices: [...ECON.basePrice],
      expectedPrice: [0, 1, 2, 3].map(() => [...ECON.basePrice]),
      seasonPriceSum: [0, 0, 0, 0, 0],
      seasonPriceN: 0,
      priceIndex: 1000,
      attractiveness: 500,
      wage: [...ECON.wage.start],
      harvestFood: 0,
      reliefFoodSeason: 0,
    },
    nodes: [],
    shipments: [],
    stats: {
      produced: [0, 0, 0, 0, 0],
      consumed: [0, 0, 0, 0, 0],
      spoiled: [0, 0, 0, 0, 0],
      imported: [0, 0, 0, 0, 0],
      exported: [0, 0, 0, 0, 0],
    },
    ledger: [],
    ledgerSummary: [],
    supportLog: [],
    nextIds: { event: 1, npc: 1, household: 1, building: 1, enterprise: 1, work: 1, proposal: 1, journal: 1, shipment: 1 },
    pendingCommands: [],
    eventLog: [],
    benefits: [],
    seasonSummary: [],
    mapSnaps: [],
    lastEpidemicTick: -1000,
  };

  // 建築（公共與各戶）
  const placed: Record<string, Building> = {};
  for (const sp of BUILD_SPOTS) {
    const spot = findSpot(w.map, w.buildings, sp.type, sp.x, sp.y);
    if (!spot) throw new Error(`cannot place ${sp.key}`);
    placed[sp.key] = addBuilding(w, sp.type, spot.x, spot.y, sp.hh, 'active');
  }

  // 家庭與人口
  for (let hi = 0; hi < HH_PLANS.length; hi++) {
    const plan = HH_PLANS[hi]!;
    const hh: Household = {
      id: w.nextIds.household++,
      name: plan.name,
      memberIds: [],
      cash: ECON.start.cashHousehold + (plan.kind === 2 ? 600 : 0),
      stock: [...ECON.start.householdStock],
      homeId: placed[`home${hi + 1}`]!.id,
      kind: plan.kind,
      reciprocity: [],
      safetyDays: ECON.household.safetyDays,
      trustLeader: 50,
      incomeWeek: 0,
      shortWeeks: 0,
      famineTick: -1000,
    };
    w.households.push(hh);
    const members: Npc[] = [];
    for (let i = 0; i < plan.adults; i++) members.push(makeNpc(w, hh, 22 + nextInt(w.prng, 28), 'adult', plan.kind, members.length));
    for (let i = 0; i < plan.elders; i++) members.push(makeNpc(w, hh, 58 + nextInt(w.prng, 10), 'elder', plan.kind, members.length));
    for (let i = 0; i < plan.children; i++) members.push(makeNpc(w, hh, 3 + nextInt(w.prng, 11), 'child', plan.kind, members.length));
    for (const m of members) {
      hh.memberIds.push(m.id);
      w.npcs.push(m);
    }
    // 家庭內親屬關係
    for (const a of members) for (const b of members) if (a.id !== b.id) a.relations.push({ targetId: b.id, type: 0, trust: 80, lastInteraction: tick });
  }
  w.npcs.sort((a, b) => a.id - b.id);

  // 企業與初始職位
  const entOf: Record<string, Enterprise> = {};
  const ownerOf: Record<string, number> = { farm1: 1, farm2: 2, farm3: 3, lumber: 5, quarry: 0, toolshop: 0, furnshop: 0 };
  const mk = (key: string, cash: number): void => {
    const b = placed[key]!;
    entOf[key] = addEnterprise(w, b, ownerOf[key]!, cash, 0);
  };
  mk('farm1', ECON.start.cashFarm);
  mk('farm2', ECON.start.cashFarm);
  mk('farm3', ECON.start.cashFarm);
  mk('lumber', ECON.start.cashWorkshop);
  mk('quarry', ECON.start.cashWorkshop);
  mk('toolshop', ECON.start.cashWorkshop);
  mk('furnshop', ECON.start.cashWorkshop);
  entOf.toolshop!.stock[1] = 40;
  entOf.toolshop!.stock[2] = 20;
  entOf.furnshop!.stock[1] = 40;

  for (const hh of w.households) {
    const adults = hh.memberIds.map((id) => w.npcs.find((n) => n.id === id)!).filter((n) => n.age >= 16 && n.age <= 55);
    adults.forEach((n, i) => {
      const key = JOB_PLAN[`${hh.id}:${i}`];
      if (!key) return;
      const e = entOf[key]!;
      n.jobKind = 1;
      n.jobId = e.id;
      n.jobSince = tick;
      e.employeeIds.push(n.id);
      n.lastSector = ['farm', 'lumber', 'quarry', 'toolshop', 'furnshop'].indexOf(e.kind);
      n.equipped = 1;
      hh.stock[3]! += 1;
      n.commute = -2;
      n.interestGroup = hh.kind === 2 && e.kind !== 'farm' ? 2 : e.kind === 'toolshop' || e.kind === 'furnshop' ? 1 : hh.kind === 1 ? 1 : 0;
    });
    const b = w.buildings.find((x) => x.id === hh.homeId)!;
    for (const id of hh.memberIds) {
      const n = w.npcs.find((x) => x.id === id)!;
      n.x = b.ex;
      n.y = b.ey;
    }
  }
  for (const e of w.enterprises) {
    e.employeeIds.sort((a, b) => a - b);
    if (e.kind === 'farm') e.accumFx = ECON.start.farmAccumFx;
  }
  // 鄰里友誼：每位成年人與後兩戶的成年人互為朋友（供借糧、婚配與人情債使用）
  for (const hh of w.households) {
    for (const off of [1, 2]) {
      const other = w.households[(hh.id - 1 + off) % w.households.length]!;
      const as = hh.memberIds.map((id) => w.npcs.find((n) => n.id === id)!).filter((n) => n.age >= 16);
      const bs = other.memberIds.map((id) => w.npcs.find((n) => n.id === id)!).filter((n) => n.age >= 16);
      as.forEach((a, i) => {
        const b = bs[i % bs.length];
        if (!b || a.relations.some((r) => r.targetId === b.id)) return;
        a.relations.push({ targetId: b.id, type: 1, trust: 50, lastInteraction: tick });
        b.relations.push({ targetId: a.id, type: 1, trust: 50, lastInteraction: tick });
      });
    }
  }

  // 玩家家族：家長為領袖
  const pHh = w.households.find((h) => h.id === w.leadership.playerHouseholdId)!;
  const head = pHh.memberIds.map((id) => w.npcs.find((n) => n.id === id)!).filter((n) => n.age >= 16 && n.age <= 55).sort((a, b) => b.age - a.age)[0]!;
  head.controller = 'player';
  w.leadership.leaderId = head.id;
  for (const id of pHh.memberIds) w.npcs.find((n) => n.id === id)!.controller = 'player';

  // 貿易節點（B2 啟用；開局即建立以固定世界結構）
  w.nodes = [
    { id: 1, name: '河港', cash: 200000, stock: [0, 0, 0, 0, 0], basePrice: [12, 9, 13, 70, 100], drift: [0, 0, 0, 0, 0], transitDays: 12, capacity: 400, lossPermille: 20 },
    { id: 2, name: '山口', cash: 200000, stock: [0, 0, 0, 0, 0], basePrice: [14, 6, 10, 80, 110], drift: [0, 0, 0, 0, 0], transitDays: 18, capacity: 300, lossPermille: 30 },
  ];

  // 初始總量記錄（守恆檢查基準）
  let money = w.settlement.public.cash;
  for (const h of w.households) money += h.cash;
  for (const e of w.enterprises) money += e.cash;
  for (const n of w.nodes) money += n.cash;
  w.settlement.initialMoney = money;
  w.settlement.moneySupply = money;
  const goods = [0, 0, 0, 0, 0];
  for (let c = 0; c < 5; c++) {
    goods[c] = w.settlement.public.stock[c]!;
    for (const h of w.households) goods[c]! += h.stock[c]!;
    for (const e of w.enterprises) goods[c]! += e.stock[c]!;
  }
  w.settlement.initialGoods = goods;
  return w;
}
