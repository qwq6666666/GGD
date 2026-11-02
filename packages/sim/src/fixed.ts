/**
 * 定點數工具（GDD 5.2、11.3）。全專案統一 FX = 1000（1.0 = 1000）。
 * 所有除法一律向下取整（floor），集中於此以保證一致的捨入規則。
 */
export const FX = 1000;

function assertInt(n: number, name: string): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${name} must be a safe integer, got ${n}`);
}

/** 整數向下取整除法（對負數亦為 floor）。 */
export function idiv(a: number, b: number): number {
  assertInt(a, 'a');
  assertInt(b, 'b');
  if (b === 0) throw new RangeError('idiv by zero');
  return Math.floor(a / b);
}

/** 兩個 FX 定點數相乘，結果仍為 FX 定點數。 */
export function fxMul(a: number, b: number): number {
  return idiv(a * b, FX);
}

/** 兩個 FX 定點數相除，結果仍為 FX 定點數。 */
export function fxDiv(a: number, b: number): number {
  return idiv(a * FX, b);
}

/** 整數數量乘以 FX 係數，回傳整數數量（向下取整）。 */
export function scale(quantity: number, coefFx: number): number {
  return idiv(quantity * coefFx, FX);
}

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
