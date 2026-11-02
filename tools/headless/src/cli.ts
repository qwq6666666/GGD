import { performance } from 'node:perf_hooks';
import { runGrowth, runNpcStress, runReplay, runSpeed, runStress, type ScenarioReport } from './scenarios.js';
import { runBatch } from './batch.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const scenario = arg('scenario', 'all');
const seed = Number(arg('seed', '20261103'));
const years = Number(arg('years', '10'));
const now = (): number => performance.now();

const all: Record<string, () => ScenarioReport> = {
  growth: () => runGrowth(seed, years, now),
  replay: () => runReplay(seed),
  speed: () => runSpeed(seed),
  stress: () => runStress(seed, Number(arg('stress-years', '100')), now),
  'npc-stress': () => runNpcStress(Number(arg('npcs', '300')), now),
  report: () => {
    const rows = runBatch(Number(arg('seeds', '6')), years, arg('bot', 'auto') === 'auto');
    return {
      name: `report-${years}y`,
      ok: rows.every((r) => !r.extinct),
      lines: rows.map((r) => `seed ${r.seed} pops/5y ${r.pops.join(',')} unemp% ${r.unemployedPct} minFoodDays ${r.minFoodDays} deaths ${r.deaths} fields ${r.fields}`),
    };
  },
};

const selected = scenario === 'all' ? ['growth', 'replay', 'speed', 'stress'] : [scenario];
let failed = false;
for (const name of selected) {
  const fn = all[name];
  if (!fn) {
    console.error(`unknown scenario: ${name} (available: ${Object.keys(all).join(', ')}, all)`);
    process.exit(2);
  }
  const r = fn();
  console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.name}`);
  for (const l of r.lines) console.log(`  ${l}`);
  failed ||= !r.ok;
}
process.exit(failed ? 1 : 0);
