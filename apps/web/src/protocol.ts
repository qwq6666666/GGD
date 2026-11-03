import type { CommandResult } from '@ss/schema';
import type { GoalStatus, Building, Enterprise, Household, Leadership, Policies, Proposal, PublicWork, SimEvent, SupportRecord, Tombstone, TradeNode, Shipment, Zone } from '@ss/sim';

export type Speed = 'pause' | 'normal' | 'fast' | 'max';

/** 主執行緒 → Worker。命令的 commandId、issuedTick 與 expectedWorldVersion 由 Worker 蓋章（權威時間）。 */
export type ToWorker =
  | { kind: 'init'; seed: number; family: number; saveText?: string }
  | { kind: 'speed'; speed: Speed }
  | { kind: 'command'; ref: number; type: string; payload: Record<string, unknown> }
  | { kind: 'auto'; on: boolean }
  | { kind: 'save' }
  | { kind: 'exportSave' };

export interface MapData {
  w: number;
  h: number;
  height: number[];
  soil: number[];
  forest: number[];
  water: number[];
  stone: number[];
  road: number[];
  occ: number[];
  zmin: number;
  zmax: number;
}

export interface NpcView {
  id: number;
  name: string;
  age: number;
  householdId: number;
  jobKind: number;
  jobId: number;
  x: number;
  y: number;
  state: number;
  reason: string;
  hunger: number;
  health: number;
  mood: number;
  controller: 'player' | 'ai';
  skills: number[];
  traits: number[];
  satisfaction: number;
  interestGroup: number;
  tags: string[];
  commute: number;
  spouseId: number;
  sex: number;
  bio: string[];
}

export interface Snapshot {
  tick: number;
  date: string;
  year: number;
  season: number;
  dayOfSeason: number;
  weather: number;
  version: number;
  leadership: Leadership;
  policies: Policies;
  pub: { cash: number; stock: number[] };
  prices: number[];
  wages: number[];
  moneySupply: number;
  attractiveness: number;
  stats: { pop: number; foodDays: number; unemployed: number; workforce: number; harvest: number };
  buildings: Building[];
  enterprises: Pick<Enterprise, 'id' | 'kind' | 'buildingId' | 'ownerHouseholdId' | 'employeeIds' | 'cash' | 'stock' | 'fertility' | 'fallow' | 'active'>[];
  households: Pick<Household, 'id' | 'name' | 'memberIds' | 'cash' | 'stock' | 'kind' | 'homeId' | 'trustLeader'>[];
  npcs: NpcView[];
  works: PublicWork[];
  proposals: Proposal[];
  supportLog: SupportRecord[];
  tombstones: Tombstone[];
  events: SimEvent[];
  seasonSummary: { tick: number; text: string }[];
  warnings: { type: string; tick: number; text: string }[];
  zones: Zone[];
  nodes: Pick<TradeNode, 'id' | 'name' | 'basePrice' | 'drift' | 'transitDays' | 'capacity'>[];
  shipments: Shipment[];
  effects: { type: string; untilTick: number; value: number }[];
  mapSnaps: { tick: number; grid: number[] }[];
  mapKey: string;
  progress: { stage: number; max: number; name: string; icon: string; goals: GoalStatus[]; needed: number };
}

/** Worker → 主執行緒。渲染層只讀取快照，不得改寫模擬狀態（GDD 11.2）。 */
export type FromWorker =
  | { kind: 'snapshot'; snap: Snapshot; speed: Speed }
  | { kind: 'map'; key: string; map: MapData }
  | { kind: 'commandResult'; ref: number; result: CommandResult }
  | { kind: 'saved'; text: string; reason: 'manual' | 'season' | 'background' }
  | { kind: 'export'; text: string }
  | { kind: 'alert'; text: string }
  | { kind: 'auto'; on: boolean; note?: string }
  | { kind: 'error'; message: string };
