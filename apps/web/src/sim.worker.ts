import type { Command } from '@ss/schema';
import { CALIBRATION } from '@ss/content';
import { createSave, parseSave, serializeSave } from '@ss/persistence';
import { createWorld, formatDate, stateHash, step, submitCommand, type WorldState } from '@ss/sim';
import type { FromWorker, Speed, ToWorker } from './protocol.js';

/** Worker 全域的最小型別（避免 DOM 與 WebWorker lib 衝突）。 */
const ctx = globalThis as unknown as {
  postMessage(m: FromWorker): void;
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
};

let world: WorldState | null = null;
let commandLog: Command[] = [];
let nextCommandId = 1;
let speed: Speed = 'pause';
let owedMs = 0;
let lastTime = 0;

const post = (m: FromWorker): void => ctx.postMessage(m);

/** 速度只決定每秒步進次數，不進入世界狀態（ADR-0002）。 */
function msPerDay(s: Speed): number {
  const sp = CALIBRATION.speed;
  if (s === 'normal') return sp.normalMsPerDay;
  if (s === 'fast') return 1000 / sp.fastDaysPerSecond;
  if (s === 'max') return 1000 / sp.maxDaysPerSecond;
  return Infinity;
}

function pushView(): void {
  if (!world) return;
  post({
    kind: 'view',
    speed,
    view: {
      tick: world.tick,
      date: formatDate(world.tick),
      weather: world.env.weather,
      support: world.leadership.support,
      version: world.version,
      hash: stateHash(world),
      recentEvents: world.eventLog.slice(-5).map((e) => `${formatDate(e.tick)} ${e.type}`),
    },
  });
}

function save(reason: 'manual' | 'season' | 'background'): void {
  if (!world) return;
  post({ kind: 'saved', reason, text: serializeSave(createSave(world, commandLog)) });
}

function advanceOneDay(): void {
  if (!world) return;
  const before = world.eventLog.length;
  const r = step(world, { checkInvariants: import.meta.env.DEV });
  for (const result of r.commandResults) post({ kind: 'commandResult', result });
  const newEvents = world.eventLog.slice(before);
  if (newEvents.some((e) => e.type === 'SeasonEnded')) save('season');
  // 重大事件自動降速（GDD 8.3）：僅影響排程層。
  if (newEvents.some((e) => e.importance >= 3) && (speed === 'fast' || speed === 'max')) speed = 'normal';
}

function tick(): void {
  const now = performance.now();
  const dt = now - lastTime;
  lastTime = now;
  if (!world || speed === 'pause') return;
  owedMs += dt;
  const per = msPerDay(speed);
  let steps = 0;
  while (owedMs >= per && steps < 10) {
    owedMs -= per;
    advanceOneDay();
    steps++;
  }
  if (steps === 10) owedMs = 0; // 落後太多時不追趕，避免卡頓
  if (steps > 0) pushView();
}

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.kind) {
      case 'init': {
        if (msg.saveText) {
          const loaded = parseSave(msg.saveText);
          world = loaded.world;
          commandLog = loaded.save.commandLog;
          nextCommandId = commandLog.reduce((m, c) => Math.max(m, c.commandId), 0) + 1;
        } else {
          world = createWorld(msg.seed);
          commandLog = [];
          nextCommandId = 1;
        }
        lastTime = performance.now();
        pushView();
        break;
      }
      case 'speed':
        speed = msg.speed;
        owedMs = 0;
        if (speed === 'pause') save('background');
        pushView();
        break;
      case 'command': {
        if (!world) break;
        const command: Command = {
          commandId: nextCommandId++,
          issuedTick: world.tick,
          expectedWorldVersion: world.version,
          type: msg.type,
          payload: msg.payload,
        };
        submitCommand(world, command);
        commandLog.push(command);
        break;
      }
      case 'save':
        save('manual');
        break;
    }
  } catch (e) {
    post({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};

setInterval(tick, 50);
