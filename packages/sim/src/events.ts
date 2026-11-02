import { ECON, EVENTS, NAMES } from '@ss/content';
import { toDate } from './calendar.js';
import { bumpMapVersion, releaseJob } from './econ.js';
import { pushEvent } from './history.js';
import { inBounds, tileIdx } from './map.js';
import { nextInt } from './prng.js';
import { FOOD, type Household, type Npc, type WorldState } from './types.js';
import { bldOf, entOf, hhOf, isAdult, npcOf, removeFrom } from './util.js';
import { clinicActive } from './society.js';

type Template = (typeof EVENTS.templates)[number];

// ---------- 環境 ----------

/** 森林邏輯斯成長（每季）：ΔF = r·F·(1−F/K) + 0.2%K 自然更新，皆為整數（GDD 8.2）。 */
export function forestGrowth(w: WorldState): void {
  const K = ECON.forest.k;
  for (let i = 0; i < w.map.forest.length; i++) {
    const f = w.map.forest[i]!;
    if (f <= 0 || f >= K) continue;
    const grow = Math.floor((f * (K - f) * ECON.forest.rPermille) / (K * 1000)) + Math.floor((K * ECON.forest.regenPermilleOfK) / 1000);
    w.map.forest[i] = Math.min(K, f + grow);
  }
}

export function fuelMultiplier(w: WorldState): number {
  let m = 1;
  for (const e of w.env.effects) if (e.type === 'cold_snap' && e.untilTick > w.tick) m = Math.max(m, e.value);
  return m;
}

// ---------- 事件排程與觸發 ----------

function cooldownOk(w: WorldState, type: string): boolean {
  const c = w.env.eventCooldowns.find((x) => x.type === type);
  return !c || c.until <= w.tick;
}

function setCooldown(w: WorldState, type: string, until: number): void {
  const c = w.env.eventCooldowns.find((x) => x.type === type);
  if (c) c.until = until;
  else w.env.eventCooldowns.push({ type, until });
  w.env.eventCooldowns.sort((a, b) => (a.type < b.type ? -1 : 1));
}

function pickTemplate(w: WorldState, tier: string, season: number): Template | undefined {
  const cands = EVENTS.templates.filter((t) => t.tier === tier && t.seasons.includes(season) && cooldownOk(w, t.type) && !w.env.warnings.some((x) => x.type === t.type));
  const total = cands.reduce((s, t) => s + t.weight, 0);
  if (total === 0) return undefined;
  let r = nextInt(w.prng, total);
  for (const t of cands) {
    if (r < t.weight) return t;
    r -= t.weight;
  }
  return cands[cands.length - 1];
}

function eventText(t: Template): string {
  const m: Record<string, string> = {
    drought: '乾旱', flood: '洪水', forest_fire: '森林大火', pests: '蟲害', epidemic: '疫病', fire: '火災',
    bumper_harvest: '豐收', trade_boom: '商路熱絡', festival: '豐年祭', cold_snap: '寒流', migration_wave: '移民潮',
  };
  return m[t.type] ?? t.type;
}

/** GDD 8.3：事件可預警、可追溯、有恢復途徑；重大事件每年最多 1 件、中等每季最多 2 件。 */
export function dailyEvents(w: WorldState): void {
  const date = toDate(w.tick);
  if (date.dayOfSeason === 1) w.env.mediumThisSeason = 0;
  // 到期的預警 → 觸發
  const due = w.env.warnings.filter((x) => x.tick <= w.tick);
  w.env.warnings = w.env.warnings.filter((x) => x.tick > w.tick);
  for (const wn of due) {
    const t = EVENTS.templates.find((x) => x.type === wn.type);
    if (t) triggerEvent(w, t);
  }
  // 清掉過期效果
  const keep = w.env.effects.filter((e) => e.untilTick > w.tick);
  if (keep.length !== w.env.effects.length) {
    for (const e of w.env.effects) if (e.untilTick <= w.tick) recoverEffect(w, e);
    w.env.effects = keep;
    w.env.yieldPermille = 1000;
    for (const e of keep) if (e.type === 'drought' || e.type === 'bumper_harvest') w.env.yieldPermille = e.value;
  }
  const majorOk = w.tick - w.env.lastMajorTick >= 360 / EVENTS.majorPerYearMax && !w.env.warnings.some((x) => EVENTS.templates.find((t) => t.type === x.type)?.tier === 'major');
  if (majorOk && nextInt(w.prng, 1000) < EVENTS.dailyMajorChancePermille) {
    const t = pickTemplate(w, 'major', date.season);
    if (t) schedule(w, t, true);
  }
  if (w.env.mediumThisSeason < EVENTS.mediumPerSeasonMax && nextInt(w.prng, 1000) < EVENTS.dailyMediumChancePermille) {
    const t = pickTemplate(w, 'medium', date.season);
    if (t) schedule(w, t, false);
  }
}

