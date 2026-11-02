import { CALIBRATION, ECON } from '@ss/content';
import { clamp } from './fixed.js';
import { nextInt, type PrngState } from './prng.js';
import type { Building, BuildingType, MapState } from './types.js';

const M = CALIBRATION.map;
export const ZONE_MIN = Math.floor((M.width - M.initialBuildable) / 2);
export const ZONE_MAX = ZONE_MIN + M.initialBuildable;

export const tileIdx = (m: MapState, x: number, y: number): number => y * m.w + x;
export const inBounds = (m: MapState, x: number, y: number): boolean => x >= 0 && y >= 0 && x < m.w && y < m.h;
export const inBuildZone = (x: number, y: number): boolean => x >= ZONE_MIN && x < ZONE_MAX && y >= ZONE_MIN && y < ZONE_MAX;

function blur(src: number[], w: number, h: number): number[] {
  const out = new Array<number>(w * h).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          sum += src[yy * w + xx]!;
          n++;
        }
      }
      out[y * w + x] = Math.floor(sum / n);
    }
  }
  return out;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]!;
}

/** 決定性地圖生成（GDD 4）。96×96，中央 48×48 為初期可建區，河在西側，礦藏在東北。 */
export function generateMap(prng: PrngState): MapState {
  const w = M.width;
  const h = M.height;
  const n = w * h;
  let hg = Array.from({ length: n }, () => nextInt(prng, 100));
  for (let i = 0; i < 4; i++) hg = blur(hg, w, h);
  const t1 = percentile(hg, 60);
  const t2 = percentile(hg, 85);
  const t3 = percentile(hg, 95);
  const height: number[] = hg.map((v) => (v < t1 ? 0 : v < t2 ? 1 : v < t3 ? 2 : 3));
  const water = new Array<number>(n).fill(0);
  let rx = 14 + nextInt(prng, 6);
  for (let y = 0; y < h; y++) {
    for (const x of [rx, rx + 1]) {
      water[y * w + x] = 1;
      height[y * w + x] = 0;
    }
    const r = nextInt(prng, 6);
    if (r === 0) rx = Math.max(10, rx - 1);
    else if (r === 1) rx = Math.min(20, rx + 1);
  }
  // 中央區域壓平
  for (let y = ZONE_MIN - 4; y < ZONE_MAX + 4; y++) {
    for (let x = ZONE_MIN - 4; x < ZONE_MAX + 4; x++) {
      const i = y * w + x;
      if (water[i] === 0) height[i] = Math.min(height[i]!, 1);
    }
  }
  let soil = Array.from({ length: n }, () => 30 + nextInt(prng, 70));
  for (let i = 0; i < 3; i++) soil = blur(soil, w, h);
  soil = soil.map((v) => clamp(v + 8, 30, 95));
  let fnoise = Array.from({ length: n }, () => nextInt(prng, 100));
  for (let i = 0; i < 3; i++) fnoise = blur(fnoise, w, h);
  const ft = percentile(fnoise, 55);
  const forest = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const x = i % w;
    const y = Math.floor(i / w);
    const dx = x - 48;
    const dy = y - 48;
    const near = dx * dx + dy * dy <= 14 * 14;
    if (!near && water[i] === 0 && fnoise[i]! > ft) forest[i] = 300 + nextInt(prng, 700);
  }
  const stone = new Array<number>(n).fill(0);
  for (let y = 38; y <= 41; y++) {
    for (let x = 62; x <= 65; x++) {
      const i = y * w + x;
      stone[i] = 2500;
      height[i] = 2;
      forest[i] = 0;
    }
  }
  return { w, h, height, soil, forest, water, stone, road: new Array<number>(n).fill(0), occ: new Array<number>(n).fill(0) };
}

/** 此格是否可放置建築佔地（不含出入口檢查）。 */
export function tileBuildable(m: MapState, x: number, y: number): boolean {
  if (!inBounds(m, x, y) || !inBuildZone(x, y)) return false;
  const i = tileIdx(m, x, y);
  return m.water[i] === 0 && m.stone[i] === 0 && m.height[i]! <= 1 && m.forest[i] === 0 && m.occ[i] === 0 && m.road[i] === 0;
}

export function entranceOf(type: BuildingType, x: number, y: number, w: number, h: number): { ex: number; ey: number } {
  void type;
  return { ex: x + Math.floor(w / 2), ey: y + h };
}

export type PlaceError = 'out_of_bounds' | 'not_buildable' | 'overlap' | 'entrance_blocked' | 'bad_type';

export function footprintOf(type: BuildingType): { w: number; h: number } | null {
  const t = (ECON.build as Record<string, { w: number; h: number }>)[type === 'publichome' ? 'home' : type === 'school' || type === 'clinic' ? 'storage' : type];
  return t ? { w: t.w, h: t.h } : null;
}

/** 驗證放置：佔地全部可建、入口格存在且可通行、不壓在其他建築的入口上。 */
export function validatePlacement(m: MapState, buildings: Building[], type: BuildingType, x: number, y: number): PlaceError | null {
  const fp = footprintOf(type);
  if (!fp) return 'bad_type';
  for (let yy = y; yy < y + fp.h; yy++) {
    for (let xx = x; xx < x + fp.w; xx++) {
      if (!inBounds(m, xx, yy)) return 'out_of_bounds';
      if (!tileBuildable(m, xx, yy)) return m.occ[tileIdx(m, xx, yy)] !== 0 ? 'overlap' : 'not_buildable';
    }
  }
  const { ex, ey } = entranceOf(type, x, y, fp.w, fp.h);
  if (!inBounds(m, ex, ey)) return 'entrance_blocked';
  const ei = tileIdx(m, ex, ey);
  if (m.water[ei] !== 0 && m.road[ei]! < 3) return 'entrance_blocked';
  if (m.occ[ei] !== 0) return 'entrance_blocked';
  for (const b of buildings) {
    if (b.ex >= x && b.ex < x + fp.w && b.ey >= y && b.ey < y + fp.h) return 'entrance_blocked';
  }
  return null;
}

export function occupy(m: MapState, b: Building): void {
  for (let yy = b.y; yy < b.y + b.h; yy++) for (let xx = b.x; xx < b.x + b.w; xx++) m.occ[tileIdx(m, xx, yy)] = b.id;
}

/** 依螺旋順序尋找第一個可放置的位置，供開局佈置使用。 */
export function findSpot(m: MapState, buildings: Building[], type: BuildingType, nx: number, ny: number): { x: number; y: number } | null {
  for (let r = 0; r < 40; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (validatePlacement(m, buildings, type, nx + dx, ny + dy) === null) return { x: nx + dx, y: ny + dy };
      }
    }
  }
  return null;
}
