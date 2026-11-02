import { toDate } from './calendar.js';
import type { Npc, SimEvent, WorldState } from './types.js';

export type NewEvent = Omit<SimEvent, 'id' | 'tick'>;

export function pushEvent(w: WorldState, e: NewEvent): SimEvent {
  const ev: SimEvent = { id: w.nextIds.event++, tick: w.tick, ...e };
  w.eventLog.push(ev);
  return ev;
}

/** 年度資料保留（GDD 12.2）：低重要度事件只留 1 年，其餘永久；NPC 記憶有上限。 */
export function compactHistory(w: WorldState, tick: number): void {
  const keepFrom = tick - 360;
  w.eventLog = w.eventLog.filter((e) => e.importance >= 2 || e.tick >= keepFrom);
  if (w.supportLog.length > 40) w.supportLog = w.supportLog.slice(-40);
  if (w.seasonSummary.length > 40) w.seasonSummary = w.seasonSummary.slice(-40);
  if (w.benefits.length > 40) w.benefits = w.benefits.slice(-40);
  w.proposals = w.proposals.filter((p) => p.status === 0 || p.createdTick >= tick - 720);
  w.works = w.works.filter((x) => x.state < 2 || x.startedTick >= tick - 720);
  for (const n of w.npcs) {
    n.tags = n.tags.filter((t) => t.expiresTick > tick).sort((a, b) => b.strength - a.strength).slice(0, 12);
    if (n.relations.length > 12) n.relations = n.relations.sort((a, b) => b.trust - a.trust || a.targetId - b.targetId).slice(0, 12);
  }
}

export function recentEvents(w: WorldState, n: number): SimEvent[] {
  return w.eventLog.filter((e) => e.importance >= 1).slice(-n);
}

/** 傳記：只記錄玩家家族成員，最多 12 筆（GDD 9「人物傳記，玩家家族優先」）。 */
export function pushBio(w: WorldState, n: Npc | undefined, text: string): void {
  if (!n || n.controller !== 'player') return;
  n.bio.push(`第${toDate(w.tick).year}年 ${text}`);
  if (n.bio.length > 12) n.bio.shift();
}
