import type { CommandResult } from '@ss/schema';

export type Speed = 'pause' | 'normal' | 'fast' | 'max';

/** 主執行緒 → Worker。命令的 commandId 與 issuedTick 由 Worker 蓋章（權威時間）。 */
export type ToWorker =
  | { kind: 'init'; seed: number; saveText?: string }
  | { kind: 'speed'; speed: Speed }
  | { kind: 'command'; type: 'Noop'; payload: { note: string } }
  | { kind: 'save' };

export interface WorldView {
  tick: number;
  date: string;
  weather: number;
  support: number;
  version: number;
  hash: string;
  recentEvents: string[];
}

/** Worker → 主執行緒。渲染層只讀取 view，不得改寫模擬狀態（GDD 11.2）。 */
export type FromWorker =
  | { kind: 'view'; view: WorldView; speed: Speed }
  | { kind: 'commandResult'; result: CommandResult }
  | { kind: 'saved'; text: string; reason: 'manual' | 'season' | 'background' }
  | { kind: 'error'; message: string };
