// tests/e2e/specs/ai-card-compliance.spec.js
// AI-2 / AI-3 E2E 证据（收件登记 E-AI2-02 + E-AI3-01，AI-CARD-CLOSURE-TRACKER-2026-11-06）。
//
// 判据真源（H3 签发，测试不自造判据）：
//   reviews/compliance/AI-CARD-SIGNOFF-2026-11-06.md —— AI2-1/2/3、AI3-1/2 闭环判据
//   reviews/compliance/ai-display-visual-spec-1.0.md —— N1~N6、§3 as_of 原样规则、§6.1.4/§6.2 选择器清单
// 选择器纪律：testid 一律经 tests/e2e/testids.json（tid）解析；§6.1.4 类选择器为规格明文清单（唯二允许写死的选择器来源）。
// hop 定位：每条用例标签 [hop:...]，失败信息必须能指出「哪一跳坏了」（web渲染/契约/mock）。
//
// 跑法（Lead L0 授权独立端口自跑，不动共享栈）：
//   pnpm -C web/h5 build && PORT=3456 node web/h5/server.mjs &
//   E2E_SKIP_PREFLIGHT=1 E2E_BASE_URL=http://127.0.0.1:3456 npx playwright test specs/ai-card-compliance.spec.js
// 证据 JSON 落 tests/e2e/evidence/ai-card-2026-11-06/；汇总报告落 tests/data/acceptance/artifacts/。
//
// 红线（A7 身份底稿）：AI 生成内容必带标识+不可关闭免责+as_of；荐股=证券投资咨询红线（用例含红线词扫描）。

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  guard,
  tid,
  instrumentPath,
  openStockPage,
  waitForSettled,
  seedAuth,
  ROOT,
} from '../lib/harness.js';
import { AI_AS_OF, loadAiFixture, installAiCardMocks, hopHint } from '../lib/ai-mock.js';

// ---------------------------------------------------------------------------
// 判据常量
// ---------------------------------------------------------------------------
const MIN_FONT_PX = 13; // 视觉规格 N4
const MIN_CONTRAST = 4.5; // 视觉规格 N5
const EVIDENCE_DIR = path.join(ROOT, 'tests', 'e2e', 'evidence', 'ai-card-2026-11-06');

// §6.2 computed-style testid 选择器（规格明文清单）
const SPEC_TESTID_NAMES = [
  'aiGeneratedBadge',
  'aiDisclaimer',
  'disclaimer',
  'disclaimerText',
  'disclaimerVersion',
  'quoteAsOf',
  'aiAsOf',
];

// §6.1.4 源码级类选择器（规格明文清单，不允许测试自造）
const SPEC_CLASS_SELECTORS = [
  '.ai-badge',
  '.ai-disclaimer',
  '.disclaimer__heading',
  '.disclaimer__text',
  '.disclaimer__meta',
  '.quote__meta dt',
  '.quote__meta dd',
  '.ai-context__item dt',
  '.ai-context__item dd',
];

// 荐股红线词（A7 身份底稿：荐股=证券投资咨询红线）。出现在 AI 生成块内即红线。
const ADvisorySource = [
  '推荐买入', '推荐卖出', '建议买入', '建议卖出', '建议加仓', '建议减仓', '建议清仓',
  '目标价', '止损位', '止损价', '止盈位', '止盈价', '稳赚', '包赚', '必涨', '必跌',
  '翻倍', '收益承诺', '收益保证', '零风险', '无风险', '满仓', '抄底', '逃顶',
];
const ADVISORY_RE = new RegExp(ADvisorySource.join('|'));

const DISCLAIMER_SENTINEL = loadAiFixture('analysis-valid.json').meta.disclaimer.text;
const AS_OF_VARIANTS = ['missing', 'invalid', 'empty']; // AI2-2 三个对抗场景
const VARIANT_RAW_AS_OF = {
  valid: AI_AS_OF,
  missing: undefined,
  invalid: 'not-a-date',
  empty: '',
};

function writeEvidence(name, data) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, name);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

// ---------------------------------------------------------------------------
// DOM 扫描器（page.evaluate 内运行）
// ---------------------------------------------------------------------------
const SCAN_IDS = {
  badge: tid('aiGeneratedBadge'),
  disclaimer: tid('aiDisclaimer'),
  aiAsOf: tid('aiAsOf'),
  quoteAsOf: tid('quoteAsOf'),
  aiRoot: tid('aiInterpretation'),
  quotePrice: tid('quotePrice'),
  quoteChange: tid('quoteChange'),
};

/**
 * AI 卡三节点扫描（AI2-2）：
 *   badge=ai-generated-badge，disclaimer=ai-disclaimer，numeric=数值节点（AI 区内数字/占位文本渲染）。
 *   blocks=每个 badge 所在生成块的 {asOfTexts, numeric, hasDisclaimer, text}（AI2-1b 细查）。
 *   pageNumeric=全页价格/数值节点（quotePrice/quoteChange/quote__meta dd/ai-context dd/ai-metric__value 有文本），
 *              仅在「页面应停止展示价格」的场景断言（apiGateway 承诺：缺免责/时点→停止展示价格）。
 */
