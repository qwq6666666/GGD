/**
 * 正規化序列化與狀態 hash（GDD 11.3）。
 * canonicalize 會拒絕非整數數值，因此同時是「世界狀態只含整數」的不變量檢查。
 */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function canonicalize(value: unknown, path = '$'): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`non-integer number at ${path}: ${value}`);
      }
      return String(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v, i) => canonicalize(v, `${path}[${i}]`)).join(',') + ']';
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`non-plain object at ${path}`);
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k], `${path}.${k}`)).join(',') + '}';
    }
    default:
      throw new TypeError(`unsupported type ${typeof value} at ${path}`);
  }
}

/** 64 位元字串雜湊（雙 32 位元通道），回傳 16 位小寫十六進位。 */
export function hash64(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

export function stateHash(state: unknown): string {
  return hash64(canonicalize(state));
}
