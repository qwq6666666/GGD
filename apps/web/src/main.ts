import { parseSave } from '@ss/persistence';
import { IndexedDbSaveStore } from './idb-store.js';
import type { FromWorker, Speed, ToWorker, WorldView } from './protocol.js';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
const send = (m: ToWorker): void => worker.postMessage(m);
const store = new IndexedDbSaveStore();
const SLOT = 'main';
const log: string[] = [];

function render(view: WorldView, speed: Speed): void {
  $('#date').textContent = view.date;
  // 主畫面最多 3 個摘要狀態，其一固定為支持度（GDD 10）。
  $('#stats').textContent = `支持度 ${view.support} · 天氣 ${view.weather ? '雨' : '晴'}`;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#speed button')) {
    b.setAttribute('aria-pressed', String(b.dataset.speed === speed));
  }
  // textContent 只輸出純文字，不渲染任何 HTML（GDD 13 安全）。
  $('#debug').textContent = [
    `tick ${view.tick} · world v${view.version}`,
    `hash ${view.hash}`,
    '',
    '近期事件：',
    ...view.recentEvents,
    '',
    '訊息：',
    ...log.slice(-6),
  ].join('\n');
}

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  switch (m.kind) {
    case 'view':
      render(m.view, m.speed);
      break;
    case 'saved':
      void store.write(SLOT, m.text).then(() => log.push(`已存檔（${m.reason}）`));
      break;
    case 'commandResult':
      log.push(`命令 #${m.result.commandId}：${m.result.status}${m.result.status === 'rejected' ? `（${m.result.reason}）` : ''}`);
      break;
    case 'error':
      log.push(`錯誤：${m.message}`);
      break;
  }
};

for (const b of document.querySelectorAll<HTMLButtonElement>('#speed button')) {
  b.addEventListener('click', () => send({ kind: 'speed', speed: b.dataset.speed as Speed }));
}
$('#btn-save').addEventListener('click', () => send({ kind: 'save' }));

// 關閉或進入背景即暫停並存檔，不做離線追趕（GDD 12）。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') send({ kind: 'speed', speed: 'pause' });
});

async function boot(): Promise<void> {
  const saves = await store.list(SLOT).catch(() => []);
  // 由新到舊找第一個能通過驗證的恢復點。
  const valid = saves.find((t) => {
    try {
      parseSave(t);
      return true;
    } catch {
      return false;
    }
  });
  send(valid ? { kind: 'init', seed: 0, saveText: valid } : { kind: 'init', seed: 20261103 });
}

void boot();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.js');
}