async function scanAiCard(page) {
  return page.evaluate((ids) => {
    const byTestid = (id) => [...document.querySelectorAll(`[data-testid="${id}"]`)];
    const NUMERIC_LEAF = /^[-+]?[\d][\d,.]*\s*(?:%|％)?$/;
    const PLACEHOLDER = /^(?:0(?:\.0+)?|--?|—|–|null|undefined|NaN|N\/A)$/i;
    const NUMERIC_CLASS = /(?:^|[-_\s])(?:price|change|volume|amount|vol|pct|turnover|quote|metric|value|revenue|profit|roe|eps|margin)(?:$|[-_\s])/i;

    const numericLeaksIn = (scope) => {
      const leaks = [];
      for (const el of scope.querySelectorAll('*')) {
        const cls = typeof el.className === 'string' ? el.className : '';
        const text = (el.textContent ?? '').trim();
        const leafText = el.children.length === 0 ? text : '';
        const hit =
          (NUMERIC_CLASS.test(cls) && text !== '' && (/[0-9]/.test(text) || PLACEHOLDER.test(text)))
          || (leafText !== '' && (NUMERIC_LEAF.test(leafText) || PLACEHOLDER.test(leafText)));
        if (hit) {
          leaks.push({ cls: cls.slice(0, 60), text: text.slice(0, 40) });
        }
      }
      return leaks;
    };

    const aiRoot = byTestid(ids.aiRoot)[0] ?? null;
    const aiNumeric = aiRoot ? numericLeaksIn(aiRoot) : [];

    // 生成块：以 badge 为锚，向上找到同时含 ai-as-of 的最近祖先作为块根（不依赖未冻结的容器类名）。
    const blocks = byTestid(ids.badge).map((badge) => {
      let block = badge.parentElement;
      for (let i = 0; i < 5 && block && !block.querySelector(`[data-testid="${ids.aiAsOf}"]`); i += 1) {
        block = block.parentElement;
      }
      if (!block) return { asOfTexts: [], numeric: [], hasDisclaimer: false, label: '' };
      return {
        asOfTexts: [...block.querySelectorAll(`[data-testid="${ids.aiAsOf}"]`)].map((n) => (n.textContent ?? '').trim()),
        numeric: numericLeaksIn(block),
        hasDisclaimer: block.querySelector(`[data-testid="${ids.disclaimer}"]`) !== null,
        label: (badge.textContent ?? '').trim().slice(0, 60),
      };
    });

    // 全页价格/数值节点（已知数值展示位，避免把 TabBar 计数之类误伤）。
    const pageNumeric = [];
    const pageNumericSelector = [
      `[data-testid="${ids.quotePrice}"]`,
      `[data-testid="${ids.quoteChange}"]`,
      '.quote__meta dd',
      '.ai-context__item dd',
      '.ai-metric__value',
    ].join(',');
    for (const el of document.querySelectorAll(pageNumericSelector)) {
      const text = (el.textContent ?? '').trim();
      if (text !== '' && (/[0-9]/.test(text) || PLACEHOLDER.test(text))) {
        pageNumeric.push({ cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60), text: text.slice(0, 40) });
      }
    }

    return {
      badge: byTestid(ids.badge).length,
      disclaimer: byTestid(ids.disclaimer).length,
      aiAsOfTexts: byTestid(ids.aiAsOf).map((n) => (n.textContent ?? '').trim()),
      quoteAsOfTexts: byTestid(ids.quoteAsOf).map((n) => (n.textContent ?? '').trim()),
      aiNumeric,
      blocks,
      pageNumeric,
    };
  }, SCAN_IDS);
}

/**
 * 三节点缺席断言（AI2-2）：per-node-type verdict。
 *   BLOCKED = 合法 as_of 正对照下该类型渲染数为 0 → 缺席断言无意义（模型文本路径未接线），不空转绿。
 *   FAIL    = 该类型在对抗场景下仍渲染。
 *   PASS    = 正对照在渲染、对抗场景下缺席（真断言）。
 *
 * scope 作用域（A7 判定 2026-11-06，测试缺陷修正、判据不变）：
 *   'market'（默认）= 行情 source.asOf 驱动的展示域（AI 区数值 + 页面 ai-as-of + 随卡 badge/disclaimer）。
 *   'block'         = AI 响应 as_of 驱动的生成块域（badge/disclaimer/块内数值/块内 ai-as-of）。
 *   依据：页面 ai-as-of 恒=行情 source.asOf（AiInterpretation.tsx:127 `<time dateTime={source.asOf} data-testid=ai-as-of>`），
 *   AI 响应 as_of 只管生成块（AiGeneratedContent.asOf）。2B 变体的是 AI 响应 as_of，若把 market 驱动的
 *   AI 区数值/页面 ai-as-of 纳入断言域，会把「合法 market as_of 下的正常渲染」误判红——断言域必须跟驱动源对齐。
 *   2A（market 变体）覆盖 market 域；2B（AI 响应变体）只断言 block 域，market 域渲染记观察项。
 *   签发判据一致性：AI2-1「每生成块带 ai-as-of（值原样=source.asOf）」与 N3「与响应 as_of 逐字相等」要求
 *   source.asOf==data.as_of，一致性由契约侧（A3）保证；E2E 侧两域分别覆盖。
 */
function fmtRawAsOf(v) {
  return v === undefined ? '<ABSENT>' : v === '' ? '<EMPTY>' : v;
}

