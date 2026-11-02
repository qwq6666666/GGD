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
