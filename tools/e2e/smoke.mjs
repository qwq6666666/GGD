// 真瀏覽器冒煙測試（GDD 13、15 C1）：開局選家族 → 時間推進 → 建設流程 → 存檔重載；並驗證多種螢幕尺寸與 44px 觸控區。
// 用法：pnpm build && pnpm e2e   （需要 Playwright 與 Chromium；CI 預設不執行）
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PORT = 4179;
const URL = `http://localhost:${PORT}/`;
const OUT = process.env.E2E_OUT ?? 'docs/screenshots';
mkdirSync(OUT, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: 'apps/web', stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(URL)).ok) break; } catch { /* 等待伺服器啟動 */ }
  await sleep(250);
}

const failures = [];
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failures.push(name); };

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const sizes = [[390, 844], [360, 740], [430, 932], [1280, 800]];
  for (const [w, h] of sizes) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await page.goto(URL);
    await page.waitForSelector('[data-pick]');
    await page.click('[data-pick="0"]');
    await page.waitForFunction(() => document.querySelector('#date').textContent.includes('第1年'));
    await sleep(700);
    const layout = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, iw: window.innerWidth,
      small: [...document.querySelectorAll('#bottom button, #speed button, #zoom button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).length,
    }));
    check(`${w}x${h} 無橫向捲動`, layout.sw <= layout.iw + 1, `${layout.sw}/${layout.iw}`);
    check(`${w}x${h} 觸控區 ≥ 44px`, layout.small === 0, `${layout.small} 個過小`);
    if (w === 390) {
      await page.screenshot({ path: `${OUT}/c1-map-390.png` });
      await page.click('button[data-speed="fast"]');
      await sleep(5000);
      await page.click('button[data-speed="pause"]');
      const d1 = await page.textContent('#date');
      check('時間會推進', !d1.includes('第60日'), d1);
      // 建設：土路
      await page.click('button[data-tab="build"]');
      await page.click('button[data-act="mode:road"]');
      const box = await page.locator('#map').boundingBox();
      await page.mouse.click(box.x + 120, box.y + 140);
      await page.mouse.click(box.x + 250, box.y + 140);
      const ok = await page.locator('button[data-act="do:road"]').isEnabled();
      check('道路預覽可確認', ok);
      if (ok) await page.click('button[data-act="do:road"]');
      await sleep(400);
      await page.click('button[data-tab="build"]');
      // 存檔 → 重新載入 → 繼續
      await page.click('button[data-tab="world"]');
      await page.click('button[data-act="sub:world:sys"]');
      await page.click('button[data-act="save"]');
      await sleep(600);
      await page.reload();
      await page.waitForSelector('[data-continue]');
      await page.click('[data-continue]');
      await page.waitForFunction(() => document.querySelector('#date').textContent.includes('第1年'));
      const d2 = await page.textContent('#date');
      check('存檔重載後從原日期繼續', d2.slice(0, 12) === d1.slice(0, 12) || d2 >= d1, `${d1} → ${d2}`);
      await page.screenshot({ path: `${OUT}/c1-after-reload.png` });
    }
    if (w === 1280) await page.screenshot({ path: `${OUT}/c1-desktop.png` });
    check(`${w}x${h} 無 console 錯誤`, errs.length === 0, errs.slice(0, 2).join(' | '));
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`\n${failures.length} 項失敗`); process.exit(1); }
console.log('\n全部通過');
