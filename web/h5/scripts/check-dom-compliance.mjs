#!/usr/bin/env node
/* global console, process, URL, fetch, document, NodeFilter, Navigator */
/**
 * DOM 出口检查（生产构建 + Playwright，H3 m00870 / ADR D4/D5）。
 *
 * 断言：
 *  1) 页面文本不含内部标识/权限分层取值/渠道 ID/厂商名/内部错误码；
 *  2) 不存在 data-problem-code 等语义内码属性；任何属性值都不含内部码；
 *  3) 受限页面不出现 quote-price 数字；403 文案中性（不含法律定性/故障/不存在）；
 *  4) 页面上除服务端免责正文外，其余中文文案必须能在 copy 快照中找到（文案单一来源）。
 *
 * 用法：
 *   BASE_URL=http://127.0.0.1:3011 node scripts/check-dom-compliance.mjs
 *   （需要 tests/e2e 已安装 @playwright/test；不需要在 web/h5 里重复安装）
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { COPY_VERSION, copy } from '../src/lib/copy.ts';

const H5_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPO_DIR = join(H5_DIR, '..', '..');
const SNAPSHOT_DIR = join(REPO_DIR, 'docs', 'release', 'copy-snapshots');
const SNAPSHOT_FILES = readdirSync(SNAPSHOT_DIR).filter(
  (name) => name.startsWith(`${COPY_VERSION}.`) && name.endsWith('.frontend.json'),
);
if (SNAPSHOT_FILES.length !== 1) {
  console.error(`[dom] 本版本 frontend 快照应恰好 1 个，实际 ${SNAPSHOT_FILES.length} 个`);
  process.exit(1);
}
const SNAPSHOT_FILE = join(SNAPSHOT_DIR, SNAPSHOT_FILES[0]);

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3011';

const FORBIDDEN = [
  /\bF1\b/,
  /\bENTITLEMENT_RESTRICTED\b/,
  /\binternal_eval\b/,
  /\bc_end_display\b/,
  /\bplatform_user_data\b/,
  /\bresearch_only\b/,
  /\bsource_id\b/,
  /\bchannel\s*[=:]/,
  /\btier\b/,
  /tushare/i,
  /\bts_code\b/,
  /\bpct_chg\b/,
  /积分套餐/,
];

const requireFromE2E = createRequire(join(REPO_DIR, 'tests', 'e2e', 'package.json'));
let chromium;
try {
  ({ chromium } = requireFromE2E('@playwright/test'));
} catch (error) {
  console.error('[dom] 无法加载 tests/e2e 的 @playwright/test：', String(error));
  process.exit(2);
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
const snapshotText = snapshot.strings.join('\n');

function findForbidden(text) {
  const found = [];
  for (const pattern of FORBIDDEN) {
    const match = pattern.exec(text);
    if (match) found.push(`${pattern} → ${match[0]}`);
  }
  return found;
}

async function inspectPage(page, label, { requireStockPage = true } = {}) {
  const result = await page.evaluate(() => {
    const attrs = [];
    for (const element of document.querySelectorAll('*')) {
      for (const attr of element.attributes) {
        attrs.push(`${attr.name}=${attr.value}`);
      }
    }
    // 服务端数据（证券名/代码）与 <noscript> 不走 copy.ts：
    // 前者来自 API（展示时必须与契约一致），后者在 JS 未启用时无法读取 copy。
    // 403 notice 的文案来自服务端 copy.ts 的 Problem（H4 #5：前端不得自造），
    // 与证券名一样属于「API 数据」而非前端文案快照；其逐字一致性由下方受限断言单独校验。
    const DATA_NODES = [
      '[data-testid="disclaimer-text"]',
      '[data-testid="entitlement-notice"]',
      '[data-testid="stock-name"]',
      '[data-testid="stock-instrument-id"]',
      '.breadcrumb__current',
      'noscript',
    ];
    const isDataNode = (node) => {
      const parent = node.parentElement;
      return parent !== null && parent.closest(DATA_NODES.join(',')) !== null;
    };
    const textNodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (isDataNode(node)) continue;
      const text = (node.textContent ?? '').trim();
      if (text) textNodes.push(text);
    }
    return {
      bodyText: document.body.innerText,
      attrs,
      textNodes,
      problemCodeAttrs: attrs.filter((item) => item.startsWith('data-problem-code=')),
      notice: document.querySelector('[data-testid="entitlement-notice"]')?.innerText ?? null,
      price: document.querySelector('[data-testid="quote-price"]')?.innerText ?? null,
      errorBanner: document.querySelector('[data-testid="error-banner"]')?.innerText ?? null,
      stockPageCount: document.querySelectorAll('[data-testid="stock-page"]').length,
      disclaimerCount: document.querySelectorAll('[data-testid="disclaimer"]').length,
      disclaimerText:
        document.querySelector('[data-testid="disclaimer-text"]')?.innerText?.trim() ?? null,
    };
  });

  const failures = [];

  // 状态分支（loading/error/受限）必须与正常态共用同一个 stock-page testid；
  // 免责声明无论是常规模块还是「元数据缺失」兜底块，都必须能被同一个 disclaimer testid 取到。
  if (requireStockPage) {
    if (result.stockPageCount !== 1) {
      failures.push(`stock-page testid 应恰好 1 个（各状态共用），实际 ${result.stockPageCount}`);
    }
    // 正常态与受限 403 是「页面有内容」的两条路径，都必须能取到同一免责声明；
    // 429/断网等整页错误态不属于免责声明展示路径（页面不展示任何行情内容）。
    if (result.notice !== null || result.price !== null) {
      if (result.disclaimerCount !== 1) {
        failures.push(`disclaimer testid 应恰好 1 个（含兜底块），实际 ${result.disclaimerCount}`);
      }
      if (result.disclaimerText === null || result.disclaimerText.length === 0) {
        failures.push('disclaimer-text 为空，免责声明不可见或未接入 testid');
      }
    }
  }

  const bodyHits = findForbidden(result.bodyText);
  if (bodyHits.length) failures.push(`页面文本含内部标识：${bodyHits.join('; ')}`);

  if (result.problemCodeAttrs.length) {
    failures.push(`存在 data-problem-code 属性：${result.problemCodeAttrs.join('; ')}`);
  }
  const attrHits = findForbidden(result.attrs.join('\n'));
  if (attrHits.length) failures.push(`DOM 属性含内部标识：${attrHits.join('; ')}`);

  if (result.notice !== null) {
    if (result.price !== null && /\d/.test(result.price)) {
      failures.push(`受限页面出现价格数字：${result.price}`);
    }
    for (const banned of ['授权', '牌照', '未取得', '网络异常', '加载失败', '不存在', '退市']) {
      if (result.notice.includes(banned))
        failures.push(`403 文案含「${banned}」：${result.notice}`);
    }
    if (!result.notice.includes('暂不提供')) failures.push('403 文案缺少「暂不提供」事实陈述');
    if (result.bodyText.includes('重新加载'))
      failures.push('403 页面出现「重新加载」（不应暗示可恢复）');
  }

  if (result.errorBanner !== null) {
    for (const banned of ['授权', 'ENTITLEMENT']) {
      if (result.errorBanner.includes(banned)) failures.push(`错误提示含「${banned}」`);
    }
  }

  // 文案单一来源：除免责正文与接口数据（名称/日期/数值）外，中文文本应能在快照中找到。
  const externalHits = result.textNodes.filter(
    (text) =>
      /[\u4e00-\u9fff]/.test(text) &&
      !snapshotText.includes(text) &&
      !/^\d/.test(text) &&
      !/^[→←›★☆·]/.test(text),
  );
  if (externalHits.length) {
    failures.push(`以下中文文本不在 copy 快照中（可能硬编码）：${externalHits.join(' | ')}`);
  }

  if (failures.length) {
    console.error(`[dom] ${label} FAIL`);
    for (const failure of failures) console.error(`  - ${failure}`);
    return false;
  }
  console.log(`[dom] ${label} OK`);
  return true;
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = await context.newPage();
  let consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  let ok = true;
  try {
    await page.goto(`${BASE_URL}/stocks/SSE%3A600519`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="stock-page"]', { timeout: 10_000 });
    ok = (await inspectPage(page, 'normal')) && ok;

    // 受限矩阵：403 网络响应会让浏览器控制台记录一条 resource error，这是预期行为；
    // 仅允许该条，其他 console error 仍然算失败。
    consoleErrors = [];
    await page.goto(`${BASE_URL}/stocks/SSE%3A601398`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="entitlement-notice"]', { timeout: 10_000 });
    ok = (await inspectPage(page, 'restricted-403')) && ok;

    // H4 #5：notice 必须原样包含 API Problem 的 title + detail，去掉两段后不得剩任何文案。
    const problemResponse = await fetch(`${BASE_URL}/v1/instruments/SSE%3A601398/quote`);
    if (problemResponse.status !== 403) {
      console.error(`[dom] 受限场景预期 403，实际 ${problemResponse.status}`);
      ok = false;
    } else {
      const problem = await problemResponse.json();
      const expected = [problem.title, problem.detail]
        .filter((part) => typeof part === 'string' && part.trim().length > 0)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const actual = (await page.locator('[data-testid="entitlement-notice"]').innerText())
        .replace(/\s+/g, ' ')
        .trim();
      if (actual !== expected) {
        console.error(`[dom] 403 notice 与 API Problem 不一致：页面「${actual}」/ API「${expected}」`);
        ok = false;
      }
    }
    // H4：受限页没有数据，就不得出现任何时效文案（「滞后 X 小时」会暗示有数据只是旧的）。
    const restrictedStale = await page.locator('[data-testid="quote-stale-badge"]').count();
    const restrictedBody = await page.locator('[data-testid="stock-page"]').innerText();
    if (restrictedStale !== 0) {
      console.error('[dom] 受限页不应渲染 quote-stale-badge');
      ok = false;
    }
    const stalePrefix = copy.quote.stalePrefix.trim();
    if (restrictedBody.includes(stalePrefix) || /\d+\s*小时/.test(restrictedBody)) {
      console.error('[dom] 受限页出现时效/滞后时长文案');
      ok = false;
    }
    consoleErrors = consoleErrors.filter((text) => !/403/.test(text));

    // 403 结构异常（无合法 Problem body）：走中性整页错误态，不得回退成自造 notice、
    // 更不得出现任何数值或时效文案。
    await page.route('**/v1/instruments/*/quote*', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', status: 403, title: '' }),
      }),
    );
    await page.goto(`${BASE_URL}/stocks/SSE%3A600519`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="error-banner"]', { timeout: 10_000 });
    const malformedNotice = await page.locator('[data-testid="entitlement-notice"]').count();
    const malformedPrice = await page.locator('[data-testid="quote-price"]').count();
    const malformedStale = await page.locator('[data-testid="quote-stale-badge"]').count();
    if (malformedNotice !== 0 || malformedPrice !== 0 || malformedStale !== 0) {
      console.error('[dom] 403 结构异常页不应出现 notice/价格/时效节点');
      ok = false;
    }
    if (await page.locator('[data-testid="stock-page"]').count() !== 1) {
      console.error('[dom] 403 结构异常页缺少 stock-page');
      ok = false;
    }
    const malformedText = await page.locator('[data-testid="stock-page"]').innerText();
    if (/[元%]|\d+\s*小时/.test(malformedText)) {
      console.error('[dom] 403 结构异常页不得出现数值/时效（元/%/小时）');
      ok = false;
    }
    ok = (await inspectPage(page, 'restricted-malformed-403')) && ok;
    consoleErrors = consoleErrors.filter((text) => !/403/.test(text));
    await page.unroute('**/v1/instruments/*/quote*');

    // 429：只拦截 quote，instrument 正常 200，验证限流文案不暴露内部原因。
    consoleErrors = [];
    await page.route('**/v1/instruments/*/quote*', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: '请求过于频繁',
          status: 429,
          code: 'RATE_LIMITED',
        }),
      }),
    );
    await page.goto(`${BASE_URL}/stocks/SSE%3A600519`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="error-banner"]', { timeout: 10_000 });
    const rateLimitedText = await page.locator('[data-testid="error-banner"]').innerText();
    if (!rateLimitedText.includes('请求暂时无法处理')) {
      console.error(`[dom] 429 文案不符合预期：${rateLimitedText}`);
      ok = false;
    }
    ok = (await inspectPage(page, 'rate-limited-429')) && ok;
    consoleErrors = consoleErrors.filter((text) => !/429/.test(text));
    await page.unroute('**/v1/instruments/*/quote*');

    // 断网：用独立 context 把 navigator.onLine 置 false 并拦截 /v1（页面静态资源仍可从本地服务加载），
    // 验证走「网络连接不可用」且不出现任何旧数值。整页离线会让页面本身无法加载，故不采用 context.setOffline。
    const offlineContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    await offlineContext.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'onLine', {
        configurable: true,
        get: () => false,
      });
    });
    await offlineContext.route('**/v1/**', (route) => route.abort());
    const offlinePage = await offlineContext.newPage();
    await offlinePage.goto(`${BASE_URL}/stocks/SSE%3A600519`, { waitUntil: 'domcontentloaded' });
    await offlinePage.waitForSelector('[data-testid="error-banner"]', { timeout: 10_000 });
    const offlineText = await offlinePage.locator('[data-testid="error-banner"]').innerText();
    if (!offlineText.includes('网络连接不可用')) {
      console.error(`[dom] 断网文案不符合预期：${offlineText}`);
      ok = false;
    }
    ok = (await inspectPage(offlinePage, 'offline')) && ok;
    await offlineContext.close();

    // 异常态不得省略（H3 m01536 / Lead m01541）：标签必须由字段值直接映射，且终止上市/未上市/停牌
    // 必须如实出现。用 Playwright 路由在生产构建上注入契约形状响应，避免依赖真实栈是否具备异常样本。
    const instrumentMeta = {
      source: { source: 'platform_snapshot', as_of: '2026-11-03T15:00:00+08:00', staleness_ms: 0 },
      entitlement: { tier: 'c_end_display', is_entitled: true },
    };
    const baseInstrument = {
      instrument_id: 'SSE:600519',
      exchange: 'SSE',
      name: '贵州茅台',
      board: 'main',
      security_type: 'stock',
      list_status: 'listed',
      listed_at: '2001-08-27',
    };
    const instrumentRoute = '**/v1/instruments/*';
    const abnormalCases = [
      {
        name: 'delisted',
        status: '终止上市',
        data: { ...baseInstrument, list_status: 'delisted' },
      },
      {
        name: 'prelisted',
        status: '未上市',
        data: { ...baseInstrument, list_status: 'pre_listed', listed_at: undefined },
      },
    ];
    for (const item of abnormalCases) {
      consoleErrors = [];
      await page.route(instrumentRoute, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: item.data, meta: instrumentMeta }),
        }),
      );
      await page.goto(`${BASE_URL}/stocks/SSE%3A600519`, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-testid="stock-page"]', { timeout: 10_000 });
      const statusText = await page.locator('[data-testid="stock-list-status"]').innerText();
      if (statusText.trim() !== item.status) {
        console.error(
          `[dom] ${item.name} 状态标签应为「${item.status}」，实际「${statusText.trim()}」`,
        );
        ok = false;
      }
      ok = (await inspectPage(page, item.name)) && ok;
      await page.unroute(instrumentRoute);
    }

    consoleErrors = [];
    await page.route('**/v1/instruments/*/quote', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            instrument_id: 'SSE:600519',
            trade_date: '2026-11-03',
            last_price: null,
            prev_close: null,
            change: null,
            change_pct: null,
            volume: 0,
            amount: 0,
            suspended: true,
            limit_status: 'none',
          },
          meta: {
            source: {
              source: 'platform_snapshot',
              as_of: '2026-11-03T15:00:00+08:00',
              staleness_ms: 0,
            },
            adjustment: 'none',
            entitlement: { tier: 'c_end_display', is_entitled: true },
            disclaimer: {
              text: '本平台展示的行情与基本面数据来自公开数据源，可能存在延迟或误差；内容仅作客观数据展示，不构成任何投资建议，投资有风险，请独立判断。',
              version: '2026.11.1',
              closable: false,
            },
          },
        }),
      }),
    );
    await page.goto(`${BASE_URL}/stocks/SSE%3A600519`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="stock-page"]', { timeout: 10_000 });
    const suspendedNote = await page.locator('.quote__flag').innerText();
    if (suspendedNote.trim() !== copy.quote.suspended) {
      console.error(`[dom] suspended 停牌提示不符：${suspendedNote}`);
      ok = false;
    }
    const suspendedPrice = await page.locator('[data-testid="quote-price"]').innerText();
    if (/\d/.test(suspendedPrice)) {
      console.error(`[dom] suspended 停牌时不应出现价格数字：${suspendedPrice}`);
      ok = false;
    }
    ok = (await inspectPage(page, 'suspended')) && ok;
    await page.unroute('**/v1/instruments/*/quote');

    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    ok = (await inspectPage(page, 'home', { requireStockPage: false })) && ok;
  } finally {
    await browser.close();
  }

  if (consoleErrors.length) {
    console.error(`[dom] console errors：${consoleErrors.join(' | ')}`);
    ok = false;
  }
  process.exit(ok ? 0 : 1);
}

void main();
