import type { Command } from '@ss/schema';
import type { PrngState } from './prng.js';

export const FOOD = 0;
export const WOOD = 1;
export const STONE = 2;
export const TOOL = 3;
export const FURN = 4;
export const NCOMM = 5;
export const COMM_NAMES = ['糧食', '木材', '石材', '工具', '家具'] as const;
export const zeroStock = (): number[] => [0, 0, 0, 0, 0];

/** 持有現金與庫存的主體（家庭、企業、公共、貿易節點）。 */
export interface Holder {
  cash: number;
  stock: number[];
}

export interface MapState {
  w: number;
  h: number;
  /** 0..3：0 平地 1 緩坡 2 丘陵 3 山 */
  height: number[];
  soil: number[];
  /** 森林存量，每格上限 K（content） */
  forest: number[];
  water: number[];
  /** 礦藏存量 */
  stone: number[];
  /** 0 無 1 土路 2 石路 3 木橋 4 石橋 */
  road: number[];
  /** 建築佔地：building id，0 無 */
  occ: number[];
}

export type BuildingType = 'home' | 'field' | 'lumber' | 'quarry' | 'toolshop' | 'furnshop' | 'market' | 'storage' | 'school' | 'clinic' | 'publichome';
export type BuildingState = 'blueprint' | 'building' | 'active' | 'ruined';

export interface Building {
  id: number;
  type: BuildingType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 出入口格（佔地下方中央）。 */
  ex: number;
  ey: number;
  /** 0 = 公共 */
  ownerHouseholdId: number;
  /** 升級階段 0 起算 */
  stage: number;
  state: BuildingState;
  builtTick: number;
  workId: number;
  /** 家庭自建／公共住宅的容量 */
  capacity: number;
}

export type EntKind = 'farm' | 'lumber' | 'quarry' | 'toolshop' | 'furnshop';
export const ENT_KINDS: EntKind[] = ['farm', 'lumber', 'quarry', 'toolshop', 'furnshop'];
export const OUTPUT_OF: Record<EntKind, number> = { farm: FOOD, lumber: WOOD, quarry: STONE, toolshop: TOOL, furnshop: FURN };

export interface Enterprise extends Holder {
  id: number;
  kind: EntKind;
  buildingId: number;
  ownerHouseholdId: number;
  employeeIds: number[];
  /** 本週徵人名額 */
  openSlots: number;
  lowWeeks: number;
  /** 農田：本季累計有效勞動（FX） */
  accumFx: number;
  /** 工坊與伐木：未滿 1 單位的進度（FX） */
  progressFx: number;
  fertility: number;
  fallow: number;
  /** 0 擴產 1 維持 2 節流 3 停工 */
  strategy: number;
  lossSeasons: number;
  revenueWeek: number;
  costWeek: number;
  profitSeason: number;
  foundedTick: number;
  active: number;
}

export interface Relation {
  targetId: number;
  /** 0 親屬 1 朋友 2 雇用 3 合作 */
  type: number;
  trust: number;
  lastInteraction: number;
}

export interface ExperienceTag {
  type: string;
  strength: number;
  expiresTick: number;
  causeId: number;
}

export interface Npc {
  id: number;
  householdId: number;
  name: string;
  /** 遊戲年齡 */
  age: number;
  birthTick: number;
  sex: number;
  health: number;
  hunger: number;
  energy: number;
  mood: number;
  skills: number[];
  traits: number[];
  riskPreference: number;
  /** 0 無 1 企業 2 公共工程 */
  jobKind: number;
  jobId: number;
  jobSince: number;
  cooldownUntil: number;
  unemployedWeeks: number;
  /** 0 非自願失業 1 休閒；僅對無業者有意義 */
  leisure: number;
  commute: number;
  equipped: number;
  workDaysWeek: number;
  arrears: number;
  lastSector: number;
  x: number;
  y: number;
  /** 0 Idle 1 Evaluate 2 Plan 3 Reserve 4 Travel 5 Execute 6 Settle 7 Cooldown */
  state: number;
  reason: string;
  controller: 'player' | 'ai';
  /** 0 農戶 1 工匠 2 商人 3 無業 */
  interestGroup: number;
  satisfaction: number;
  satisfactionBaseline: number;
  lastFactor: number;
  relations: Relation[];
  tags: ExperienceTag[];
  spouseId: number;
  parentIds: number[];
  illnessUntil: number;
}

export interface Reciprocity {
  targetHouseholdId: number;
  balance: number;
  lastTick: number;
}

export interface Household extends Holder {
  id: number;
  name: string;
  memberIds: number[];
  homeId: number;
  /** 0 農耕 1 工匠 2 商旅 */
  kind: number;
  reciprocity: Reciprocity[];
  safetyDays: number;
  trustLeader: number;
  incomeWeek: number;
  /** 本週與上週無法買足糧食的次數 */
  shortWeeks: number;
  famineTick: number;
}

export interface PublicWork {
  id: number;
  kind: 'building' | 'road' | 'maintenance';
  buildingId: number;
  tiles: { x: number; y: number; type: number }[];
  requiredPDFx: number;
  progressFx: number;
  needed: number[];
  reserved: number[];
  /** 0 等待材料 1 施工中 2 完成 3 取消 */
  state: number;
  startedTick: number;
  causeCommandId: number;
  proposalId: number;
  beneficiaryHouseholdId: number;
  openSlots: number;
  cost: number;
}

