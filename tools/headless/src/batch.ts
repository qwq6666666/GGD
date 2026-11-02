import { createWorld, step, unemployedCount, workforce, FOOD, type WorldState } from '@ss/sim';
import { Autopilot } from './autopilot.js';

export interface BatchRow {
  seed: number;
  pops: number[];
  unemployedPct: number;
  minFoodDays: number;
  deaths: number;
  fields: number;
  extinct: boolean;
}

export function runBatch(seeds: number, years: number, autopilot: boolean): BatchRow[] {
  const rows: BatchRow[] = [];
  for (let s = 1; s <= seeds; s++) {
    const w: WorldState = createWorld(1000 + s * 7, s % 3);
    const bot = autopilot ? new Autopilot() : null;
    let un = 0, wf = 0, minFood = 1e9;
    const pops: number[] = [];
    for (let d = 0; d < years * 360; d++) {
      bot?.act(w);
      step(w);
      if (w.tick % 6 === 0) { un += unemployedCount(w); wf += workforce(w); }
      if (w.tick % (360 * 5) === 0) pops.push(w.npcs.length);
      if (w.tick % 30 === 0) minFood = Math.min(minFood, Math.floor((w.households.reduce((a, h) => a + h.stock[FOOD]!, 0) + w.settlement.public.stock[FOOD]!) / Math.max(1, w.npcs.length)));
    }
    rows.push({ seed: s, pops, unemployedPct: Math.floor((un * 100) / Math.max(1, wf)), minFoodDays: minFood, deaths: w.tombstones.length, fields: w.enterprises.filter((e) => e.kind === 'farm' && e.active).length, extinct: w.npcs.length === 0 });
  }
  return rows;
}

if (process.argv[1]?.endsWith('batch.ts')) {
  const seeds = Number(process.argv[2] ?? 4);
  const years = Number(process.argv[3] ?? 10);
  const auto = process.argv[4] === 'auto';
  const rows = runBatch(seeds, years, auto);
  for (const r of rows) console.log('seed', r.seed, 'pops/5y', r.pops.join(','), 'unemp%', r.unemployedPct, 'minFoodDays', r.minFoodDays, 'deaths', r.deaths, 'fields', r.fields);
  console.log('extinct', rows.filter((r) => r.extinct).length, '/', rows.length);
}
