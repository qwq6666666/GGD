import type { Command } from '@ss/schema';
import { FOOD, submitCommand, type WorldState } from '@ss/sim';

/**
 * 基準玩家策略（headless 驗收用）：模擬一位中規中矩的領袖。
 * 只透過命令介面行動，不直接改世界狀態。
 */
export class Autopilot {
  private nextId = 1_000_000;

  private cmd(w: WorldState, type: Command['type'], payload: Record<string, unknown>): void {
    submitCommand(w, { commandId: this.nextId++, issuedTick: w.tick, expectedWorldVersion: w.version, type, payload } as Command);
  }

  /** 每日呼叫；只在每週最後一日行動。 */
  act(w: WorldState): void {
    if (w.tick % 6 !== 5 || !w.leadership.playerIsLeader || w.leadership.mode !== 0) return;
    const pub = w.settlement.public;
    // 提案：付得起就核准，否則延後
    for (const p of w.proposals) {
      if (p.status !== 0 && p.status !== 2) continue;
      if (pub.cash >= p.cost * 1.2 + 800) this.cmd(w, 'RespondProposal', { proposalId: p.id, response: 'approve' });
    }
    // 春荒前：全村存糧不足時向貿易節點採購（一次一筆）
    const season = Math.floor((w.tick % 360) / 90);
    const foodPerCap = Math.floor((w.households.reduce((a, h) => a + h.stock[FOOD]!, 0) + pub.stock[FOOD]!) / Math.max(1, w.npcs.length));
    const inTransit = w.shipments.some((s) => s.status === 0);
    if ((season === 3 || season === 0) && foodPerCap < 28 && !inTransit && pub.cash > 1500) {
      const qty = Math.min(400, Math.floor((pub.cash - 800) / 14));
      if (qty >= 50) this.cmd(w, 'OrderImport', { nodeId: 1, item: FOOD, qty });
    }
    // 冬季公共工程：升級住宅與農田（材料齊備才下單）
    if (season === 3 && !w.works.some((x) => x.kind !== 'maintenance' && x.state < 2) && pub.cash > 2500) {
      const target = w.buildings.find((b) => b.state === 'active' && (b.type === 'home' || b.type === 'field') && b.stage < 2 && pub.stock[1]! >= 45 && pub.stock[2]! >= 30);
      if (target) this.cmd(w, 'UpgradeBuilding', { buildingId: target.id });
    }
  }
}
