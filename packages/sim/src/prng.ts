/**
 * sfc32 PRNG（GDD 11.3）。只使用 Math.imul 與 32 位元整數運算，跨 JS 引擎結果一致。
 * 狀態是 4 個 uint32，存放在世界狀態中，隨存檔保存。
 */
export type PrngState = [number, number, number, number];

export function seedPrng(seed: number): PrngState {
  // splitmix32 展開種子，避免小種子造成相關序列。
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  const state: PrngState = [next(), next(), next(), next()];
  for (let i = 0; i < 12; i++) nextU32(state);
  return state;
}

/** 推進狀態並回傳 0..2^32-1。會就地修改 state。 */
export function nextU32(state: PrngState): number {
  let [a, b, c, d] = state;
  const t = (((a + b) >>> 0) + d) >>> 0;
  d = (d + 1) >>> 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) >>> 0;
  c = ((c << 21) | (c >>> 11)) >>> 0;
  c = (c + t) >>> 0;
  state[0] = a >>> 0;
  state[1] = b;
  state[2] = c;
  state[3] = d;
  return t;
}

/** 0..maxExclusive-1 的整數，以拒絕取樣避免偏差。 */
export function nextInt(state: PrngState, maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x100000000) {
    throw new RangeError(`nextInt: invalid bound ${maxExclusive}`);
  }
  const limit = 0x100000000 - (0x100000000 % maxExclusive);
  let x = nextU32(state);
  while (x >= limit) x = nextU32(state);
  return x % maxExclusive;
}

/** 機率以 0..65536 表示（65536 = 必然）。 */
export function chance65536(state: PrngState, p: number): boolean {
  return (nextU32(state) >>> 16) < p;
}
