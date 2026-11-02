/** 存檔儲存介面。保留最近 N 個恢復點（GDD 12.1）。 */
export interface SaveStore {
  write(slot: string, text: string): Promise<void>;
  /** 由新到舊的恢復點。 */
  list(slot: string): Promise<string[]>;
}

export const RECOVERY_POINTS = 3;

export class MemorySaveStore implements SaveStore {
  private slots = new Map<string, string[]>();
  async write(slot: string, text: string): Promise<void> {
    const arr = [text, ...(this.slots.get(slot) ?? [])].slice(0, RECOVERY_POINTS);
    this.slots.set(slot, arr);
  }
  async list(slot: string): Promise<string[]> {
    return [...(this.slots.get(slot) ?? [])];
  }
}
