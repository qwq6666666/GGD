import { ECON } from '@ss/content';
import type { MapState } from './types.js';

/** 進入此格的成本；0 代表不可通行（水、建築佔地）。 */
export function tileCost(m: MapState, i: number): number {
  if (m.occ[i] !== 0) return 0;
  const r = m.road[i]!;
  if (r === 3 || r === 4) return r === 3 ? 2 : 1;
  if (m.water[i] !== 0) return 0;
  if (r === 1) return 2;
  if (r === 2) return 1;
  if (m.forest[i]! > 0) return 8;
  if (m.height[i]! >= 3) return 0;
  if (m.height[i]! === 2) return 6;
  return 4;
}

export interface PathResult {
  cost: number;
  steps: number[];
}

class MinHeap {
  private a: number[] = [];
  get size(): number {
    return this.a.length;
  }
  push(v: number): void {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]! <= a[i]!) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): number {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < a.length && a[l]! < a[s]!) s = l;
        if (r < a.length && a[r]! < a[s]!) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i]!, a[s]!];
        i = s;
      }
    }
    return top;
  }
}

const KEY = 16384; // > 96*96，用於以 (f, 格索引) 作為決定性排序鍵

/**
 * A*（GDD 4）：四向移動；同分以格索引（y*w+x）決勝，保證決定性。
 * 起點成本不計；回傳每步的格索引（不含起點）。
 */
export function findPath(m: MapState, sx: number, sy: number, gx: number, gy: number): PathResult | null {
  const w = m.w;
  const n = m.w * m.h;
  const start = sy * w + sx;
  const goal = gy * w + gx;
  if (start === goal) return { cost: 0, steps: [] };
  const g = new Int32Array(n).fill(-1);
  const from = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  const h = (i: number): number => Math.abs((i % w) - gx) + Math.abs(Math.floor(i / w) - gy);
  g[start] = 0;
  heap.push(h(start) * KEY + start);
  while (heap.size > 0) {
    const key = heap.pop();
    const cur = key % KEY;
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) break;
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    const nbrs = [cy > 0 ? cur - w : -1, cx > 0 ? cur - 1 : -1, cx < w - 1 ? cur + 1 : -1, cy < m.h - 1 ? cur + w : -1];
    for (const nb of nbrs) {
      if (nb < 0 || closed[nb]) continue;
      const c = tileCost(m, nb);
      if (c === 0 && nb !== goal) continue;
      const ng = g[cur]! + (c === 0 ? 1 : c);
      if (g[nb]! === -1 || ng < g[nb]!) {
        g[nb] = ng;
        from[nb] = cur;
        heap.push((ng + h(nb)) * KEY + nb);
      }
    }
  }
  if (g[goal]! === -1) return null;
  const steps: number[] = [];
  for (let c = goal; c !== start; c = from[c]!) steps.push(c);
  steps.reverse();
  return { cost: g[goal]!, steps };
}

// --- 距離快取（GDD 4）：key 含道路版本雜湊，道路或橋梁變動時自然失效。純函式結果，不影響決定性。
let cacheKey = '';
let cache: Record<string, number> = {};

export function pathCost(m: MapState, worldId: string, roadVersion: number, sx: number, sy: number, gx: number, gy: number): number {
  const key = worldId + ':' + roadVersion;
  if (key !== cacheKey) {
    cacheKey = key;
    cache = {};
  }
  const ck = sx + ',' + sy + ',' + gx + ',' + gy;
  const hit = cache[ck];
  if (hit !== undefined) return hit;
  const p = findPath(m, sx, sy, gx, gy);
  const v = p ? p.cost : -1;
  cache[ck] = v;
  return v;
}

export function resetPathCache(): void {
  cacheKey = '';
  cache = {};
}

/** 通勤效率（FX）：成本越高效率越低，有下限。 */
export function commuteFx(cost: number): number {
  if (cost < 0) return 0;
  return Math.max(ECON.commute.minFx, 1000 - cost * ECON.commute.kPerCost);
}
