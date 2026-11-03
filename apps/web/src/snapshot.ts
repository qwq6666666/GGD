import { goalStatus, MAX_STAGE, stageName, formatDate, householdStats, toDate, type WorldState } from '@ss/sim';
import { GOALS } from '@ss/content';
import type { NpcView, Snapshot } from './protocol.js';

export function buildSnapshot(w: WorldState): Snapshot {
  const d = toDate(w.tick);
  const st = householdStats(w);
  const npcs: NpcView[] = w.npcs.map((n) => ({
    id: n.id, name: n.name, age: n.age, householdId: n.householdId, jobKind: n.jobKind, jobId: n.jobId, x: n.x, y: n.y, state: n.state, reason: n.reason,
    hunger: n.hunger, health: n.health, mood: n.mood, controller: n.controller, skills: n.skills, traits: n.traits, satisfaction: n.satisfaction,
    interestGroup: n.interestGroup, tags: n.tags.filter((t) => t.expiresTick > w.tick).map((t) => t.type), commute: n.commute, spouseId: n.spouseId, sex: n.sex, bio: n.controller === 'player' ? n.bio : [],
  }));
  return {
    tick: w.tick,
    date: formatDate(w.tick),
    year: d.year,
    season: d.season,
    dayOfSeason: d.dayOfSeason,
    weather: w.env.weather,
    version: w.version,
    leadership: w.leadership,
    policies: w.policies,
    pub: { cash: w.settlement.public.cash, stock: w.settlement.public.stock },
    prices: w.settlement.prices,
    wages: w.settlement.wage,
    moneySupply: w.settlement.public.cash + w.households.reduce((a, h) => a + h.cash, 0) + w.enterprises.reduce((a, e) => a + e.cash, 0),
    attractiveness: w.settlement.attractiveness,
    stats: { pop: w.npcs.length, foodDays: st.foodDays, unemployed: st.unemployed, workforce: st.workforce, harvest: w.settlement.harvestFood },
    buildings: w.buildings,
    enterprises: w.enterprises.map((e) => ({ id: e.id, kind: e.kind, buildingId: e.buildingId, ownerHouseholdId: e.ownerHouseholdId, employeeIds: e.employeeIds, cash: e.cash, stock: e.stock, fertility: e.fertility, fallow: e.fallow, active: e.active })),
    households: w.households.map((h) => ({ id: h.id, name: h.name, memberIds: h.memberIds, cash: h.cash, stock: h.stock, kind: h.kind, homeId: h.homeId, trustLeader: h.trustLeader })),
    npcs,
    works: w.works.filter((x) => x.state < 2),
    proposals: w.proposals.filter((p) => p.status === 0 || p.status === 2),
    supportLog: w.supportLog.slice(-8),
    tombstones: w.tombstones.slice(-30),
    events: w.eventLog.filter((e) => e.importance >= 1).slice(-120),
    seasonSummary: w.seasonSummary.slice(-12),
    warnings: w.env.warnings,
    zones: w.zones,
    nodes: w.nodes.map((n) => ({ id: n.id, name: n.name, basePrice: n.basePrice, drift: n.drift, transitDays: n.transitDays, capacity: n.capacity })),
    shipments: w.shipments.filter((s) => s.status === 0),
    effects: w.env.effects,
    mapSnaps: w.mapSnaps,
    mapKey: `${w.roadVersion}:${Math.floor(w.tick / 90)}`,
    progress: { stage: w.progress.stage, max: MAX_STAGE, name: stageName(w.progress.stage), icon: GOALS.stages[w.progress.stage]?.icon ?? '🏛', goals: goalStatus(w), needed: GOALS.needed },
  };
}