export interface Proposal {
  id: number;
  proposerId: number;
  kind: 'road' | 'food_crisis' | 'housing' | 'tools';
  target: { x: number; y: number; toX: number; toY: number; ent: number };
  evidence: number;
  cost: number;
  materials: number[];
  expectedEffects: string;
  createdTick: number;
  expiry: number;
  /** 0 開啟 1 核准 2 延後 3 拒絕 4 過期 */
  status: number;
  priority: number;
}

export interface PendingPolicy {
  key: string;
  value: number;
  effectiveTick: number;
  commandId: number;
}

export interface Policies {
  harvestTaxPermille: number;
  commerceTaxPermille: number;
  agriSubsidy: number;
  housingSubsidy: number;
  mintPerSeason: number;
  leaderSalaryMonthly: number;
  roadPriority: number;
  /** 以工代賑：1 開 0 關 */
  workRelief: number;
  pending: PendingPolicy[];
}

export interface Zone {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 保育區 1 商業用地 */
  kind: number;
}

export interface SimEvent {
  id: number;
  tick: number;
  type: string;
  actorIds: number[];
  causeIds: number[];
  importance: 0 | 1 | 2 | 3;
  summary: string;
  data: Record<string, number | string>;
}

export interface Journal {
  id: number;
  tick: number;
  from: string;
  to: string;
  item: number;
  qty: number;
  unit: number;
  tax: number;
  cause: string;
}

export interface Tombstone {
  id: number;
  name: string;
  birthTick: number;
  deathTick: number;
  householdId: number;
  keyEventIds: number[];
}

export interface GoodsStats {
  produced: number[];
  consumed: number[];
  spoiled: number[];
  imported: number[];
  exported: number[];
}

export interface SupportRecord {
  tick: number;
  support: number;
  groups: number[];
  factors: { name: string; value: number }[];
}

export interface TradeNode extends Holder {
  id: number;
  name: string;
  basePrice: number[];
  /** 成交量對價格的位移（千分比），隨時間回歸 */
  drift: number[];
  transitDays: number;
  capacity: number;
  lossPermille: number;
}

export interface Shipment {
  id: number;
  nodeId: number;
  contents: number[];
  cost: number;
  departTick: number;
  arriveTick: number;
  /** 0 在途 1 已抵達 */
  status: number;
}

export interface Settlement {
  public: Holder;
  moneySupply: number;
  initialMoney: number;
  initialGoods: number[];
  prices: number[];
  expectedPrice: number[][];
  seasonPriceSum: number[];
  seasonPriceN: number;
  priceIndex: number;
  attractiveness: number;
  wage: number[];
  /** 這個季度各部門收成量，供食物檢查 */
  harvestFood: number;
  /** 本季已發放救濟（糧食） */
  reliefFoodSeason: number;
}

export interface Leadership {
  leaderId: number;
  playerHouseholdId: number;
  support: number;
  termStartTick: number;
  nextElectionTick: number;
  lowSupportSeasons: number;
  lastElectionTick: number;
  heirId: number;
  /** 玩家角色目前是否仍為領袖 */
  playerIsLeader: number;
  /** 0 正常 1 AI 代理期間 2 家族斷絕待選擇 */
  mode: number;
  /** 偏袒累計：公共受益（玩家親屬／全體）逐季 */
  favorRelatives: number[];
  favorTotal: number[];
  publicSpendSeason: number[];
  salaryOverPaid: number;
}

export interface WorldState {
  id: string;
  seed: number;
  prng: PrngState;
  tick: number;
  version: number;
  leadership: Leadership;
  env: {
    weather: number;
    rainDaysThisSeason: number;
    /** 本季收成倍率（千分比），事件可調整 */
    yieldPermille: number;
    /** 目前生效的事件效果到期日 */
    effects: { type: string; untilTick: number; value: number }[];
    warnings: { type: string; tick: number; text: string }[];
    lastMajorTick: number;
    mediumThisSeason: number;
    eventCooldowns: { type: string; until: number }[];
  };
  map: MapState;
  roadVersion: number;
  zones: Zone[];
  buildings: Building[];
  enterprises: Enterprise[];
  households: Household[];
  npcs: Npc[];
  tombstones: Tombstone[];
  works: PublicWork[];
  proposals: Proposal[];
  policies: Policies;
  settlement: Settlement;
  nodes: TradeNode[];
  shipments: Shipment[];
  stats: GoodsStats;
  ledger: Journal[];
  ledgerSummary: { year: number; moneyMoved: number; goodsMoved: number; tax: number }[];
  supportLog: SupportRecord[];
  nextIds: { event: number; npc: number; household: number; building: number; enterprise: number; work: number; proposal: number; journal: number; shipment: number };
  pendingCommands: Command[];
  eventLog: SimEvent[];
  /** 偏袒受益紀錄：每筆公共工程完成時的受益家庭 */
  benefits: { tick: number; workId: number; households: number[]; cost: number }[];
  /** 季末摘要，供 UI 顯示 */
  seasonSummary: { tick: number; text: string }[];
}