function verdictsOf({ baseline, actual, rawAsOf, label, scope = 'market' }) {
  const verdicts = [];
  const blockNumericCount = (scan) => scan.blocks.reduce((n, b) => n + b.numeric.length, 0);
  const blockAsOfCount = (scan) => scan.blocks.filter((b) => b.asOfTexts.length > 0).length;
  const types = scope === 'block'
    ? [
        { type: 'ai-generated-badge', base: baseline.badge, now: actual.badge, sample: null },
        { type: 'ai-disclaimer', base: baseline.disclaimer, now: actual.disclaimer, sample: null },
        { type: '生成块内数值', base: blockNumericCount(baseline), now: blockNumericCount(actual), sample: actual.blocks.flatMap((b) => b.numeric).slice(0, 3) },
        { type: '生成块 ai-as-of', base: blockAsOfCount(baseline), now: blockAsOfCount(actual), sample: actual.blocks.flatMap((b) => b.asOfTexts).slice(0, 3) },
      ]
    : [
        { type: 'ai-generated-badge', base: baseline.badge, now: actual.badge, sample: null },
        { type: 'ai-disclaimer', base: baseline.disclaimer, now: actual.disclaimer, sample: null },
        { type: '数值节点(AI区)', base: baseline.aiNumeric.length, now: actual.aiNumeric.length, sample: actual.aiNumeric.slice(0, 3) },
        { type: '生成块内数值', base: blockNumericCount(baseline), now: blockNumericCount(actual), sample: actual.blocks.flatMap((b) => b.numeric).slice(0, 3) },
      ];
  for (const { type, base, now, sample } of types) {
    if (base === 0) {
      verdicts.push({ type, status: 'BLOCKED', reason: `合法 as_of 正对照下「${type}」渲染数=0（模型文本路径未接线），缺席断言无意义` });
    } else if (now === 0) {
      verdicts.push({ type, status: 'PASS' });
    } else {
      verdicts.push({ type, status: 'FAIL', detail: `${label}：「${type}」应不渲染，实际 ${now} 处（含 ${JSON.stringify(sample)}）` });
    }
  }
  // ai-as-of 反伪造子规则（N3：缺失→不渲染；无效/空串→不渲染或严格原样，禁止换算/格式化/兜底）。
  const texts = scope === 'block' ? actual.blocks.flatMap((b) => b.asOfTexts) : actual.aiAsOfTexts;
  const baseTexts = scope === 'block' ? baseline.blocks.flatMap((b) => b.asOfTexts) : baseline.aiAsOfTexts;
  const type = scope === 'block' ? 'ai-as-of(生成块)' : 'ai-as-of';
  const strictOk = rawAsOf === undefined
    ? texts.length === 0
    : texts.length === 0 || texts.every((t) => t === rawAsOf);
  if (baseTexts.length === 0) {
    verdicts.push({ type, status: 'BLOCKED', reason: `正对照下 ${type} 未渲染，缺席断言无意义` });
  } else if (strictOk) {
    verdicts.push({ type, status: 'PASS' });
  } else {
    verdicts.push({ type, status: 'FAIL', detail: `${label}：${type} 应不渲染或严格原样「${fmtRawAsOf(rawAsOf)}」，实际 ${JSON.stringify(texts)}（换算/格式化/兜底即违规，N3）` });
  }
  return verdicts;
}