function schedule(w: WorldState, t: Template, major: boolean): void {
  if (major) w.env.lastMajorTick = w.tick;
  else w.env.mediumThisSeason++;
  setCooldown(w, t.type, w.tick + t.cooldownDays);
  if (t.warningDays > 0) {
    w.env.warnings.push({ type: t.type, tick: w.tick + t.warningDays, text: eventText(t) });
    pushEvent(w, { type: 'EventWarned', importance: 2, causeIds: [], actorIds: [], summary: `預警：${t.warningDays} 日後可能發生${eventText(t)}。恢復途徑：${t.recovery}`, data: { event: t.type, inDays: t.warningDays } });
  } else triggerEvent(w, t);
}

function triggerEvent(w: WorldState, t: Template): void {
  const imp = t.tier === 'major' ? 3 : (t.visibility as 0 | 1 | 2 | 3);
  const until = w.tick + t.durationDays;
  const base = { type: 'EventTriggered', causeIds: [] as number[], actorIds: [] as number[], importance: imp, data: { event: t.type } as Record<string, number | string> };
  switch (t.type) {
    case 'drought':
      w.env.effects.push({ type: 'drought', untilTick: until, value: t.yieldPermille! });
      w.env.yieldPermille = t.yieldPermille!;
      pushEvent(w, { ...base, summary: `乾旱來襲，今季收成預計降至 ${Math.floor(t.yieldPermille! / 10)}%` });
      break;
    case 'bumper_harvest':
      w.env.effects.push({ type: 'bumper_harvest', untilTick: until, value: t.yieldPermille! });
      w.env.yieldPermille = t.yieldPermille!;
      pushEvent(w, { ...base, summary: '風調雨順，今季豐收' });
      break;
    case 'flood': {
      let lost = 0;
      for (let i = 0; i < w.map.road.length; i++) {
        if (w.map.road[i]! >= 1 && w.map.road[i]! !== 4 && nextInt(w.prng, 1000) < t.roadLossPermille!) {
          w.map.road[i] = 0;
          lost++;
        }
      }
      if (lost > 0) {
        bumpMapVersion(w, lost, 1);
        for (const n of w.npcs) n.commute = -2;
      }
      pushEvent(w, { ...base, summary: `洪水沖毀了 ${lost} 格道路，工作通勤變遠`, data: { event: t.type, lost } });
      break;
    }
    case 'forest_fire': {
      const cx = 20 + nextInt(w.prng, 56);
      const cy = 20 + nextInt(w.prng, 56);
      let burned = 0;
      for (let dy = -t.radius!; dy <= t.radius!; dy++) {
        for (let dx = -t.radius!; dx <= t.radius!; dx++) {
          if (dx * dx + dy * dy > t.radius! * t.radius!) continue;
          if (!inBounds(w.map, cx + dx, cy + dy)) continue;
          const i = tileIdx(w.map, cx + dx, cy + dy);
          if (w.map.forest[i]! > 0) {
            w.map.forest[i] = 0;
            burned++;
          }
        }
      }
      if (burned > 0) bumpMapVersion(w, cx, cy);
      pushEvent(w, { ...base, summary: `森林大火燒毀 ${burned} 格林地`, data: { event: t.type, burned } });
      break;
    }
    case 'pests': {
      const farms = w.enterprises.filter((e) => e.kind === 'farm' && e.active);
      const f = farms.length ? farms[nextInt(w.prng, farms.length)]! : undefined;
      if (f) {
        f.fertility = Math.max(0, f.fertility - t.fertilityLoss!);
        pushEvent(w, { ...base, actorIds: [], summary: `蟲害侵襲農田，肥力下降 ${t.fertilityLoss}`, data: { event: t.type, enterpriseId: f.id } });
      }
      break;
    }
    case 'epidemic': {
      w.lastEpidemicTick = w.tick;
      const adults = w.npcs.filter(isAdult);
      let n = 0;
      for (let i = 0; i < t.victims! && adults.length; i++) {
        const v = adults.splice(nextInt(w.prng, adults.length), 1)[0]!;
        v.illnessUntil = clinicActive(w) ? w.tick + Math.ceil(t.durationDays / 2) : until;
        v.health = Math.max(20, v.health - 10);
        n++;
      }
      pushEvent(w, { ...base, summary: `疫病流行，${n} 人臥病 ${t.durationDays} 日`, data: { event: t.type, victims: n } });
      break;
    }
    case 'fire': {
      const es = w.enterprises.filter((e) => e.active && e.kind !== 'farm');
      const e = es.length ? es[nextInt(w.prng, es.length)]! : undefined;
      if (e) {
        for (let c = 0; c < 5; c++) {
          const loss = Math.floor((e.stock[c]! * t.stockLossPermille!) / 1000);
          e.stock[c]! -= loss;
          w.stats.consumed[c]! += loss;
        }
        e.active = 0;
        w.env.effects.push({ type: 'fire_recover', untilTick: until, value: e.id });
        pushEvent(w, { ...base, summary: `火災燒毀工坊庫存，停工 ${t.durationDays} 日`, data: { event: t.type, enterpriseId: e.id } });
      }
      break;
    }
    case 'trade_boom':
      for (const nd of w.nodes) for (let c = 0; c < 5; c++) nd.drift[c] = Math.min(400, nd.drift[c]! + t.driftPermille!);
      pushEvent(w, { ...base, summary: '貿易節點需求熱絡，外地價格上升' });
      break;
    case 'festival':
      for (const n of w.npcs) n.mood = Math.min(100, n.mood + t.moodGain!);
      pushEvent(w, { ...base, summary: '秋收後舉辦豐年祭，村民心情大好' });
      break;
    case 'cold_snap':
      w.env.effects.push({ type: 'cold_snap', untilTick: until, value: t.fuelMultiplier! });
      pushEvent(w, { ...base, summary: `寒流來襲，燃料消耗加倍 ${t.durationDays} 日` });
      break;
    case 'migration_wave':
      immigrate(w, true);
      break;
  }
}

