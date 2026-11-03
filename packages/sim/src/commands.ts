import type { Command, CommandResult } from '@ss/schema';
import { ECON } from '@ss/content';
import {
  holdElection, nominateHeir, respondProposal, roadCost, setPolicy, switchFamily, type RoadMode,
} from './civic.js';
import { PUBLIC_SECTOR, bumpMapVersion, cancelWork, materialsValue, queueWork, reserveMaterials } from './econ.js';
import { pushEvent } from './history.js';
import { unlocked } from './progress.js';
import { inBuildZone, tileIdx, validatePlacement, inBounds } from './map.js';
import { addBuilding } from './start.js';
import { transferMoney } from './ledger.js';
import type { BuildingType, WorldState } from './types.js';
import { entOf, hhOf, npcOf } from './util.js';
import { orderImport } from './trade.js';

const reject = (c: Command, reason: string): CommandResult => ({ commandId: c.commandId, status: 'rejected', reason });
const accept = (c: Command): CommandResult => ({ commandId: c.commandId, status: 'accepted' });

const PUBLIC_BUILDINGS: BuildingType[] = ['publichome', 'market', 'storage', 'lumber', 'quarry', 'toolshop', 'furnshop', 'field', 'school', 'clinic'];

function num(p: Record<string, unknown>, k: string): number | undefined {
  const v = p[k];
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

/** 命令必須是領袖權力範圍內，且在落選期間（AI 代理）不可下達公共命令。 */
function needLeader(w: WorldState): string | null {
  return w.leadership.playerIsLeader && w.leadership.mode === 0 ? null : 'no_permission';
}

export function applyCommand(w: WorldState, cmd: Command): CommandResult {
  const p = cmd.payload as Record<string, unknown>;
  switch (cmd.type) {
    case 'Noop':
    case 'FollowEntity':
      return accept(cmd);
    case 'BuildRoad': {
      const perm = needLeader(w);
      if (perm) return reject(cmd, perm);
      const raw = p.tiles;
      const mode = (['dirt', 'stone', 'bridge', 'stonebridge'].includes(String(p.mode)) ? p.mode : 'dirt') as RoadMode;
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > 60) return reject(cmd, 'invalid_target');
      if ((mode === 'stone' || mode === 'stonebridge') && !unlocked(w, mode)) return reject(cmd, 'locked');
      const target = mode === 'dirt' ? 1 : mode === 'stone' ? 2 : mode === 'bridge' ? 3 : 4;
      const tiles: { x: number; y: number; type: number }[] = [];
      for (const t of raw as Record<string, unknown>[]) {
        const x = num(t, 'x');
        const y = num(t, 'y');
        if (x === undefined || y === undefined || !inBounds(w.map, x, y)) return reject(cmd, 'invalid_target');
        const i = tileIdx(w.map, x, y);
        const have = w.map.road[i]!;
        const onWater = w.map.water[i] !== 0;
        if (w.map.occ[i] !== 0 || w.map.stone[i] !== 0) return reject(cmd, 'invalid_target');
        const ok =
          mode === 'dirt' ? inBuildZone(w.map, x, y) && !onWater && have === 0 : mode === 'stone' ? have === 1 : mode === 'bridge' ? onWater && have === 0 && x >= 8 : have === 3;
        if (!ok) return reject(cmd, 'invalid_target');
        if (!tiles.some((q) => q.x === x && q.y === y)) tiles.push({ x, y, type: target });
      }
      if (tiles.length === 0) return reject(cmd, 'nothing_to_build');
      const c = roadCost(w, tiles.length, mode);
      if (w.settlement.public.cash < c.pd * w.settlement.wage[PUBLIC_SECTOR]!) return reject(cmd, 'insufficient_budget');
      queueWork(w, { kind: 'road', buildingId: 0, tiles, requiredPDFx: c.pd * 1000, needed: c.materials, causeCommandId: cmd.commandId, proposalId: 0, beneficiaryHouseholdId: 0 });
      w.version++;
      return accept(cmd);
    }
    case 'UpgradeBuilding': {
      const perm = needLeader(w);
      if (perm) return reject(cmd, perm);
      const b = w.buildings.find((x) => x.id === num(p, 'buildingId'));
      if (!b || b.state !== 'active') return reject(cmd, 'invalid_target');
      const list = b.type === 'field' ? ECON.upgrade.field : b.type === 'home' || b.type === 'publichome' ? ECON.upgrade.home : null;
      const cfg = list?.[b.stage] as { wood: number; stone: number; personDays: number } | undefined;
      if (!cfg) return reject(cmd, 'nothing_to_build');
      if (w.works.some((x) => x.kind === 'upgrade' && x.buildingId === b.id && x.state < 2)) return reject(cmd, 'not_allowed');
      if (w.settlement.public.cash < cfg.personDays * w.settlement.wage[PUBLIC_SECTOR]!) return reject(cmd, 'insufficient_budget');
      queueWork(w, { kind: 'upgrade', buildingId: b.id, tiles: [], requiredPDFx: cfg.personDays * 1000, needed: [0, cfg.wood, cfg.stone, 0, 0], causeCommandId: cmd.commandId, proposalId: 0, beneficiaryHouseholdId: b.ownerHouseholdId });
      w.version++;
      return accept(cmd);
    }
    case 'PlaceBuilding': {
      const perm = needLeader(w);
      if (perm) return reject(cmd, perm);
      const type = p.type as BuildingType;
      const x = num(p, 'x');
      const y = num(p, 'y');
      if (!PUBLIC_BUILDINGS.includes(type) || x === undefined || y === undefined) return reject(cmd, 'invalid_target');
      if (!unlocked(w, type)) return reject(cmd, 'locked');
      const err = validatePlacement(w.map, w.buildings, type, x, y);
      if (err) return reject(cmd, 'invalid_target:' + err);
      const cfg = (ECON.build as Record<string, { wood: number; stone: number; personDays: number }>)[type === 'publichome' ? 'home' : type === 'school' || type === 'clinic' ? 'storage' : type]!;
      const needed = [0, cfg.wood, cfg.stone, 0, 0];
      if (w.settlement.public.cash < cfg.personDays * w.settlement.wage[PUBLIC_SECTOR]!) return reject(cmd, 'insufficient_budget');
      const owner = num(p, 'householdId') ?? w.leadership.playerHouseholdId;
      if (!hhOf(w, owner)) return reject(cmd, 'invalid_target');
      const b = addBuilding(w, type, x, y, type === 'publichome' ? 0 : owner, 'building');
      const wk = queueWork(w, { kind: 'building', buildingId: b.id, tiles: [], requiredPDFx: cfg.personDays * 1000, needed, causeCommandId: cmd.commandId, proposalId: 0, beneficiaryHouseholdId: owner });
      b.workId = wk.id;
      bumpMapVersion(w, x, y);
      w.version++;
      void materialsValue;
      return accept(cmd);
    }
    case 'ZoneLand': {
      const perm = needLeader(w);
      if (perm) return reject(cmd, perm);
      const x = num(p, 'x'), y = num(p, 'y'), zw = num(p, 'w'), zh = num(p, 'h'), kind = num(p, 'kind');
      if (x === undefined || y === undefined || zw === undefined || zh === undefined || kind === undefined || zw < 1 || zh < 1 || zw > 24 || zh > 24 || ![0, 1, 2].includes(kind)) return reject(cmd, 'invalid_target');
      if (kind === 1 && !unlocked(w, 'zone1')) return reject(cmd, 'locked');
      if (!inBounds(w.map, x, y) || !inBounds(w.map, x + zw - 1, y + zh - 1)) return reject(cmd, 'invalid_target');
      if (kind === 2) {
        // 植林：每格 2 文
        let n = 0;
        for (let yy = y; yy < y + zh; yy++) for (let xx = x; xx < x + zw; xx++) {
          const i = tileIdx(w.map, xx, yy);
          if (w.map.forest[i] === 0 && w.map.water[i] === 0 && w.map.occ[i] === 0 && w.map.road[i] === 0 && w.map.stone[i] === 0 && !inBuildZone(w.map, xx, yy)) n++;
        }
        if (n === 0) return reject(cmd, 'nothing_to_build');
        if (w.settlement.public.cash < n * 2) return reject(cmd, 'insufficient_budget');
        w.settlement.public.cash -= n * 2;
        // 費用視為支付給勞工：均分給各家庭，維持帳務守恆
        const hs = w.households.filter((h) => h.memberIds.length > 0);
        const share = Math.floor((n * 2) / hs.length);
        let rest = n * 2;
        for (const h of hs) { h.cash += share; rest -= share; }
        w.settlement.public.cash += rest;
        for (let yy = y; yy < y + zh; yy++) for (let xx = x; xx < x + zw; xx++) {
          const i = tileIdx(w.map, xx, yy);
          if (w.map.forest[i] === 0 && w.map.water[i] === 0 && w.map.occ[i] === 0 && w.map.road[i] === 0 && w.map.stone[i] === 0 && !inBuildZone(w.map, xx, yy)) w.map.forest[i] = 60;
        }
        bumpMapVersion(w, x, y);
      } else {
        w.zones.push({ x, y, w: zw, h: zh, kind, founded: 0 });
      }
      w.version++;
      return accept(cmd);
    }
    case 'SetPolicy': {
      const perm = needLeader(w);
      if (perm) return reject(cmd, perm);
      const key = p.key;
      const value = num(p, 'value');
      if (typeof key !== 'string' || value === undefined) return reject(cmd, 'invalid_target');
      const r = setPolicy(w, key, value, cmd.commandId);
      if (!r.ok) return reject(cmd, r.reason);
      w.version++;
      return accept(cmd);
    }
    case 'FundProject': {
      const perm = needLeader(w);
      if (perm) return reject(cmd, perm);
      const id = num(p, 'workId');
      const wk = w.works.find((x) => x.id === id);
      if (!wk || wk.state > 1) return reject(cmd, 'unknown_project');
      reserveMaterials(w, wk);
      return accept(cmd);
    }
    case 'RespondProposal': {
      const perm = needLeader(w);
      if (perm) return reject(cmd, perm);
      const id = num(p, 'proposalId');
      const r = respondProposal(w, id ?? -1, String(p.response));
      if (!r.ok) return reject(cmd, r.reason);
      w.version++;
      return accept(cmd);
    }
    case 'SetPersonalChoice': {
      const kind = p.kind;
      const head = npcOf(w, w.leadership.leaderId);
      const pHh = hhOf(w, w.leadership.playerHouseholdId);
      if (!pHh) return reject(cmd, 'invalid_target');
      if (kind === 'invest') {
        const entId = num(p, 'enterpriseId');
        const amount = num(p, 'amount');
        const e = entId !== undefined ? entOf(w, entId) : undefined;
        if (!e || amount === undefined || amount <= 0 || e.ownerHouseholdId !== pHh.id) return reject(cmd, 'invalid_target');
        if (!transferMoney(w, 'h' + pHh.id, 'e' + e.id, amount, 'invest')) return reject(cmd, 'insufficient_funds');
        w.version++;
        return accept(cmd);
      }
      void head;
      return reject(cmd, 'not_implemented');
    }
    case 'NominateHeir': {
      const id = num(p, 'npcId');
      const r = nominateHeir(w, id ?? -1);
      if (!r.ok) return reject(cmd, r.reason);
      w.version++;
      return accept(cmd);
    }
    case 'StandForElection': {
      const L = w.leadership;
      if (L.mode !== 1 || L.nextElectionTick < 0 || w.tick < L.nextElectionTick) return reject(cmd, 'not_allowed');
      holdElection(w, true);
      w.version++;
      pushEvent(w, { type: 'StoodForElection', importance: 2, causeIds: [], actorIds: [], summary: '玩家家長參選領袖', data: {} });
      return accept(cmd);
    }
    case 'SwitchFamily': {
      const id = num(p, 'householdId');
      const r = switchFamily(w, id ?? -1);
      if (!r.ok) return reject(cmd, r.reason);
      w.version++;
      return accept(cmd);
    }
    case 'CancelWork': {
      const perm = needLeader(w);
      if (perm) return reject(cmd, perm);
      const id = num(p, 'workId');
      const wk = w.works.find((x) => x.id === id);
      if (!wk || wk.state > 1 || wk.kind === 'maintenance') return reject(cmd, 'unknown_project');
      cancelWork(w, wk);
      w.version++;
      return accept(cmd);
    }
    case 'OrderImport': {
      const perm = needLeader(w);
      if (perm) return reject(cmd, perm);
      const r = orderImport(w, num(p, 'nodeId') ?? -1, num(p, 'item') ?? -1, num(p, 'qty') ?? -1, cmd.commandId);
      if (!r.ok) return reject(cmd, r.reason);
      w.version++;
      return accept(cmd);
    }
    default:
      return reject(cmd, 'not_implemented');
  }
}
