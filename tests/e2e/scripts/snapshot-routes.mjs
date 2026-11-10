// Snapshot all h5 routes to static HTML.
// Usage: E2E_BASE_URL=http://127.0.0.1:18000 node tests/e2e/scripts/snapshot-routes.mjs [outdir]
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:18000';
const OUT = process.argv[2] || 'tests/e2e/evidence/h5-snapshots';

const ROUTES = [
  { path: '/', name: '01-home' },
  { path: '/watchlist', name: '02-watchlist' },
  { path: '/stocks/SSE:600519', name: '03-stock-sse-600519' },
  { path: '/review/portfolio', name: '04-portfolio-review' },
  { path: '/review/limits', name: '05-limit-ladder' },
  { path: '/ai', name: '06-ai-home' },
  { path: '/me', name: '07-me' },
  { path: '/dev/ai-card', name: '08-ai-card-fixture' },
  { path: '/this-route-does-not-exist', name: '09-not-found' },
];

const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844 },
  { name: '375x667', width: 375, height: 667 },
];

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const manifest = [];
try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    for (const r of ROUTES) {
      const url = BASE + r.path;
      let status = 'ok';
      let error = '';
      try {
        const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
        status = 'http_' + (resp ? resp.status() : 'noresp');
        await page.waitForTimeout(300);
        const html = await page.content();
        const file = path.join(OUT, `${r.name}.${vp.name}.html`);
        await writeFile(file, html, 'utf8');
        await page.screenshot({ path: file.replace(/\.html$/, '.png'), fullPage: true });
        manifest.push({ route: r.path, name: r.name, viewport: vp.name, url, status, htmlFile: file, bytes: html.length });
      } catch (e) {
        status = 'error';
        error = String(e && e.message ? e.message : e);
        manifest.push({ route: r.path, name: r.name, viewport: vp.name, url, status, error });
      }
      console.log(`[${vp.name}] ${r.path} -> ${status}${error ? ' :: ' + error : ''}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}

const mfPath = path.join(OUT, 'manifest.json');
await writeFile(mfPath, JSON.stringify({ base: BASE, generatedAt: new Date().toISOString(), routes: ROUTES.length, viewports: VIEWPORTS.length, entries: manifest }, null, 2), 'utf8');
console.log('manifest:', mfPath, 'entries:', manifest.length);
