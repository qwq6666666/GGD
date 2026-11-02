import { createWorld, step, unemployedCount, workforce, FOOD } from '@ss/sim';
const seeds = Number(process.argv[2] ?? 4);
const years = Number(process.argv[3] ?? 10);
for (let s = 1; s <= seeds; s++) {
  const w = createWorld(1000 + s, s % 3);
  let un = 0, wf = 0, minFood = 1e9;
  const pops: number[] = [];
  for (let d = 0; d < years * 360; d++) {
    step(w);
    if (w.tick % 6 === 0) { un += unemployedCount(w); wf += workforce(w); }
    if (w.tick % 360 === 0) pops.push(w.npcs.length);
    if (w.tick % 30 === 0) minFood = Math.min(minFood, Math.floor((w.households.reduce((a, h) => a + h.stock[FOOD]!, 0) + w.settlement.public.stock[FOOD]!) / Math.max(1, w.npcs.length)));
  }
  console.log('seed', s, 'pops', pops.join(','), 'unemp%', Math.floor((un * 100) / Math.max(1, wf)), 'minFoodDays', minFood, 'leader', w.leadership.playerIsLeader, 'deaths', w.tombstones.length, 'fields', w.enterprises.filter((e) => e.kind === 'farm').length);
}
