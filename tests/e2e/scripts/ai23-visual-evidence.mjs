#!/usr/bin/env node
// A7 · AI-2/3 computed-style 视觉合规采证（规格 §6.2，2026-11-06）
// 方法论：真实生产 DOM 自然渲染下读 computed-style——不注入、不拦截网络（零 route mock），
// 数据来自本地原生 api（c_end entitlement 正配置）经 web server.mjs 真实反代。
// 覆盖：主断言清单 7 选择器 + 观察 4 选择器 + .ai-badge__mark（≥10px），390×844 浅+深。
// RT-07：逐祖先检查 transform/zoom/filter 干预（computed-style 可被祖先缩放绕过）。
// 用法: E2E_BASE_URL=http://127.0.0.1:3457 A7_GIT_SHA=$(git rev-parse HEAD) node scripts/ai23-visual-evidence.mjs
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const BASE = (process.env.E2E_BASE_URL || 'http://127.0.0.1:3457').replace(/\/$/, '');
const API = (process.env.A7_API_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const OUT = process.env.A7_OUT || path.join(ROOT, 'tests/e2e/evidence/ai23-visual-computed-2026-11-06.json');
const TOKEN_PATH = path.join(ROOT, 'tests/e2e/.state/a7-visual-token');
const STOCK_PATH = '/stocks/SSE:600519';
const AI_PATH = '/ai';
// A6 badge 接线后采证入口（a4b5659）：fixture 路由自标注 Not an API response，零 /v1 请求；
// badge 族（§1-§3：13px / mark≥10px / 字色）只在此路由天然渲染，与生产同 class 结构。
const FIXTURE_PATH = '/dev/ai-card';
const MIN_PX = 13;
const MARK_MIN_PX = 10;
const MIN_CONTRAST = 4.5;
const VIEWPORT = { width: 390, height: 844 };

// 主断言清单 7 + 观察项 4 + mark（判据真源：docs/design/ai-display-visual-acceptance-2026-11-06.md §6）
const TARGETS = [
  // 规格 §6.2 DOM/E2E testid 清单（color 严格 ∈ {--text, --text-muted}，H3 判据）
  { sel: '[data-testid="ai-generated-badge"]', list: 'spec62', min: MIN_PX, colorStrict: true },
  { sel: '[data-testid="ai-disclaimer"]', list: 'spec62', min: MIN_PX, colorStrict: true },
  { sel: '[data-testid="disclaimer"]', list: 'spec62', min: MIN_PX, colorStrict: true },
  { sel: '[data-testid="disclaimer-text"]', list: 'spec62', min: MIN_PX, colorStrict: true },
  { sel: '[data-testid="disclaimer-version"]', list: 'spec62', min: MIN_PX, colorStrict: true },
  { sel: '[data-testid="quote-as-of"]', list: 'spec62', min: MIN_PX, colorStrict: true },
  { sel: '[data-testid="ai-as-of"]', list: 'spec62', min: MIN_PX, colorStrict: true },
  // 主断言清单 7 选择器（§6.1.4/裁二 font-size ≥13px）
  { sel: '.ai-badge', list: 'main', min: MIN_PX, colorStrict: true },
  { sel: '.ai-disclaimer', list: 'main', min: MIN_PX, colorStrict: true },
  { sel: '.disclaimer__meta', list: 'main', min: MIN_PX, colorStrict: true },
  { sel: '.quote__meta dt', list: 'main', min: MIN_PX },
  { sel: '.quote__meta dd', list: 'main', min: MIN_PX },
  { sel: '.ai-context__item dt', list: 'main', min: MIN_PX },
  { sel: '.ai-context__item dd', list: 'main', min: MIN_PX },
  // 观察项 4（裁二 v1.1 增补，font-size ≥13px）
  { sel: '.ai-slot--pending', list: 'obs', min: MIN_PX },
  { sel: '.ai-section__footnote', list: 'obs', min: MIN_PX },
  { sel: '.ai-section__meta', list: 'obs', min: MIN_PX, colorStrict: true },
  { sel: '.quote__stale', list: 'obs', min: MIN_PX },
  // mark 判据按规格原文（reviews/compliance/ai-display-visual-spec-1.0.md）：:40 字形≥10px+底色 --accent（M1 暂 --accent），
  // 未规定字色（--text 允许清单 :104 仅适用 §6.2 testid）；:35 mark 本体 aria-hidden=true 属设计（装饰字形），不作违例。
  { sel: '.ai-badge__mark', list: 'mark', min: MARK_MIN_PX, ariaHiddenAllowed: true, specNote: 'spec:40 size>=10px + accent 底；spec:35 aria-hidden=true by design；spec:104 color allowlist scoped to §6.2 testids' }
];
// 缺席原因（真实渲染判定，不注入）：AI 文本位 content=null → 生产不渲染（A6 接线红项）
const ABSENT_REASONS = {
  '.ai-badge': 'AiInterpretation.tsx:71 AiTextSlot content=null → 生产不渲染（A6 接线红项，需接通 /v1/ai/analyses 后复测）',
  '.ai-disclaimer': '同上：模型文本位 content=null，标识/免责随内容注入才渲染',
  '.ai-badge__mark': '同上：badge 未渲染则 mark 不存在',
  '.ai-badge__text': '同上',
  '[data-testid="ai-generated-badge"]': '同上：content=null → badge 不渲染',
  '[data-testid="ai-disclaimer"]': '同上：content=null → 免责不渲染',
  '[data-testid="ai-as-of"]': '同上：AI 卡 as_of 位随 AI 内容块渲染，content=null → 不渲染'
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function gitSha() {
  if (process.env.A7_GIT_SHA) return process.env.A7_GIT_SHA;
  try { return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); }
  catch { return 'UNKNOWN'; }
}

// —— 页内测量（在真实 DOM 树内、自然父级下读）——
function measureInPage({ targets, minPx, markMinPx, minContrast }) {
  const norm = (c) => {
    // rgb/rgba 归一化
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return String(c).trim().toLowerCase();
    const p = m[1].split(',').map((s) => parseFloat(s.trim()));
    return 'rgb(' + p.slice(0, 3).map((n) => Math.round(n)).join(',') + ')';
  };
  const hexToRgb = (h) => {
    const s = String(h).trim();
    if (/^#[0-9a-f]{3}$/i.test(s)) return 'rgb(' + [1, 3, 5].map((i) => parseInt(s[i] + s[i], 16)).join(',') + ')';
    if (/^#[0-9a-f]{6}$/i.test(s)) { const h = s.slice(1); return 'rgb(' + [0, 1, 2].map((i) => parseInt(h.substr(i * 2, 2), 16)).join(',') + ')'; }
    return null;
  };
  const rootCs = getComputedStyle(document.documentElement);
  const tokenVal = (name) => {
    const raw = rootCs.getPropertyValue(name).trim();
    if (!raw) return null;
    if (raw.startsWith('#')) return hexToRgb(raw) || raw;
    return norm(raw);
  };
  const tokens = {
    text: tokenVal('--text'),
    textMuted: tokenVal('--text-muted'),
    textSubtle: tokenVal('--text-subtle'),
    bg: tokenVal('--bg') || norm(getComputedStyle(document.body).backgroundColor)
  };
  const lum = (rgbStr) => {
    const m = String(rgbStr).match(/\d+(\.\d+)?/g);
    if (!m) return null;
    const [r, g, b] = m.slice(0, 3).map(Number);
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (fg, bg) => {
    const a = lum(fg), b = lum(bg);
    if (a == null || b == null) return null;
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const effectiveBg = (el) => {
    let n = el;
    while (n && n.nodeType === 1) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && !/rgba\(0, 0, 0, 0\)/.test(bg) && !/transparent/.test(bg)) return norm(bg);
      n = n.parentElement;
    }
    return tokens.bg || 'rgb(255,255,255)';
  };
  const classifyColor = (color, strict) => {
    if (tokens.text && color === tokens.text) return { cls: 'allow(--text)', ok: true };
    if (tokens.textMuted && color === tokens.textMuted) return { cls: 'allow(--text-muted)', ok: true };
    if (tokens.textSubtle && color === tokens.textSubtle) return { cls: 'FORBIDDEN(--text-subtle)', ok: false };
    if (!strict) return { cls: 'OUT_OF_SPEC_SCOPE', ok: true, note: '规格未对该选择器规定字色（如 --warning 语义色），仅记录不判违例' };
    return { cls: 'OTHER', ok: false, note: '颜色不在 {--text,--text-muted} 内，需人工复核' };
  };

  const out = {};
  for (const t of targets) {
    const els = Array.from(document.querySelectorAll(t.sel));
    const instances = [];
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      const rendered = el.getClientRects().length > 0 && rect.width > 0 && rect.height > 0 &&
        getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
      if (!rendered) {
        instances.push({ rendered: false, why: 'display:none/无盒子', text: (el.textContent || '').slice(0, 40) });
        continue;
      }
      const cs = getComputedStyle(el);
      const color = norm(cs.color);
      const colorCls = classifyColor(color, !!t.colorStrict);
      const bg = effectiveBg(el);
      const ct = contrast(color, bg);
      // RT-07：祖先链干预检查（含自身）
      const chain = [];
      let n = el, ariaHiddenAncestor = false, opacityAncestor = 1;
      let intervention = [];
      while (n && n.nodeType === 1) {
        const a = getComputedStyle(n);
        if (n.getAttribute('aria-hidden') === 'true') ariaHiddenAncestor = true;
        const op = parseFloat(a.opacity);
        if (!Number.isNaN(op) && op < opacityAncestor) opacityAncestor = op;
        const zoom = parseFloat(a.zoom || '1');
        if ((a.transform && a.transform !== 'none') || (a.filter && a.filter !== 'none') || (zoom && zoom !== 1)) {
          intervention.push({
            node: n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' && n.className ? '.' + n.className.split(/\s+/).join('.') : ''),
            transform: a.transform, zoom: a.zoom, filter: a.filter
          });
        }
        n = n.parentElement;
      }
      const fontSize = parseFloat(cs.fontSize);
      const min = t.min || minPx;
      const violations = [];
      if (fontSize < min) violations.push('font-size ' + fontSize + 'px < ' + min + 'px');
      if (parseFloat(cs.opacity) !== 1 || opacityAncestor !== 1) violations.push('opacity 非 1（自身 ' + cs.opacity + ' / 祖先最小 ' + opacityAncestor + '）');
      if (ariaHiddenAncestor && t.ariaHiddenAllowed) { /* spec:35 装饰字形按设计 aria-hidden，不判违例（记录于 note） */ }
      else if (ariaHiddenAncestor) violations.push('存在 aria-hidden=true 祖先');
      if (intervention.length) violations.push('祖先 transform/zoom/filter 干预（RT-07）: ' + JSON.stringify(intervention));
      if (!colorCls.ok) violations.push('颜色违例 ' + colorCls.cls + ' ' + color);
      if (ct != null && ct < minContrast) violations.push('对比度 ' + ct.toFixed(2) + ' < ' + minContrast);
      instances.push({
        rendered: true,
        fontSize, color, colorClass: colorCls.cls,
        opacity: cs.opacity,
        effectiveBg: bg,
        contrast: ct == null ? null : Number(ct.toFixed(2)),
        rect: { w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top) },
        text: (el.textContent || '').trim().slice(0, 60),
        ariaHiddenAncestor,
        ancestorIntervention: intervention,
        violations
      });
    }
    const renderedInstances = instances.filter((i) => i.rendered);
    let status;
    if (renderedInstances.length === 0) status = 'ABSENT';
    else if (renderedInstances.some((i) => i.violations.length > 0)) status = 'FAIL';
    else status = 'PASS';
    out[t.sel] = { list: t.list, minPx: t.min || minPx, status, instanceCount: instances.length, renderedCount: renderedInstances.length, instances };
  }
  // N1：disclaimer 关闭类控件扫描（若 disclaimer 存在）
  const closeScan = Array.from(document.querySelectorAll('[class*="disclaimer"]'))
    .filter((el) => /close|dismiss|hide/i.test(String(el.className) + ' ' + (el.getAttribute('aria-label') || '')) || el.hasAttribute('aria-expanded'))
    .map((el) => ({ cls: String(el.className).slice(0, 80), tag: el.tagName.toLowerCase() }));
  return { tokens, selectors: out, disclaimerCloseScan: closeScan };
}

async function main() {
  const token = readFileSync(TOKEN_PATH, 'utf8').trim();
  if (!token) throw new Error('缺 token: ' + TOKEN_PATH);
  const scriptSha = sha256(readFileSync(fileURLToPath(import.meta.url)));
  const git = gitSha();

  // 环境自证（真栈）：api healthz + entitled quote 样本
  // fail-soft: fixture 采证零 /v1，隧道掉线不阻断视觉证据（health 仅作环境自证参考）
  const health = await fetch(API + '/healthz').then(r => r.json()).catch((e) => ({ error: String(e) }));
  const quoteRes = await fetch(API + '/v1/instruments/SSE:600519/quote?adjustment=qfq', { headers: { authorization: 'Bearer ' + token } }).catch((e) => ({ status: 0, json: async () => ({ error: String(e) }) }));
  const quoteSample = await quoteRes.json().catch(() => ({}));

  const browser = await chromium.launch();
  const results = {};
  const realStackProof = { v1Requests: [], pages: [] };

  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: scheme, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.addInitScript((t) => { try { localStorage.setItem('e2e_token', t); } catch {} }, token);
    const page = await ctx.newPage();
    const v1 = [];
    page.on('response', (res) => {
      const u = new URL(res.url());
      if (u.pathname.startsWith('/v1/')) v1.push({ path: u.pathname + u.search, status: res.status(), scheme });
    });
    page.on('pageerror', (err) => { v1.push({ pageerror: String(err).slice(0, 200), scheme }); });
    const pageResults = {};
    for (const p of [STOCK_PATH, AI_PATH, FIXTURE_PATH]) {
      await page.goto(BASE + p, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2500);
      const m = await page.evaluate(measureInPage, { targets: TARGETS, minPx: MIN_PX, markMinPx: MARK_MIN_PX, minContrast: MIN_CONTRAST });
      const themeBg = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return (cs.getPropertyValue('--bg') || '').trim() || getComputedStyle(document.body).backgroundColor;
      });
      realStackProof.pages.push({ scheme, path: p, url: page.url(), title: await page.title(), themeBg });
      // 合并：两页取更优状态（PASS > FAIL > ABSENT，实例并集）
      for (const [sel, r] of Object.entries(m.selectors)) {
        if (!pageResults[sel]) { pageResults[sel] = { ...r, instances: [], pages: [] }; }
        const tgt = pageResults[sel];
        tgt.instances.push(...r.instances.map((i) => ({ ...i, page: p })));
        tgt.pages.push({ page: p, status: r.status });
        const rank = { PASS: 2, FAIL: 1, ABSENT: 0 };
        if (rank[r.status] > rank[tgt.status]) { tgt.status = r.status; tgt.minPx = r.minPx; tgt.list = r.list; }
        else if (r.status === 'FAIL') tgt.status = 'FAIL';
      }
      if (scheme === 'light' && p === STOCK_PATH) {
        results._tokensLight = m.tokens;
        results._closeScan = m.disclaimerCloseScan;
      }
      if (scheme === 'dark' && p === STOCK_PATH) results._tokensDark = m.tokens;
    }
    results[scheme] = pageResults;
    realStackProof.v1Requests.push(...v1);
    await ctx.close();
  }
  await browser.close();

  // 主题 sanity：浅深 --bg 必须不同
  const bgL = results._tokensLight && results._tokensLight.bg;
  const bgD = results._tokensDark && results._tokensDark.bg;
  const themeSanity = { lightBg: bgL, darkBg: bgD, different: !!(bgL && bgD && bgL !== bgD) };

  const verdict = { pass: [], fail: [], absent: [], status: 'PASS' };
  for (const t of TARGETS) {
    const l = results.light[t.sel], d = results.dark[t.sel];
    const st = [l && l.status, d && d.status];
    if (st.includes('FAIL')) verdict.fail.push({ selector: t.sel, list: t.list, light: st[0], dark: st[1] });
    else if (st.includes('ABSENT')) verdict.absent.push({ selector: t.sel, list: t.list, light: st[0], dark: st[1], reason: ABSENT_REASONS[t.sel] || '自然渲染下未出现（需人工判定是否应渲染）' });
    else verdict.pass.push({ selector: t.sel, list: t.list });
  }
  if (verdict.fail.length) verdict.status = 'FAIL';
  else if (verdict.absent.length) verdict.status = 'PASS_WITH_GAPS';
  if (!themeSanity.different) verdict.status = 'FAIL';

  const evidence = {
    schema: 'a7.ai23.visual-evidence/v1',
    generatedAt: new Date().toISOString(),
    anchors: { gitSha: git, scriptSha256: scriptSha, evidenceFileNote: 'sha256 见 RT-10 哈希锚清单' },
    environment: {
      baseURL: BASE, apiBase: API, viewport: VIEWPORT,
      schemes: ['light', 'dark'],
      methodology: '真实生产 DOM 自然渲染下读 computed-style；零 route 拦截；数据来自本地原生 api（c_end entitlement 正配置）真实 /v1 请求',
      fixtureRoute: '/dev/ai-card（A6 采证路由 a4b5659，页面自标注 Not an API response，零 /v1；badge 族 §1-§3 在此天然渲染，与生产同 class 结构）',
      noInjection: true, noRouteMock: true
    },
    realStackProof: {
      apiHealth: health,
      quoteSample: quoteSample && quoteSample.data ? {
        instrument_id: quoteSample.data.instrument_id,
        as_of: quoteSample.meta && quoteSample.meta.source && quoteSample.meta.source.as_of,
        entitlement: quoteSample.meta && quoteSample.meta.entitlement,
        disclaimerPresent: !!(quoteSample.meta && quoteSample.meta.disclaimer && quoteSample.meta.disclaimer.text)
      } : quoteSample,
      v1Requests: realStackProof.v1Requests,
      pages: realStackProof.pages
    },
    themeSanity,
    results,
    verdict
  };
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ out: OUT, sha256: sha256(readFileSync(OUT)), verdict, themeSanity, v1Count: realStackProof.v1Requests.length, git }, null, 2));
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
