import { canonicalize, hash64 } from '@ss/sim';

/** 存檔檢查碼：對「去掉 checksum 欄位後的正規化 JSON」做 64 位元雜湊。 */
export function checksumOf(body: Record<string, unknown>): string {
  return hash64(canonicalize(body));
}
