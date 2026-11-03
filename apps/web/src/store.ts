import type { CommandResult } from '@ss/schema';
import type { FromWorker, MapData, Snapshot, Speed, ToWorker } from './protocol.js';

type Listener = () => void;

export class Store {
  snap: Snapshot | null = null;
  map: MapData | null = null;
  mapKey = '';
  speed: Speed = 'pause';
  auto = false;
  toasts: { text: string; kind: 'info' | 'warn' | 'good'; at: number }[] = [];
  private listeners: Listener[] = [];
  private mapListeners: Listener[] = [];
  private pending = new Map<number, (r: CommandResult) => void>();
  private nextRef = 1;
  onSaved: (text: string, reason: string) => void = () => {};
  onExport: (text: string) => void = () => {};

  constructor(private worker: Worker) {
    worker.onmessage = (ev: MessageEvent<FromWorker>) => this.handle(ev.data);
  }

  subscribe(fn: Listener): void {
    this.listeners.push(fn);
  }
  subscribeMap(fn: Listener): void {
    this.mapListeners.push(fn);
  }
  send(m: ToWorker): void {
    this.worker.postMessage(m);
  }

  command(type: string, payload: Record<string, unknown>): Promise<CommandResult> {
    const ref = this.nextRef++;
    return new Promise((resolve) => {
      this.pending.set(ref, resolve);
      this.send({ kind: 'command', ref, type, payload });
    });
  }

  toast(text: string, kind: 'info' | 'warn' | 'good' = 'info'): void {
    this.toasts.push({ text, kind, at: Date.now() });
    if (this.toasts.length > 4) this.toasts.shift();
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private handle(m: FromWorker): void {
    switch (m.kind) {
      case 'snapshot': {
        const prev = this.snap;
        this.snap = m.snap;
        this.speed = m.speed;
        if (prev) this.diffToasts(prev, m.snap);
        this.emit();
        break;
      }
      case 'map':
        this.map = m.map;
        this.mapKey = m.key;
        for (const l of this.mapListeners) l();
        break;
      case 'commandResult': {
        const cb = this.pending.get(m.ref);
        this.pending.delete(m.ref);
        cb?.(m.result);
        break;
      }
      case 'saved':
        this.onSaved(m.text, m.reason);
        break;
      case 'export':
        this.onExport(m.text);
        break;
      case 'auto':
        this.auto = m.on;
        if (m.note) this.toast(`🤖 ${m.note}`);
        this.emit();
        break;
      case 'alert':
        this.toast(`已自動降速：${m.text}`, 'warn');
        break;
      case 'error':
        this.toast(`錯誤：${m.message}`, 'warn');
        break;
    }
  }

  private diffToasts(prev: Snapshot, cur: Snapshot): void {
    const lastId = prev.events.length ? prev.events[prev.events.length - 1]!.id : 0;
    for (const e of cur.events) {
      if (e.id <= lastId) continue;
      if (e.importance >= 2) this.toasts.push({ text: e.summary, kind: e.type === 'GoalDone' || e.type === 'StageUp' ? 'good' : e.importance >= 3 ? 'warn' : 'info', at: Date.now() });
    }
    if (this.toasts.length > 4) this.toasts.splice(0, this.toasts.length - 4);
  }
}
