// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** 影響世界狀態時可能因 JS 引擎而異的 Math 函式（GDD 11.3）。曲線一律查表。 */
const NONDETERMINISTIC_MATH = ['random', 'exp', 'expm1', 'pow', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'log', 'log2', 'log10', 'log1p', 'cbrt', 'hypot', 'fround'];

export const determinismRules = {
  'no-restricted-properties': [
    'error',
    ...NONDETERMINISTIC_MATH.map((property) => ({
      object: 'Math',
      property,
      message: `packages/sim 禁用 Math.${property}（決定性，GDD 11.3）；請改用查表或 fixed.ts。`,
    })),
    { object: 'Date', property: 'now', message: '禁用 Date.now（決定性）。' },
    { object: 'performance', property: 'now', message: '禁用 performance.now（決定性）。' },
  ],
  'no-restricted-globals': [
    'error',
    ...['Date', 'performance', 'window', 'document', 'navigator', 'localStorage', 'indexedDB', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'crypto'].map(
      (name) => ({ name, message: `packages/sim 禁用 ${name}（純模擬核心不得依賴時間或瀏覽器，GDD 11.1/11.3）。` }),
    ),
  ],
  'no-restricted-syntax': [
    'error',
    { selector: "BinaryExpression[operator='**']", message: '禁用 ** 運算子（決定性）；請用整數乘法或查表。' },
    { selector: "AssignmentExpression[operator='**=']", message: '禁用 **= 運算子（決定性）。' },
    { selector: 'NewExpression[callee.name=/^(Map|Set|WeakMap|WeakSet)$/]', message: '世界狀態須為純 JSON；如需暫存請用排序後的陣列或物件（ADR-0003）。' },
  ],
  'no-restricted-imports': [
    'error',
    {
      paths: [{ name: 'phaser', message: 'packages/sim 禁止 import Phaser（GDD 11.1）。' }],
      patterns: [{ group: ['node:*', 'fs', 'path'], message: 'packages/sim 必須可在瀏覽器與 Node 執行，不得依賴 Node API。' }],
    },
  ],
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', 'apps/web/public/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['tools/e2e/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', setTimeout: 'readonly', fetch: 'readonly', console: 'readonly', document: 'readonly', window: 'readonly' } },
  },
  {
    files: ['packages/sim/src/**/*.ts'],
    rules: determinismRules,
  },
);