function recoverEffect(w: WorldState, e: { type: string; value: number }): void {
  if (e.type === 'fire_recover') {
    const ent = entOf(w, e.value);
    if (ent) {
      ent.active = 1;
      pushEvent(w, { type: 'EnterpriseReopened', importance: 1, causeIds: [], actorIds: [], summary: '受災工坊復工', data: { enterpriseId: ent.id } });
    }
  }
}

// ---------- 人口流動 ----------

export function attractiveness(w: WorldState): number {
  const slack = w.buildings.filter((b) => (b.type === 'home' || b.type === 'publichome') && b.state === 'active').reduce((s, b) => s + b.capacity, 0) - w.npcs.length;
  const foodRatio = Math.floor((w.settlement.prices[FOOD]! * 1000) / ECON.basePrice[FOOD]!);
  const wage = w.settlement.wage.reduce((a, b) => a + b, 0) / 6;
  const v = 500 + (w.leadership.support - 50) * 5 + Math.floor((wage - 20) * 10) - Math.floor((foodRatio - 1000) / 4) + slack * 15;
  return Math.max(0, Math.min(1000, Math.floor(v)));
}

function vacantHome(w: WorldState): number {
  const used = w.households.map((h) => h.homeId);
  const b = w.buildings.find((x) => (x.type === 'home' || x.type === 'publichome') && x.state === 'active' && !used.includes(x.id));
  return b ? b.id : 0;
}

