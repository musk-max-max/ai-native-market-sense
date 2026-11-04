#!/usr/bin/env node
/**
 * H4 11-12 #5 证据采集：fail-closed 页面「DOM 里到底有没有数字/占位」+ 页面文案快照。
 *
 * 只做采集，不做放行判定（判定在 collect_f1_dom_evidence.py；断言口径在 specs/p0-stock-page.spec.js
 * 的 assertNoNumericLeak，本脚本的扫描规则与它保持一致，避免出现两套口径）。
 *
 * 输入 env：
 *   EVIDENCE_WEB_URL   被测页面（默认 http://127.0.0.1:3001）
 *   EVIDENCE_OUT_DIR   输出目录（必填）
 *   EVIDENCE_LABEL     场景名（expired / unauthorized_config / ...）
 *   EVIDENCE_AUTH_KEY  localStorage key（默认 e2e_token）
 *   EVIDENCE_AUTH_VALUE localStorage value（默认 dev-token）
 *   EVIDENCE_INSTRUMENT 标的（默认 SSE:600519）
 *
 * 输出：
 *   <out>/page-<label>.png         全页截图
 *   <out>/page-<label>.html        DOM 快照
 *   <out>/dom-<label>.json         结构化观测（testid 列表、数字扫描结果、页面文案）
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const WEB = process.env.EVIDENCE_WEB_URL || 'http://127.0.0.1:3001';
const OUT = process.env.EVIDENCE_OUT_DIR;
const LABEL = process.env.EVIDENCE_LABEL || 'fail-closed';
const AUTH_KEY = process.env.EVIDENCE_AUTH_KEY || 'e2e_token';
const AUTH_VALUE = process.env.EVIDENCE_AUTH_VALUE || 'dev-token';
const INSTRUMENT = process.env.EVIDENCE_INSTRUMENT || 'SSE:600519';
// H4 #5 增补场景：403 但 Problem 结构不合法（无 title/detail）→ 页面必须是整页中性错误态，
// 不能只替换行情区（否则基本面数值仍会渲染）。注入点在浏览器网络层，真实 API 不变。
const MALFORMED_403 = process.env.EVIDENCE_MALFORMED_403 === '1';

if (!OUT) {
  console.error('缺少 EVIDENCE_OUT_DIR');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const NUMERIC_TEST_IDS = ['quotePrice', 'quoteChange'];
const PLACEHOLDER_TEXT = /^(?:0(?:\.0+)?|--?|—|–|null|undefined|NaN|N\/A)$/i;

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    baseURL: WEB,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  await context.addInitScript(([key, value]) => {
    window.localStorage.setItem(key, value);
  }, [AUTH_KEY, AUTH_VALUE]);
  const page = await context.newPage();
  if (MALFORMED_403) {
    await page.route('**/v1/instruments/*/quote*', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        // 结构不合法：缺 title/detail（只剩机器 code），页面不得据此自造受限文案。
        body: JSON.stringify({ type: 'about:blank', status: 403, code: 'ENTITLEMENT_RESTRICTED' }),
      }),
    );
  }
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const startedAt = new Date().toISOString();
  await page.goto(`/stocks/${encodeURIComponent(INSTRUMENT)}`, { waitUntil: 'networkidle', timeout: 30000 });
  // 只等「某一终态出现」：受限提示或错误横幅；不等价格（fail-closed 下不应有）。
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="entitlement-notice"]')
      || !!document.querySelector('[data-testid="error-banner"]'),
    { timeout: 15000 },
  ).catch(() => {});
  await page.waitForTimeout(300);

  const observed = await page.evaluate(({ ids, placeholderSource }) => {
    const placeholder = new RegExp(placeholderSource, 'i');
    const numericClass = /(?:^|[-_\s])(?:price|change|volume|amount|vol|pct|turnover|quote)(?:$|[-_\s])/i;
    const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}` +
      `.${typeof el.className === 'string' ? el.className.trim().replace(/\s+/g, '.') : ''}`;
    const leaks = [];
    const testids = [];
    const numericNodes = [];
    for (const el of document.querySelectorAll('[data-testid]')) {
      const id = el.getAttribute('data-testid');
      testids.push(id);
      if (!ids.includes(id)) continue;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      numericNodes.push({
        id,
        text: textOf(el),
        visible: rect.width > 0 && rect.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && Number(style.opacity) !== 0,
      });
      if (textOf(el) !== '') leaks.push(`数字 testid ${id} 带文本 ${JSON.stringify(textOf(el))}`);
    }
    for (const el of document.querySelectorAll('body *')) {
      const cls = typeof el.className === 'string' ? el.className : '';
      const text = textOf(el);
      if (numericClass.test(cls) && text !== '' && (/\d/.test(text) || placeholder.test(text))) {
        leaks.push(`数字类节点 ${describe(el)} text=${JSON.stringify(text)}`);
      }
      for (const pseudo of ['::before', '::after']) {
        const content = getComputedStyle(el, pseudo).content;
        if (content && content !== 'none' && content !== 'normal' && content !== '""' && /\d/.test(content)) {
          leaks.push(`伪元素数字 ${describe(el)}${pseudo} content=${content}`);
        }
      }
    }
    for (const el of document.querySelectorAll('[class*="skeleton" i], [class*="shimmer" i], [class*="placeholder" i], [aria-busy="true"]')) {
      leaks.push(`骨架屏/占位块 ${describe(el)}`);
    }
    const notice = document.querySelector('[data-testid="entitlement-notice"]');
    const disclaimer = document.querySelector('[data-testid="disclaimer"]');
    const bodyText = (document.body.innerText || '').replace(/\r\n/g, '\n');
    const count = (id) => document.querySelectorAll(`[data-testid="${id}"]`).length;
    return {
      counts: {
        quotePrice: count('quote-price'),
        quoteChange: count('quote-change'),
        quoteStaleBadge: count('quote-stale-badge'),
        entitlementNotice: count('entitlement-notice'),
        errorBanner: count('error-banner'),
        disclaimer: count('disclaimer'),
      },
      bodyFlags: {
        // 「元数据」会命中裸「元」字，按金额形状判定：数字紧邻元（如 1510.00 元 / 元1510）。
        hasYuanAmount: /[0-9][0-9,.]*\s*元/.test(bodyText) || /元\s*[0-9]/.test(bodyText),
        hasPercent: bodyText.includes('%'),
        hasHours: bodyText.includes('小时'),
      },
      url: location.href,
      title: document.title,
      testids: [...new Set(testids)].sort(),
      numericTestids: numericNodes,
      leaks: leaks.slice(0, 20),
      entitlementNotice: notice ? { text: textOf(notice), innerText: notice.innerText } : null,
      disclaimer: disclaimer ? { text: textOf(disclaimer) } : null,
      bodyText,
      skeletonPresent: document.querySelectorAll('[class*="skeleton" i], [class*="shimmer" i]').length,
    };
  }, { ids: NUMERIC_TEST_IDS, placeholderSource: PLACEHOLDER_TEXT.source });

  await page.screenshot({ path: path.join(OUT, `page-${LABEL}.png`), fullPage: true });
  fs.writeFileSync(path.join(OUT, `page-${LABEL}.html`), await page.content(), 'utf8');
  fs.writeFileSync(path.join(OUT, `dom-${LABEL}.json`), JSON.stringify({
    label: LABEL,
    web_url: WEB,
    instrument: INSTRUMENT,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    console_errors: consoleErrors,
    ...observed,
  }, null, 2), 'utf8');

  console.log(`[OK] ${LABEL}: leaks=${observed.leaks.length} notice=${observed.entitlementNotice ? 'yes' : 'NO'} `
    + `disclaimer=${observed.disclaimer ? 'yes' : 'NO'} skeleton=${observed.skeletonPresent}`);
  if (observed.leaks.length) console.log(JSON.stringify(observed.leaks, null, 2));
  if (!observed.entitlementNotice) console.log('[WARN] 页面没有 entitlement-notice');
} finally {
  await browser.close();
}
