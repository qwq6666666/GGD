import { describe, expect, it } from 'vitest';
import type { Command } from '@ss/schema';
import { createWorld, runDays, stateHash, submitCommand } from '@ss/sim';
import { MemorySaveStore, SaveError, createSave, parseSave, serializeSave } from '../src/index.js';

describe('存檔（GDD 12、14 存檔回放）', () => {
  it('存讀後繼續推進的 hash 與不中斷模擬一致', () => {
    const a = createWorld(77);
    runDays(a, 200);
    const { world: b } = parseSave(serializeSave(createSave(a, [])));
    expect(stateHash(b)).toBe(stateHash(a));
    runDays(a, 500);
    runDays(b, 500);
    expect(stateHash(b)).toBe(stateHash(a));
  });

  it('同 seed＋命令日誌回放得到相同 hash', () => {
    const live = createWorld(5);
    const log: Command[] = [];
    for (let i = 0; i < 10; i++) {
      const c: Command = { commandId: i + 1, issuedTick: live.tick, expectedWorldVersion: live.version, type: 'Noop', payload: { note: '' } };
      submitCommand(live, c);
      log.push(c);
      runDays(live, 13);
    }
    const save = parseSave(serializeSave(createSave(live, log))).save;
    const replay = createWorld(save.seed);
    for (const c of save.commandLog) submitCommand(replay, c);
    runDays(replay, save.tick - replay.tick);
    expect(stateHash(replay)).toBe(stateHash(live));
  });

  it('竄改內容會被 checksum 攔截', () => {
    const text = serializeSave(createSave(createWorld(1), []));
    const tampered = text.replace('"tick":59', '"tick":60');
    expect(tampered).not.toBe(text);
    expect(() => parseSave(tampered)).toThrow(SaveError);
  });

  it('拒絕格式錯誤與未來版本的存檔', () => {
    expect(() => parseSave('not json')).toThrow(/valid JSON/);
    expect(() => parseSave('{"format":"x"}')).toThrow(SaveError);
    const future = JSON.parse(serializeSave(createSave(createWorld(1), [])));
    future.schemaVersion = 999;
    expect(() => parseSave(JSON.stringify(future))).toThrow(/newer/);
  });

  it('只保留最近 3 個恢復點', async () => {
    const store = new MemorySaveStore();
    for (const t of ['1', '2', '3', '4']) await store.write('main', t);
    expect(await store.list('main')).toEqual(['4', '3', '2']);
  });
});

import { checksumOf, CURRENT_SCHEMA_VERSION } from '../src/index.js';

describe('存檔遷移（schema v1 → 現行版本）', () => {
  const v1 = (tick: number): string => {
    const body = { format: 'shengsheng-save', schemaVersion: 1, simVersion: '0.1.0-a0', worldVersion: 0, seed: 42, tick, state: { id: 'world-42', tick, version: 0, eventLog: [] }, commandLog: [] };
    return JSON.stringify({ ...body, checksum: checksumOf(body) });
  };

  it('A0 骨架存檔可遷移：同 seed 重建、日期相同、檢查碼有效、可繼續模擬', () => {
    const { world, save, warnings } = parseSave(v1(59 + 90));
    expect(save.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(world.tick).toBe(59 + 90);
    expect(world.seed).toBe(42);
    expect(world.npcs.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes('遷移'))).toBe(true);
    runDays(world, 30, { checkInvariants: true });
    // 遷移後再存再讀 hash 一致
    const again = parseSave(serializeSave(createSave(world, [])));
    expect(stateHash(again.world)).toBe(stateHash(world));
  });

  it('遷移前就先驗證檢查碼：被竄改的舊存檔被拒絕', () => {
    const text = v1(100).replace('"tick":100', '"tick":101');
    expect(() => parseSave(text)).toThrow(SaveError);
  });

  it('規則版本不同時給出警告而不是失敗', () => {
    const w = createWorld(3);
    const s = createSave(w, []);
    const body = { ...s, simVersion: '0.0.1' } as Record<string, unknown>;
    delete body.checksum;
    const text = JSON.stringify({ ...body, checksum: checksumOf(body) });
    expect(parseSave(text).warnings.some((x) => x.includes('規則版本'))).toBe(true);
  });
});

describe('存檔遷移（schema v2 → v3：村級階段）', () => {
  it('v2 存檔補上階段與可建區，不損失既有資料，可繼續模擬', () => {
    const w = createWorld(7);
    runDays(w, 40);
    const cur = JSON.parse(serializeSave(createSave(w, []))) as Record<string, unknown>;
    const state = JSON.parse(JSON.stringify(cur.state)) as Record<string, unknown>;
    delete state.progress;
    const map = state.map as Record<string, unknown>;
    delete map.zmin;
    delete map.zmax;
    const body: Record<string, unknown> = { ...cur, schemaVersion: 2, state };
    delete body.checksum;
    const text = JSON.stringify({ ...body, checksum: checksumOf(body) });
    const { world, save } = parseSave(text);
    expect(save.schemaVersion).toBe(3);
    expect(world.progress).toEqual({ stage: 0, done: [] });
    expect(world.map.zmin).toBe(24);
    expect(world.map.zmax).toBe(72);
    expect(world.npcs.length).toBe(w.npcs.length);
    runDays(world, 30, { checkInvariants: true });
  });
});
