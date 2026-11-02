import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/** 受保護測試：確認 CI 會攔截 packages/sim 內的非決定性 API（GDD 11.3、16.4）。 */
const eslint = new ESLint({ cwd: process.cwd() });
const SIM_FILE = 'packages/sim/src/__lint_fixture__.ts';

async function messagesFor(code: string, filePath = SIM_FILE): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath });
  return (res?.messages ?? []).map((m) => m.ruleId ?? 'fatal');
}

describe('決定性 lint 規則', () => {
  it.each([
    ['Math.random()', 'no-restricted-properties'],
    ['Math.pow(2, 3)', 'no-restricted-properties'],
    ['Math.exp(1)', 'no-restricted-properties'],
    ['Date.now()', 'no-restricted-properties'],
    ['new Date()', 'no-restricted-globals'],
    ['performance.now()', 'no-restricted-properties'],
    ['2 ** 3', 'no-restricted-syntax'],
    ['new Map()', 'no-restricted-syntax'],
    ['document.title', 'no-restricted-globals'],
  ])('攔截 %s', async (expr, rule) => {
    expect(await messagesFor(`export const x = ${expr};\n`)).toContain(rule);
  });

  it('攔截 import phaser', async () => {
    expect(await messagesFor(`import Phaser from 'phaser';\nexport const p = Phaser;\n`)).toContain('no-restricted-imports');
  });

  it('允許 Math.imul / Math.floor', async () => {
    expect(await messagesFor('export const x = Math.imul(3, 5) + Math.floor(7 / 2);\n')).toEqual([]);
  });

  it('規則只套用於 packages/sim', async () => {
    expect(await messagesFor('export const x = Math.random();\n', 'apps/web/src/__fixture__.ts')).toEqual([]);
  });
});
