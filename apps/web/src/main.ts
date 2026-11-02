import { parseSave } from '@ss/persistence';
import { startGame } from './game/MapScene.js';
import { IndexedDbSaveStore } from './idb-store.js';
import type { ToWorker } from './protocol.js';
import { Store } from './store.js';
import { Ui } from './ui.js';

const SLOT = 'main';
const store = new Store(new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' }));
const saves = new IndexedDbSaveStore();
const send = (m: ToWorker): void => store.send(m);

store.onSaved = (text) => {
  void saves.write(SLOT, text).catch(() => store.toast('存檔失敗（儲存空間不足或被封鎖）', 'warn'));
};
store.onExport = (text) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `shengsheng-${store.snap?.year ?? 0}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

async function latestValidSave(): Promise<string | null> {
  const list = await saves.list(SLOT).catch(() => [] as string[]);
  // 由新到舊找第一個能通過驗證的恢復點
  for (const t of list) {
    try {
      parseSave(t);
      return t;
    } catch {
      /* 損毀的恢復點略過 */
    }
  }
  return null;
}

async function boot(): Promise<void> {
  const holder: { ui: Ui | null } = { ui: null };
  const scene = await startGame(document.querySelector('#map') as HTMLElement, {
    onTapTile: (x, y) => holder.ui?.onTapTile(x, y),
    onSelectNpc: (id) => holder.ui?.onSelectNpc(id),
    onSelectBuilding: (id) => holder.ui?.onSelectBuilding(id),
    selecting: () => holder.ui?.mode.kind !== 'place' && holder.ui?.mode.kind !== 'road' && holder.ui?.mode.kind !== 'zone',
  });
  const ui = new Ui(store, scene);
  holder.ui = ui;
  ui.loadSettings();
  store.subscribeMap(() => store.map && scene.setMap(store.map));
  store.subscribe(() => store.snap && scene.setSnapshot(store.snap));
  ui.onImport = (text) => {
    try {
      const { warnings } = parseSave(text);
      send({ kind: 'init', seed: 0, family: 0, saveText: text });
      store.toast('已匯入存檔', 'good');
      for (const w of warnings) store.toast(w, 'warn');
    } catch (e) {
      store.toast(`匯入失敗：${e instanceof Error ? e.message.slice(0, 60) : '格式錯誤'}`, 'warn');
    }
  };
  const startNew = (): void => {
    ui.showFamilySelect(false, (family) => send({ kind: 'init', seed: (Date.now() & 0x7fffffff) >>> 0, family }), () => {});
  };
  ui.onNewGame = () => {
    if (confirm('確定放棄目前進度，重新開始？（舊存檔仍會保留 3 個恢復點）')) startNew();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') send({ kind: 'speed', speed: 'pause' });
  });
  const last = await latestValidSave();
  if (last) {
    ui.showFamilySelect(true, (family) => send({ kind: 'init', seed: (Date.now() & 0x7fffffff) >>> 0, family }), () => send({ kind: 'init', seed: 0, family: 0, saveText: last }));
  } else startNew();
  if ('serviceWorker' in navigator && import.meta.env.PROD) void navigator.serviceWorker.register('/sw.js');
  (window as unknown as { __ss: { store: Store; ui: Ui } }).__ss = { store, ui };
}

void boot();
