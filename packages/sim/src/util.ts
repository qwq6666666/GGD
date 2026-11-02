import type { Building, Enterprise, Household, Npc, WorldState } from './types.js';

/** 以 id 二分搜尋（陣列依 id 遞增排列）。 */
export function byId<T extends { id: number }>(arr: T[], id: number): T | undefined {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = arr[mid]!.id;
    if (v === id) return arr[mid];
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

export const npcOf = (w: WorldState, id: number): Npc | undefined => byId(w.npcs, id);
export const hhOf = (w: WorldState, id: number): Household | undefined => byId(w.households, id);
export const entOf = (w: WorldState, id: number): Enterprise | undefined => byId(w.enterprises, id);
export const bldOf = (w: WorldState, id: number): Building | undefined => byId(w.buildings, id);

export const isAdult = (n: Npc): boolean => n.age >= 16 && n.age <= 65;
export const isWorkAge = (n: Npc): boolean => n.age >= 16 && n.age <= 55;

export function removeFrom(arr: number[], v: number): void {
  const i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1);
}

export function insertSorted(arr: number[], v: number): void {
  let i = arr.length;
  while (i > 0 && arr[i - 1]! > v) i--;
  arr.splice(i, 0, v);
}

export function sum(a: number[]): number {
  let s = 0;
  for (const v of a) s += v;
  return s;
}
