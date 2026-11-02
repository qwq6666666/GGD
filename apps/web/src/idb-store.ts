import { RECOVERY_POINTS, type SaveStore } from '@ss/persistence';

/**
 * IndexedDB 存檔（GDD 12.1）：每個槽保留最近 3 個恢復點。
 * 寫入在單一交易內完成（新恢復點＋裁切舊點），交易失敗則整筆不生效。
 */
export class IndexedDbSaveStore implements SaveStore {
  private dbPromise: Promise<IDBDatabase>;

  constructor(name = 'shengsheng') {
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('saves', { keyPath: 'id', autoIncrement: true });
        store.createIndex('slot', 'slot');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async all(slot: string): Promise<{ id: number; slot: string; text: string }[]> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const req = db.transaction('saves').objectStore('saves').index('slot').getAll(slot);
      req.onsuccess = () => resolve((req.result as { id: number; slot: string; text: string }[]).sort((a, b) => b.id - a.id));
      req.onerror = () => reject(req.error);
    });
  }

  async write(slot: string, text: string): Promise<void> {
    const old = await this.all(slot);
    const db = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('saves', 'readwrite');
      const store = tx.objectStore('saves');
      store.add({ slot, text });
      for (const r of old.slice(RECOVERY_POINTS - 1)) store.delete(r.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async list(slot: string): Promise<string[]> {
    return (await this.all(slot)).map((r) => r.text);
  }
}
