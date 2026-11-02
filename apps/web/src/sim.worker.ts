import type { Command } from '@ss/schema';
import { CALIBRATION } from '@ss/content';
import { createSave, parseSave, serializeSave } from '@ss/persistence';
import { applyPendingNow, createWorld, step, submitCommand, type WorldState } from '@ss/sim';
import type { FromWorker, Speed, ToWorker } from './protocol.js';
import { buildSnapshot } from './snapshot.js';

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
let lastMapKey = '';
const refs = new Map<number, number>();

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
  const snap = buildSnapshot(world);
  if (snap.mapKey !== lastMapKey) {
    lastMapKey = snap.mapKey;
    const m = world.map;
    post({ kind: 'map', key: snap.mapKey, map: { w: m.w, h: m.h, height: m.height, soil: m.soil, forest: m.forest, water: m.water, stone: m.stone, road: m.road, occ: m.occ } });
  }
  post({ kind: 'snapshot', snap, speed });
}

function save(reason: 'manual' | 'season' | 'background'): void {
  if (!world) return;
  post({ kind: 'saved', reason, text: serializeSave(createSave(world, commandLog)) });
}

function advanceOneDay(): void {
  if (!world) return;
  const before = world.eventLog.length;
  const r = step(world, { checkInvariants: import.meta.env.DEV && world.tick % 30 === 0 });
  for (const result of r.commandResults) {
    const ref = refs.get(result.commandId) ?? -1;
    refs.delete(result.commandId);
    post({ kind: 'commandResult', ref, result });
  }
  const newEvents = world.eventLog.slice(before);
  if (newEvents.some((e) => e.type === 'SeasonEnded')) save('season');
  // 重大事件與玩家家族的出生／成年／婚姻／重病／死亡／改選一律自動降回正常速度（GDD 2.0、8.3）
  const big = newEvents.find((e) => e.importance >= 3);
  if (big && (speed === 'fast' || speed === 'max')) {
    speed = 'normal';
    post({ kind: 'alert', text: big.summary });
  }
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
        lastMapKey = '';
        if (msg.saveText) {
          const loaded = parseSave(msg.saveText);
          world = loaded.world;
          commandLog = loaded.save.commandLog;
          nextCommandId = commandLog.reduce((m, c) => Math.max(m, c.commandId), 0) + 1;
        } else {
          world = createWorld(msg.seed, msg.family);
          commandLog = [];
          nextCommandId = 1;
        }
        speed = 'pause';
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
        const command = {
          commandId: nextCommandId++,
          issuedTick: world.tick,
          expectedWorldVersion: world.version,
          type: msg.type,
          payload: msg.payload,
        } as Command;
        refs.set(command.commandId, msg.ref);
        submitCommand(world, command);
        commandLog.push(command);
        if (speed === 'pause') {
          advanceCommandsWhilePaused();
        }
        break;
      }
      case 'save':
        save('manual');
        break;
      case 'exportSave':
        if (world) post({ kind: 'export', text: serializeSave(createSave(world, commandLog)) });
        break;
    }
  } catch (e) {
    post({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};

/**
 * 暫停時玩家仍可下命令（建設、提案）。命令在 issuedTick 當日套用；暫停時世界不推進，
 * 因此這裡把命令視為「下一日開頭」套用：推進一日但不經過時間排程。為避免暫停時時間流逝，
 * 命令改由 sim 的 applyCommand 直接處理（見 sim 的 applyPendingNow）。
 */
function advanceCommandsWhilePaused(): void {
  if (!world) return;
  const results = applyPendingNow(world);
  for (const result of results) {
    const ref = refs.get(result.commandId) ?? -1;
    refs.delete(result.commandId);
    post({ kind: 'commandResult', ref, result });
  }
  pushView();
}

setInterval(tick, 50);
