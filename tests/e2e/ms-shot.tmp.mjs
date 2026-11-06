import { chromium } from '@playwright/test';
const token = process.env.SHOT_TOKEN;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.addInitScript(t => localStorage.setItem('e2e_token', t), token);
const shots = [
  ['home', 'http://127.0.0.1:3000/'],
  ['stock-600519', 'http://127.0.0.1:3000/stocks/SSE:600519'],
  ['stock-000001', 'http://127.0.0.1:3000/stocks/SZSE:000001'],
  ['watchlist', 'http://127.0.0.1:3000/watchlist'],
];
for (const [name, url] of shots) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: '/tmp/ms-shots/' + name + '.png', fullPage: true });
    console.log('shot ok: ' + name);
  } catch (e) { console.log('shot FAIL ' + name + ': ' + e.message); }
}
await browser.close();