export function immigrate(w: WorldState, forced: boolean): boolean {
  const home = vacantHome(w);
  if (!home) return false;
  const hid = w.nextIds.household++;
  const surname = NAMES.surnames[(hid * 5) % NAMES.surnames.length]!;
  const hh: Household = {
    id: hid, name: surname + '家', memberIds: [], cash: 400, stock: [60, 20, 0, 0, 0], homeId: home, kind: 0, reciprocity: [],
    safetyDays: ECON.household.safetyDays, trustLeader: 50, incomeWeek: 0, shortWeeks: 0, famineTick: -1000, practices: 0,
  };
  w.households.push(hh);
  // 移入視為貿易順差：貨幣與商品記為明示的外部流入（GDD 7.5、7.9）
  w.settlement.moneySupply += hh.cash;
  for (let c = 0; c < 5; c++) w.stats.imported[c]! += hh.stock[c]!;
  const roles = [28 + nextInt(w.prng, 12), 25 + nextInt(w.prng, 12), 4 + nextInt(w.prng, 8)];
  roles.forEach((age, i) => {
    const id = w.nextIds.npc++;
    const sk = (): number => 25 + nextInt(w.prng, 35);
    const n: Npc = {
      id, householdId: hid, name: surname + NAMES.given[nextInt(w.prng, NAMES.given.length)]!, age, birthTick: w.tick - age * 360, sex: i % 2,
      health: 95, hunger: 0, energy: 80, mood: 65, skills: i < 2 ? [sk(), sk(), sk(), sk()] : [5, 5, 5, 5], traits: [nextInt(w.prng, 3), 3 + nextInt(w.prng, 3)],
      riskPreference: 20 + nextInt(w.prng, 60), jobKind: 0, jobId: 0, jobSince: 0, cooldownUntil: 0, unemployedWeeks: 0, leisure: 0, commute: 0, equipped: 0,
      workDaysWeek: 0, arrears: 0, lastSector: -1, x: 0, y: 0, state: 0, reason: '', controller: 'ai', interestGroup: 3, satisfaction: 60, satisfactionBaseline: 60,
      lastFactor: 600, relations: [], tags: [], spouseId: 0, parentIds: [], illnessUntil: 0, bio: [],
    };
    w.npcs.push(n);
    hh.memberIds.push(id);
  });
  const hb = bldOf(w, home);
  if (hb) for (const id of hh.memberIds) { const n = npcOf(w, id)!; n.x = hb.ex; n.y = hb.ey; }
  void forced;
  pushEvent(w, { type: 'MigrationCompleted', importance: 2, causeIds: [], actorIds: [], summary: `${hh.name} 從貿易節點遷入，聚落被其吸引`, data: { householdId: hid, dir: 'in' } });
  return true;
}

export function emigrate(w: WorldState, n: Npc, reason: string): void {
  releaseJob(w, n, '遷出');
  const hh = hhOf(w, n.householdId);
  if (hh) removeFrom(hh.memberIds, n.id);
  const i = w.npcs.findIndex((x) => x.id === n.id);
  if (i >= 0) w.npcs.splice(i, 1);
  for (const o of w.npcs) o.relations = o.relations.filter((r) => r.targetId !== n.id);
  w.tombstones.push({ id: n.id, name: n.name, birthTick: n.birthTick, deathTick: w.tick, householdId: n.householdId, keyEventIds: [], parentIds: [...n.parentIds], bio: [...n.bio] });
  pushEvent(w, { type: 'MigrationCompleted', importance: 2, causeIds: [], actorIds: [n.id], summary: `${hh?.name ?? ''}的 ${n.name} ${reason}前往河港謀生`, data: { dir: 'out', householdId: n.householdId } });
}

/** 每月遷徙：聚落吸引力高時有家庭移入，低時有人移出（GDD 5.5）。 */
export function monthlyMigration(w: WorldState): void {
  const att = attractiveness(w);
  w.settlement.attractiveness = att;
  if (att > 650 && nextInt(w.prng, 100) < 15) immigrate(w, false);
  if (att < 350) {
    const hard = w.households.filter((h) => h.shortWeeks >= 3 && h.id !== w.leadership.playerHouseholdId).sort((a, b) => b.shortWeeks - a.shortWeeks || a.id - b.id)[0];
    if (hard && nextInt(w.prng, 100) < 20) {
      const cand = hard.memberIds.map((id) => npcOf(w, id)).filter((n): n is Npc => !!n && n.age >= 18 && n.age <= 35 && n.id !== w.leadership.leaderId).sort((a, b) => a.age - b.age)[0];
      if (cand && hard.memberIds.length > 1) emigrate(w, cand, '因糧食不足');
    }
  }
  for (const h of w.households) h.shortWeeks = Math.max(0, h.shortWeeks - 1);
}