async function triNodeAbsentTest({ page, marketAsOf, aiFixture, requestLog, rawAsOf, label, scope = 'market' }) {
  // 页面错误采集（hop 定位硬要求：失败必须能指到「哪一跳坏了」）。
  const errors = [];
  const watchErrors = (p, tag) => {
    p.on('pageerror', (e) => errors.push(`${tag} pageerror: ${String(e.message).slice(0, 200)}`));
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${tag} console.error: ${m.text().slice(0, 200)}`);
    });
    return p.addInitScript(() => {
      window.__unhandledRejections = [];
      window.addEventListener('unhandledrejection', (e) => {
        window.__unhandledRejections.push(String((e.reason && e.reason.stack) || e.reason).slice(0, 300));
      });
    });
  };

  // 正对照：同套 mock 在合法 as_of 下的渲染基线（缺席断言的有意义性依据）。
  const probe = await page.context().newPage();
  let baseline;
  try {
    await watchErrors(probe, '[probe合法]');
    await installAiCardMocks(probe, { marketAsOf: 'valid', aiFixture: loadAiFixture('analysis-valid.json') });
    await openStockPage(probe);
    try {
      await waitForSettled(probe);
    } catch (e) {
      throw new Error(`正对照页未达稳态（E2E 环境/基座问题，判 FAIL 不判 skip）：${String(e.message).slice(0, 160)}`);
    }
    baseline = await scanAiCard(probe);
  } finally {
    await probe.close();
  }

  await watchErrors(page, '[对抗场景]');
  await installAiCardMocks(page, { marketAsOf, aiFixture, requestLog });
  await openStockPage(page);
  let actual = null;
  let settleFailure = null;
  try {
    await waitForSettled(page);
    actual = await scanAiCard(page);
  } catch (e) {
    settleFailure = String(e.message).slice(0, 200);
    errors.push(...(await page.evaluate(() => window.__unhandledRejections ?? [])));
  }

  if (settleFailure !== null) {
    // 页面悬挂/未稳态本身即红：apiGateway 承诺「缺免责/时点→kind:'error' 降级」，悬挂=降级链路断（AI2-2 断言在其上无法执行）。
    const detail = `${label}：页面未达稳态（${settleFailure}）——AI 卡三节点缺席断言无法执行；页面停在加载/中间态而非降级错误态即违反 fail-closed 承诺（apiGateway.ts:261 注释「缺免责/时点→返回 kind:'error'」）。运行时错误：${errors.join('；') || '（无）'}`;
    writeEvidence(`tri-node-${label}.json`, { label, scope, rawAsOf: fmtRawAsOf(rawAsOf), baseline, actual: null, pageErrors: errors, verdicts: [{ type: '页面稳态', status: 'FAIL', detail }] });
    test.info().annotations.push({ type: '三节点·页面稳态', description: detail });
    expect(settleFailure, detail).toBe(null);
  }

  const verdicts = verdictsOf({ baseline, actual, rawAsOf, label, scope });
  const observations = scope === 'block'
    ? {
        note: '以下节点由行情 source.asOf 驱动（AiInterpretation.tsx:127），不在 AI 响应 as_of 变体断言域（E2E-AI2-2A 覆盖）；2B 中 marketAsOf=valid，合法渲染属预期。',
        aiNumericCount: actual.aiNumeric.length,
        pageAiAsOf: actual.aiAsOfTexts,
        pageNumericCount: actual.pageNumeric.length,
      }
    : undefined;
  for (const v of verdicts) {
    test.info().annotations.push({
      type: `三节点·${v.type}`,
      description: v.status === 'PASS' ? 'PASS' : v.status === 'BLOCKED' ? `BLOCKED（${v.reason}）` : v.detail,
    });
  }
  writeEvidence(`tri-node-${label}.json`, { label, scope, rawAsOf: fmtRawAsOf(rawAsOf), baseline, actual, verdicts, observations });

  const failed = verdicts.filter((v) => v.status === 'FAIL');
  expect(failed.map((f) => f.detail), `${label}：AI 卡三节点 fail-closed\n${hopHint(requestLog)}`).toEqual([]);

  const passed = verdicts.filter((v) => v.status === 'PASS');
  if (passed.length === 0) {
    test.skip(true, `BLOCKED：正对照未渲染任何可断言节点类型，缺席断言无意义（详见 annotations/evidence）。${hopHint(requestLog)}`);
  }
  return { baseline, actual, verdicts };
}

// ---------------------------------------------------------------------------
// computed-style 测量（视觉规格 §6）
// ---------------------------------------------------------------------------
const SPEC_SELECTORS = [
  ...SPEC_TESTID_NAMES.map((n) => ({ selector: `[data-testid="${tid(n)}"]`, source: `visual-spec §6.2 [data-testid=${tid(n)}]` })),
  ...SPEC_CLASS_SELECTORS.map((s) => ({ selector: s, source: `visual-spec §6.1.4 ${s}` })),
];

async function measureComputedStyles(page) {
  return page.evaluate((selectors) => {
    const parseRGB = (str) => {
      const m = String(str).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const blend = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const luminance = ({ r, g, b }) => {
      const f = (c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const contrastRatio = (fg, bg) => {
      const l1 = luminance(fg); const l2 = luminance(bg);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const resolveTokenColor = (token) => {
      const probeEl = document.createElement('span');
      probeEl.style.color = `var(${token})`;
      document.body.appendChild(probeEl);
      const c = getComputedStyle(probeEl).color;
      probeEl.remove();
      return c;
    };
    const effectiveBg = (el) => {
      const layers = [];
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const bg = parseRGB(getComputedStyle(n).backgroundColor);
        if (bg && bg.a > 0) {
          if (bg.a >= 1) return layers.reduceRight((acc, layer) => blend(layer, acc), bg);
          layers.push(bg);
        }
      }
      const base = parseRGB(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 };
      return layers.reduceRight((acc, layer) => blend(layer, acc), { ...base, a: 1 });
    };

    const allowedColors = [resolveTokenColor('--text'), resolveTokenColor('--text-muted')];
    const tokens = {
      text: resolveTokenColor('--text'),
      textMuted: resolveTokenColor('--text-muted'),
      bg: resolveTokenColor('--bg'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };

    const records = [];
    for (const { selector, source } of selectors) {
      const nodes = [...document.querySelectorAll(selector)];
      if (nodes.length === 0) {
        records.push({ selector, source, present: false });
        continue;
      }
      nodes.forEach((el, index) => {
        const cs = getComputedStyle(el);
        let ariaHidden = el.getAttribute('aria-hidden') === 'true';
        let ancestorOpacity = '1';
        for (let p = el.parentElement; p; p = p.parentElement) {
          if (p.getAttribute('aria-hidden') === 'true') ariaHidden = true;
          if (getComputedStyle(p).opacity !== '1' && ancestorOpacity === '1') {
            ancestorOpacity = getComputedStyle(p).opacity;
          }
        }
        const color = cs.color;
        const bgRGB = effectiveBg(el);
        const fgRGB = parseRGB(color);
        records.push({
          selector,
          source,
          index,
          present: true,
          text: (el.textContent ?? '').trim().slice(0, 40),
          rendered: cs.display !== 'none' && cs.visibility !== 'hidden',
          fontSize: cs.fontSize,
          fontSizePx: parseFloat(cs.fontSize),
          opacity: cs.opacity,
          ancestorOpacity,
          color,
          colorAllowed: allowedColors.includes(color),
          bg: `rgb(${Math.round(bgRGB.r)}, ${Math.round(bgRGB.g)}, ${Math.round(bgRGB.b)})`,
          contrast: fgRGB ? Math.round(contrastRatio(fgRGB, bgRGB) * 100) / 100 : null,
          ariaHidden,
          animationName: cs.animationName,
        });
      });
    }

    // N1：免责不可关闭/折叠/隐藏/延迟（DOM 层面可查部分）。
    const disclaimerCloseCount = document.querySelectorAll('[data-testid="disclaimer-close"]').length;
    const n1 = [];
    for (const el of document.querySelectorAll('.ai-disclaimer, [data-testid="disclaimer"], [data-testid="ai-disclaimer"], .disclaimer')) {
      const issues = [];
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (n.hasAttribute('hidden') || n.matches('[hidden]')) issues.push('self/ancestor [hidden]');
        if (cs.display === 'none') issues.push('self/ancestor display:none');
        if (cs.visibility === 'hidden') issues.push('self/ancestor visibility:hidden');
        if (n.tagName === 'DETAILS') issues.push('ancestor <details>（可折叠）');
        if (n.hasAttribute('aria-expanded')) issues.push('ancestor [aria-expanded]（可折叠开关）');
        if (n.hasAttribute('aria-controls')) issues.push('ancestor [aria-controls]（可关闭控件关联）');
      }
      if (issues.length) {
        n1.push({ text: (el.textContent ?? '').trim().slice(0, 40), issues: [...new Set(issues)] });
      }
    }

    return { tokens, allowedColors, records, disclaimerCloseCount, n1 };
  }, SPEC_SELECTORS);
}

function styleViolationsOf(measured) {
  const violations = [];
  for (const rec of measured.records) {
    if (!rec.present || !rec.rendered) continue; // 缺席 → GAP（由 AI-2 红项覆盖）；不渲染 → N1 单独管
    const v = [];
    if (rec.fontSizePx < MIN_FONT_PX) v.push(`font-size ${rec.fontSize} < 13px（N4）`);
    if (rec.opacity !== '1') v.push(`opacity=${rec.opacity} ≠ 1（N5）`);
    if (rec.ancestorOpacity !== '1') v.push(`祖先 opacity=${rec.ancestorOpacity} ≠ 1（N5 整链可见）`);
    if (rec.ariaHidden) v.push('自身/祖先 aria-hidden=true（N5 文本节点不得隐藏）');
    if (!rec.colorAllowed) v.push(`color=${rec.color} 不在 {--text,--text-muted} 解析值 ${JSON.stringify(measured.allowedColors)}（§6.2）`);
    if (rec.contrast !== null && rec.contrast < MIN_CONTRAST) v.push(`对比度 ${rec.contrast}:1 < 4.5:1（N5，bg=${rec.bg}）`);
    if (rec.animationName !== 'none') v.push(`animation-name=${rec.animationName}（N5 无动画）`);
    if (v.length) violations.push({ selector: rec.selector, source: rec.source, text: rec.text, issues: v });
  }
  if (measured.disclaimerCloseCount > 0) {
    violations.push({ selector: '[data-testid=disclaimer-close]', source: 'visual-spec N1', issues: [`存在 ${measured.disclaimerCloseCount} 个免责声明关闭入口（N1 不可关闭）`] });
  }
  for (const n1 of measured.n1) {
    violations.push({ selector: '.disclaimer 族', source: 'visual-spec N1', text: n1.text, issues: n1.issues });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// AI-2：ai-as-of / 生成块 / 三节点 fail-closed
// ---------------------------------------------------------------------------
test.describe('E2E-AI2 [hop:web+contract] AI 卡 as_of 合规（AI2-1/2/3）', () => {
  test('E2E-AI2-1a [hop:web] AiInterpretation ai-as-of：值原样严格 = source.asOf（含 +08:00），dateTime 同值', async ({ page }) => {
    guard(test);
    const requestLog = await installAiCardMocks(page, { marketAsOf: 'valid', aiFixture: loadAiFixture('analysis-valid.json') });
    await openStockPage(page);
    await waitForSettled(page);

    const aiRoot = page.getByTestId(tid('aiInterpretation'));
    await expect(aiRoot, 'AI 解读区应渲染（行情三件套 mock 已就绪）').toBeVisible({ timeout: 15000 });

    const asOfNodes = page.getByTestId(tid('aiAsOf'));
    const count = await asOfNodes.count();
    expect(count, `ai-as-of 节点缺失（${hopHint(requestLog)}）`).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const node = asOfNodes.nth(i);
      const text = (await node.textContent()).trim();
      expect(text, `ai-as-of 第 ${i + 1} 个节点 textContent 必须逐字 = source.asOf（N3 原样，含 +08:00；换算/格式化/兜底即违规）`).toBe(AI_AS_OF);
      const dt = await node.getAttribute('datetime');
      expect(dt, `ai-as-of 第 ${i + 1} 个节点 <time dateTime> 必须 = source.asOf 原值`).toBe(AI_AS_OF);
    }

    // N3 双节点：quote-as-of 同规则。
    const quoteAsOf = page.getByTestId(tid('quoteAsOf'));
    const qCount = await quoteAsOf.count();
    for (let i = 0; i < qCount; i += 1) {
      const text = (await quoteAsOf.nth(i).textContent()).trim();
      expect(text, `quote-as-of 第 ${i + 1} 个节点必须逐字 = source.asOf（N3）`).toBe(AI_AS_OF);
    }
  });

  test('E2E-AI2-1b [hop:web+contract] 模型文本生成块正对照：每块 badge+disclaimer+ai-as-of 齐、文案=服务端哨兵（N2/N3/N6）+无荐股红线词', async ({ page }) => {
    guard(test);
    const requestLog = [];
    await installAiCardMocks(page, { marketAsOf: 'valid', aiFixture: loadAiFixture('analysis-valid.json'), requestLog });
    await openStockPage(page);
    await waitForSettled(page);

    const badges = page.getByTestId(tid('aiGeneratedBadge'));
    const badgeCount = await badges.count();
    expect(badgeCount, `模型文本生成块应渲染 badge（正对照，AI2-1）\n${hopHint(requestLog)}`).toBeGreaterThan(0);

    const disclaimerCount = await page.getByTestId(tid('aiDisclaimer')).count();
    expect(disclaimerCount, `badge 数（${badgeCount}）应 = ai-disclaimer 数（N2 标识与免责同块）\n${hopHint(requestLog)}`).toBe(badgeCount);

    // 每块细查：ai-as-of 严格值、免责哨兵文案（N6 零硬编码 fallback）、badge DOM 序在前（N2 标识在文本上方）。
    for (let i = 0; i < badgeCount; i += 1) {
      const block = await badges.nth(i).evaluate((badge, ids) => {
        let root = badge.parentElement;
        for (let k = 0; k < 5 && root && !root.querySelector(`[data-testid="${ids.aiAsOf}"]`); k += 1) root = root.parentElement;
        if (!root) return { found: false };
        const asOf = [...root.querySelectorAll(`[data-testid="${ids.aiAsOf}"]`)].map((n) => (n.textContent ?? '').trim());
        const dis = root.querySelector(`[data-testid="${ids.disclaimer}"]`);
        const order = root.querySelector(`[data-testid="${ids.aiAsOf}"]`);
        return {
          found: true,
          asOf,
          disclaimer: dis ? (dis.textContent ?? '').trim() : null,
          badgeBeforeAsOf: order ? !!(badge.compareDocumentPosition(order) & Node.DOCUMENT_POSITION_FOLLOWING) : false,
          label: (badge.textContent ?? '').trim(),
          blockText: (root.textContent ?? '').trim(),
        };
      }, SCAN_IDS);

      expect(block.found, `第 ${i + 1} 个生成块：badge 所在块必须含 ai-as-of（AI2-1 每生成块带 as_of）\n${hopHint(requestLog)}`).toBe(true);
      for (const t of block.asOf) {
        expect(t, `第 ${i + 1} 个生成块 ai-as-of 必须逐字 = data.as_of（N3）`).toBe(AI_AS_OF);
      }
      expect(block.asOf.length, `第 ${i + 1} 个生成块 ai-as-of 数量 ≥1`).toBeGreaterThan(0);
      expect(block.disclaimer, `第 ${i + 1} 个生成块免责文案必须逐字 = 服务端 meta.disclaimer.text 哨兵（N6 禁硬编码 fallback）`).toBe(DISCLAIMER_SENTINEL);
      expect(block.label, `第 ${i + 1} 个生成块标识文本非空（N2）`).not.toBe('');
      expect(block.label, `第 ${i + 1} 个生成块标识不得为「待接入」占位`).not.toContain('待接入');
      expect(block.badgeBeforeAsOf, `第 ${i + 1} 个生成块：badge 应在 as_of 之前（N2 标识在文本上方，DOM 序代理）`).toBe(true);
    }

    // 荐股红线扫描（A7 红线：荐股=证券投资咨询红线）。
    const aiText = (await aiRootText(page)) ?? '';
    const hit = aiText.match(ADVISORY_RE);
    expect(hit, `AI 生成内容出现荐股红线词 ${JSON.stringify(hit && hit[0])}（红线：证券投资咨询）`).toBeNull();

    // /ai 页模型文本路径同步检查（AI2-1 双路径之一）；今日骨架 → 记 GAP 不空转绿。
    await seedAuth(page);
    await page.goto('/ai', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid]', { state: 'attached', timeout: 10000 }).catch(() => {});
    const aiPageBadges = await page.getByTestId(tid('aiGeneratedBadge')).count();
    test.info().annotations.push({ type: 'GAP', description: `/ai 页生成块 badge 数=${aiPageBadges}（0 = AiHomePage 模型文本路径未接线，AI2-1 双路径缺 /ai 页一条；A6 web/h5 写域）` });
    if (aiPageBadges === 0 && badgeCount === 0) {
      test.skip(true, `BLOCKED：/ai 页与 AiInterpretation 模型文本路径均未渲染生成块，正对照不成立\n${hopHint(requestLog)}`);
    }
  });

  for (const variant of AS_OF_VARIANTS) {
    test(`E2E-AI2-2A [hop:web+contract] 行情 as_of ${variant}：AI 卡三节点 fail-closed`, async ({ page }) => {
      guard(test);
      const requestLog = [];
      const { actual } = await triNodeAbsentTest({
        page,
        marketAsOf: variant,
        aiFixture: loadAiFixture('analysis-valid.json'),
        requestLog,
        rawAsOf: VARIANT_RAW_AS_OF[variant],
        label: `market-as-of-${variant}`,
      });

      // 缺失/空串：apiGateway 自身承诺「页面停止展示价格」→ 全页价格数值节点缺席（实现承诺，非越权判据）。
      if (variant !== 'invalid') {
        expect(actual.pageNumeric, `as_of ${variant}：页面应停止展示价格（apiGateway fail-closed 承诺），实际数值节点 ${JSON.stringify(actual.pageNumeric)}`).toEqual([]);
      } else {
        test.info().annotations.push({
          type: '观察（非本判据）',
          description: `invalid as_of 下全页价格数值节点 ${JSON.stringify(actual.pageNumeric.slice(0, 3))}（apiGateway 只 trim 校验空串不校验 ISO 合法性；报价区是否 fail-closed 属 P0 策略缺口，报 lead 裁决）`,
        });
      }
    });
  }

  for (const variant of AS_OF_VARIANTS) {
    test(`E2E-AI2-2B [hop:web+contract] AI 响应 as_of ${variant}：生成块三节点 fail-closed`, async ({ page }) => {
      guard(test);
      const requestLog = [];
      const fixture = loadAiFixture(`analysis-${variant === 'missing' ? 'no' : variant}-as-of.json`);
      await triNodeAbsentTest({
        page,
        marketAsOf: 'valid',
        aiFixture: fixture,
        requestLog,
        rawAsOf: VARIANT_RAW_AS_OF[variant],
        label: `ai-response-as-of-${variant}`,
        // AI 响应 as_of 变体只驱动生成块域（badge/disclaimer/块内数值/块内 ai-as-of）；
        // market 驱动域（AI 区数值/页面 ai-as-of）由 2A 覆盖，见 verdictsOf scope 注释。
        scope: 'block',
      });
    });
  }
});

async function aiRootText(page) {
  return page.getByTestId(tid('aiInterpretation')).allInnerTexts().then((arr) => arr.join('\n'));
}

// ---------------------------------------------------------------------------
// AI3-1：computed-style 390×844 浅+深（N4/N5/§6.2/§6.1.4）+ N1
// ---------------------------------------------------------------------------
test.describe('E2E-AI3 [hop:web] 视觉规格 v1.0 §6 全条目（AI3-1/2）', () => {
  test('E2E-AI3-1 [hop:web] computed-style 390×844 浅+深：字号≥13px/opacity=1/对比≥4.5:1/颜色允许集/无动画/无 aria-hidden（N4/N5）+免责不可关闭（N1）', async ({ page }) => {
    guard(test);
    const viewport = page.viewportSize();
    expect(viewport, '视觉规格固定 390×844（playwright.config.js viewport）').toEqual({ width: 390, height: 844 });

    await installAiCardMocks(page, { marketAsOf: 'valid', aiFixture: loadAiFixture('analysis-valid.json') });

    const allViolations = [];
    const themeResults = {};
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      await openStockPage(page);
      await waitForSettled(page);
      const measured = await measureComputedStyles(page);
      const violations = styleViolationsOf(measured);
      const gaps = measured.records.filter((r) => !r.present).map((r) => `${r.selector}（${r.source}）`);
      themeResults[theme] = { tokens: measured.tokens, violations, gaps };
      writeEvidence(`computed-styles-${theme}.json`, {
        theme,
        viewport,
        generatedAt: new Date().toISOString(),
        tokens: measured.tokens,
        allowedColors: measured.allowedColors,
        records: measured.records,
        violations,
        gaps,
        disclaimerCloseCount: measured.disclaimerCloseCount,
        n1: measured.n1,
      });
      test.info().annotations.push({ type: `GAP·${theme}`, description: `缺席选择器（由 AI-2 红项覆盖）：${gaps.join(' ; ') || '无'}` });
      for (const v of violations) {
        test.info().annotations.push({ type: `违规·${theme}`, description: `${v.selector} → ${v.issues.join(' ; ')}` });
      }
      allViolations.push(...violations.map((v) => ({ theme, ...v })));
    }

    // 主题 sanity：深浅主题解析值确实不同（防止 emulateMedia 失效导致深色=浅色假绿）。
    expect(themeResults.light.tokens.bg, '主题 sanity：--bg 解析值应随 colorScheme 变化').not.toBe(themeResults.dark.tokens.bg);

    expect(
      allViolations.map((v) => `[${v.theme}] ${v.selector}(${v.text}) → ${v.issues.join(' ; ')}`),
      'computed-style 违规（证据 JSON：tests/e2e/evidence/ai-card-2026-11-06/computed-styles-{light,dark}.json）',
    ).toEqual([]);
  });

  test('E2E-AI3-2A [hop:web] 复制/导出/分享 affordance 扫描：无「复制正文」入口（AI3-2 反向证据）', async ({ page }) => {
    guard(test);
    await installAiCardMocks(page, { marketAsOf: 'valid', aiFixture: loadAiFixture('analysis-valid.json') });
    await openStockPage(page);
    await waitForSettled(page);
    const stockCandidates = await scanCopyAffordances(page);

    await seedAuth(page);
    await page.goto('/ai', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid]', { state: 'attached', timeout: 10000 }).catch(() => {});
    const aiCandidates = await scanCopyAffordances(page);

    writeEvidence('copy-export-scan.json', { generatedAt: new Date().toISOString(), stockCandidates, aiCandidates });
    const hard = [...stockCandidates, ...aiCandidates].filter((c) => c.hard);
    expect(hard, '出现「复制正文/复制全文」类入口（AI3-2：无三件套能力期间不得有复制正文入口）').toEqual([]);
  });

  test('E2E-AI3-2B [hop:web] 复制/导出负载必须携带 label+disclaimer+as_of 三件套（无入口时按 AI3-2 反向口径通过）', async ({ page }) => {
    guard(test);
    await page.context().addInitScript(installClipboardSpy);
    await installAiCardMocks(page, { marketAsOf: 'valid', aiFixture: loadAiFixture('analysis-valid.json') });
    await openStockPage(page);
    await waitForSettled(page);
    const stockCandidates = await scanCopyAffordances(page);

    await seedAuth(page);
    await page.goto('/ai', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid]', { state: 'attached', timeout: 10000 }).catch(() => {});
    const candidates = [...stockCandidates, ...(await scanCopyAffordances(page))];

    if (candidates.length === 0) {
      writeEvidence('copy-export-trio.json', { generatedAt: new Date().toISOString(), candidates: [], verdict: '无任何复制/导出/分享 affordance → AI3-2 反向证据通过（无只复制正文能力）' });
      test.info().annotations.push({ type: '反向证据', description: '全站无复制/导出/分享 affordance，AI3-2「无入口」分支通过' });
      return;
    }

    // 有入口：必须携带三件套（标识 label + 免责 disclaimer + as_of）。
    const label = (await page.getByTestId(tid('aiGeneratedBadge')).first().allInnerTexts().catch(() => []))?.join(' ') ?? '';
    const disclaimerText = DISCLAIMER_SENTINEL;
    for (const c of candidates.slice(0, 3)) {
      await page.locator(`[data-testid="${c.testid}"]`).first().click({ timeout: 3000 }).catch(async () => {
        await page.getByRole(c.tag === 'a' ? 'link' : 'button', { name: c.label.slice(0, 30) }).first().click({ timeout: 3000 }).catch(() => {});
      });
    }
    const writes = await page.evaluate(() => window.__clipboardWrites ?? []);
    writeEvidence('copy-export-trio.json', { generatedAt: new Date().toISOString(), candidates, writes });
    for (const w of writes) {
      expect(w, `复制/导出负载必须携带 as_of 三件套之 as_of（AI3-2）：${String(w).slice(0, 120)}`).toContain(AI_AS_OF);
      expect(w, `复制/导出负载必须携带免责 disclaimer（AI3-2）`).toContain(disclaimerText);
      if (label.trim()) {
        expect(w, `复制/导出负载必须携带标识 label（AI3-2）`).toContain(label.trim().slice(0, 10));
      }
    }
    expect(writes.length, `有复制/导出入口（${candidates.map((c) => c.label).join(' ; ')}）但未捕获任何剪贴板写入`).toBeGreaterThan(0);
  });
});

async function scanCopyAffordances(page) {
  return page.evaluate(() => {
    const re = /复制|拷贝|剪贴|导出|下载|分享|copy|export|download|share|clipboard/i;
    const hard = /复制正文|拷贝正文|复制全文|复制内容|copy\s*(正文|全文|内容|text|body)/i;
    const out = [];
    const sel = 'button, a[href], [role="button"], [role="link"], input[type="button"], input[type="submit"], [aria-label], [title], [onclick]';
    for (const el of document.querySelectorAll(sel)) {
      const label = [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent ?? '']
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (re.test(label)) {
        out.push({
          tag: el.tagName.toLowerCase(),
          label: label.slice(0, 80),
          hard: hard.test(label),
          testid: el.getAttribute('data-testid') ?? '',
        });
      }
    }
    return out;
  });
}

function installClipboardSpy() {
  window.__clipboardWrites = [];
  const rec = (text) => {
    try { window.__clipboardWrites.push(String(text)); } catch { /* ignore */ }
  };
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (t) => { rec(t); return Promise.resolve(); },
        write: (d) => { rec(JSON.stringify(d)); return Promise.resolve(); },
      },
    });
  } catch { /* ignore */ }
  document.addEventListener('copy', () => rec(`copy-event:${String(window.getSelection() ?? '')}`));
  try {
    const orig = document.execCommand ? document.execCommand.bind(document) : null;
    if (orig) {
      document.execCommand = (cmd, ...rest) => {
        if (String(cmd).toLowerCase() === 'copy') rec(`execCommand:${String(window.getSelection() ?? '')}`);
        return orig(cmd, ...rest);
      };
    }
  } catch { /* ignore */ }
}
