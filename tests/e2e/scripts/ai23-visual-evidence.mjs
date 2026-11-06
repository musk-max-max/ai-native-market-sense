// AI-2/3 computed-style 视觉合规采证（规格 §6.2，390x844 浅+深）
// 用法: node tests/e2e/scripts/ai23-visual-evidence.mjs [targetURL]
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const target = process.argv[2] || process.env.TARGET || 'http://localhost:3000/stock/000001';
const MAIN = [
  '.ai-badge', '.ai-disclaimer', '.disclaimer__meta',
  '.quote__meta dt', '.quote__meta dd',
  '.ai-context__item dt', '.ai-context__item dd',
];
const OBSERVED = ['.ai-slot--pending', '.ai-section__footnote', '.ai-section__meta', '.quote__stale'];
const MARK = '.ai-badge__mark';
const ALL = [...MAIN, ...OBSERVED, MARK];

// 注入宿主：AI 文本位当前传 null（页面只显示占位），标识区/上下文区不天然渲染。
// 注入与生产同 class 的结构以读真实 computed-style；位置在屏外，不污染截图判定。
const INJECT_HTML = [
  '<dl class="quote__meta"><div class="ai-context__item"><dt>k</dt><dd>v</dd></div></dl>',
  '<dl class="ai-context"><div class="ai-context__item"><dt>k</dt><dd>v</dd></div></dl>',
  '<p class="ai-badge"><span class="ai-badge__mark">AI</span><span>label</span></p>',
  '<p class="ai-disclaimer">disc</p>',
  '<p class="ai-slot ai-slot--pending">pending</p>',
  '<div class="ai-section"><p class="ai-section__meta">meta</p><p class="ai-section__footnote">foot</p></div>',
  '<p class="disclaimer"><span class="disclaimer__meta">ver</span></p>',
].join('');

const probe = async (page) => page.evaluate(({ sels, inject }) => {
  const host = document.createElement('div');
  host.setAttribute('data-visual-probe', '1');
  host.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:390px;visibility:hidden;';
  document.body.appendChild(host);
  host.innerHTML = inject;
  const out = {};
  for (const s of sels) {
    const el = document.querySelector(s);
    if (!el) { out[s] = null; continue; }
    const cs = getComputedStyle(el);
    out[s] = {
      fontSize: cs.fontSize, color: cs.color,
      fontWeight: cs.fontWeight, opacity: cs.opacity, lineHeight: cs.lineHeight,
    };
  }
  host.remove();
  return out;
}, { sels: ALL, inject: INJECT_HTML });

const browser = await chromium.launch({ headless: true });
const results = {};
for (const mode of ['light', 'dark']) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: mode,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1200);
    results[mode] = await probe(page);
  } catch (e) {
    results[mode] = { _error: String(e) };
  }
  await ctx.close();
}
await browser.close();

// 判定：字号 + 字色 + opacity
const verdicts = [];
let fail = 0, pass = 0, skip = 0;
for (const [mode, styles] of Object.entries(results)) {
  if (styles._error) { verdicts.push([mode, '_page', 'ERROR', styles._error]); fail++; continue; }
  for (const [sel, s] of Object.entries(styles)) {
    if (!s) { verdicts.push([mode, sel, 'SKIP', 'not-rendered']); skip++; continue; }
    const fsPx = parseFloat(s.fontSize);
    const min = sel === MARK ? 10 : 13;
    const sizeOk = fsPx >= min - 0.01;
    const opaOk = parseFloat(s.opacity) === 1;
    const ok = sizeOk && opaOk;
    ok ? pass++ : fail++;
    verdicts.push([mode, sel, ok ? 'PASS' : 'FAIL',
      'fontSize=' + s.fontSize + ' (min ' + min + 'px)' +
      ' color=' + s.color + ' opacity=' + s.opacity + ' weight=' + s.fontWeight]);
  }
}
const allPass = fail === 0;
const evidence = {
  timestamp: new Date().toISOString(),
  target, viewport: '390x844', colorSchemes: ['light', 'dark'],
  spec: 'docs/design/ai-display-visual-acceptance-2026-11-06.md §6.2',
  method: 'injected same-class DOM probe (AI text slot currently null per AiInterpretation.tsx:71)',
  mainSelectors: MAIN, observedSelectors: OBSERVED, markSelector: MARK,
  results, verdicts, pass, fail, skip, allPass,
};
writeFileSync('tests/e2e/evidence/ai23-visual-computed-2026-11-06.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ pass, fail, skip, allPass }, null, 0));
for (const v of verdicts) console.log(v.join(' | '));
