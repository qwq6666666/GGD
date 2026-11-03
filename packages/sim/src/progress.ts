import { CALIBRATION, GOALS } from '@ss/content';
import { householdStats } from './econ.js';
import { pushEvent } from './history.js';
import type { WorldState } from './types.js';

type Goal = (typeof GOALS.stages)[number]['goals'][number] & Record<string, unknown>;

export interface GoalStatus {
  id: string;
  icon: string;
  text: string;
  done: boolean;
  cur: number;
  target: number;
}

/** 目前進度值與目標值；條件只讀世界狀態，不含隨機，因此可重播。 */
function measure(w: WorldState, g: Goal): { cur: number; target: number } {
  const num = (k: string): number => Number(g[k] ?? 0);
  switch (g.kind) {
    case 'building': return { cur: w.buildings.filter((b) => b.type === g.type && b.state === 'active').length, target: num('n') };
    case 'road': {
      const min = num('min');
      let n = 0;
      for (const r of w.map.road) if (min === 1 ? r >= 1 : r === min) n++;
      return { cur: n, target: num('n') };
    }
    case 'pop': return { cur: w.npcs.length, target: num('n') };
    case 'enterprises': return { cur: w.enterprises.filter((e) => e.active).length, target: num('n') };
    case 'surviveTo': {
      const ok = w.tick >= num('tick') && householdStats(w).foodDays >= num('foodDays');
      return { cur: ok ? 1 : 0, target: 1 };
    }
    case 'stable': {
      const ok = w.leadership.support >= num('support') && householdStats(w).foodDays >= num('foodDays');
      return { cur: ok ? 1 : 0, target: 1 };
    }
    case 'years': {
      const ok = w.tick >= num('n') * CALIBRATION.calendar.daysPerYear && w.leadership.support >= num('support');
      return { cur: ok ? 1 : 0, target: 1 };
    }
    default: return { cur: 0, target: 1 };
  }
}

export const MAX_STAGE = GOALS.stages.length;

/** 目前階段的目標狀態。已達成者永久記錄（不會因數值回落而取消）。 */
export function goalStatus(w: WorldState): GoalStatus[] {
  const st = GOALS.stages[w.progress.stage];
  if (!st) return [];
  return (st.goals as Goal[]).map((g) => {
    const m = measure(w, g);
    return { id: g.id, icon: g.icon, text: g.text, done: w.progress.done.includes(g.id) || m.cur >= m.target, cur: Math.min(m.cur, m.target), target: m.target };
  });
}

export function stageName(stage: number): string {
  return GOALS.stages[stage]?.name ?? '繁榮之鎮';
}

/** 依階段設定可建區範圍。 */
export function applyStageZone(w: WorldState): void {
  const size = GOALS.stages[Math.min(w.progress.stage, MAX_STAGE - 1)]!.zone;
  const next = w.progress.stage >= MAX_STAGE ? GOALS.stages[MAX_STAGE - 1]!.zone + 12 : size;
  w.map.zmin = Math.floor((w.map.w - next) / 2);
  w.map.zmax = w.map.zmin + next;
}

/** 指令是否已解鎖（key：建築類型或 zone1／stone／stonebridge）。 */
export function unlocked(w: WorldState, key: string): boolean {
  const need = (GOALS.locks as Record<string, number>)[key];
  return need === undefined || w.progress.stage >= need;
}

/** 每日末檢查：記錄新達成的目標；達成 2 個即升階，擴張可建區。 */
export function updateProgress(w: WorldState): void {
  if (w.progress.stage >= MAX_STAGE) return;
  for (const s of goalStatus(w)) {
    if (s.done && !w.progress.done.includes(s.id)) {
      w.progress.done.push(s.id);
      pushEvent(w, { type: 'GoalDone', importance: 2, causeIds: [], actorIds: [], summary: `${s.icon} 目標達成：${s.text}`, data: { goal: s.id } });
    }
  }
  const st = GOALS.stages[w.progress.stage]!;
  const n = (st.goals as Goal[]).filter((g) => w.progress.done.includes(g.id)).length;
  if (n >= GOALS.needed) {
    const from = st.name;
    w.progress.stage++;
    applyStageZone(w);
    w.roadVersion++;
    pushEvent(w, { type: 'StageUp', importance: 3, causeIds: [], actorIds: [], summary: `${GOALS.stages[w.progress.stage - 1]!.icon} ${from}成長為${stageName(w.progress.stage)}，可建土地擴大了`, data: { stage: w.progress.stage } });
  }
}
