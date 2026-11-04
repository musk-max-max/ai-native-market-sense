// tests/e2e/specs/p0-stock-page.spec.js
// P0 唯一用户旅程（决策 #8）的 E2E 证据链：
//   打开个股页 → 行情 → as_of → 免责 → 基本面摘要 → 加自选 → 刷新仍在
// 每条用例带 hop 标签，失败时报告能直接指向「哪一跳坏了」。
// 未就绪（preflight SKIP）时全部 skip；这不是放水——缺 fixture 且栈就绪时 preflight 会 FAIL。

import { test, expect } from '@playwright/test';
import {
  guard,
  tid,
  scenario,
  instrumentPath,
  api,
  apiJson,
  openStockPage,
  waitForSettled,
  isoDateInShanghai,
  isStale,
  AUTH_TOKEN,
  STALE_THRESHOLD_MS,
  assertProblemShape,
  replayPost,
  watchlistRowExists,
  dbQuery,
  status,
} from '../lib/harness.js';

test.describe.configure({ mode: 'serial' });

const scenarioData = scenario();
const INSTRUMENT = scenarioData.instrument_id;
const UNRECORDED = process.env.E2E_UNRECORDED_INSTRUMENT || 'SSE:601398';
const QUOTE_PATH = `/v1/instruments/${encodeURIComponent(INSTRUMENT)}/quote?adjustment=qfq`;
const FUNDAMENTAL_PATH = `/v1/instruments/${encodeURIComponent(INSTRUMENT)}/fundamental-summary`;
const WATCHLIST_PATH = '/v1/watchlist';

/** 从 QuoteResponse 里取契约保证的东西；data 字段名未在契约中枚举，用「数值集合」做交叉校验。 */
function quoteView(json) {
  const meta = json.meta || {};
  const data = json.data || {};
  const source = meta.data_source || meta.source;
  const asOf = (source && source.as_of) || meta.as_of || data.as_of;
  const staleness = source ? source.staleness_ms : meta.staleness_ms;
  return { meta, data, asOf, staleness, entitlement: meta.entitlement || {} };
}

/**
 * Lead m01294 / H4 门禁 #5：fail-closed 页面「屏幕上到底有没有数字」。
 * 与旧 helper 的区别（Lead 明确否掉的两种自欺）：
 *   1) 不再用 toBeHidden() 判「没有」——hidden 里的价格 devtools 一改就出来；
 *   2) 占位（0.00 / -- / — / NaN / undefined / null）与真实价格在 DOM 里长得一样，一律算泄露。
 * 断言口径：价格/涨跌类 testid 要么不存在，要么文本为空；存在且带文本（哪怕 display:none）即失败。
 * 扫描范围是**整个 DOM**（不看可见性），并覆盖骨架屏/占位类名与 ::before/::after content。
 */
const NUMERIC_TEST_IDS = ['quotePrice', 'quoteChange'];
const PLACEHOLDER_TEXT = /^(?:0(?:\.0+)?|--?|—|–|null|undefined|NaN|N\/A)$/i;

async function assertNoNumericLeak(page, label = 'fail-closed') {
  const leaks = await page.evaluate(({ ids, placeholderSource }) => {
    const placeholder = new RegExp(placeholderSource, 'i');
    const numericClass = /(?:^|[-_\s])(?:price|change|volume|amount|vol|pct|turnover|quote)(?:$|[-_\s])/i;
    const out = [];
    const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}` +
      `.${typeof el.className === 'string' ? el.className.trim().replace(/\s+/g, '.') : ''}`;

    // 1) 价格/涨跌 testid：存在且带文本就失败（不看 display/visibility/opacity）。
    for (const el of document.querySelectorAll('[data-testid]')) {
      const id = el.getAttribute('data-testid') || '';
      if (!ids.includes(id)) continue;
      const text = textOf(el);
      if (text !== '') {
        out.push(`数字 testid ${id} 存在于 DOM 且带文本 ${JSON.stringify(text)}（hidden/opacity 也算泄露：devtools 一改就出来）`);
      }
    }

    // 2) 数字类 class 节点 + 占位文本（0/0.00/--/—/NaN/undefined/null），不看可见性。
    for (const el of document.querySelectorAll('body *')) {
      const cls = typeof el.className === 'string' ? el.className : '';
      const text = textOf(el);
      if (numericClass.test(cls) && text !== '' && (/\d/.test(text) || placeholder.test(text))) {
        out.push(`数字类节点泄漏：${describe(el)} text=${JSON.stringify(text)}`);
      }
      // 3) 伪元素呈现的数字（CSS content 里的价格，DOM 文本里看不到）。
      for (const pseudo of ['::before', '::after']) {
        const content = getComputedStyle(el, pseudo).content;
        if (content && content !== 'none' && content !== 'normal' && content !== '""' && /\d/.test(content)) {
          out.push(`伪元素包含数字：${describe(el)}${pseudo} content=${content}`);
        }
      }
    }

    // 4) 骨架屏/占位块（存在即失败，不要求可见——「藏起来的骨架屏」同样是自欺）。
    for (const el of document.querySelectorAll('[class*="skeleton" i], [class*="shimmer" i], [class*="placeholder" i], [aria-busy="true"]')) {
      out.push(`骨架屏/占位块仍在 DOM：${describe(el)}`);
    }
    return out.slice(0, 12);
  }, { ids: NUMERIC_TEST_IDS.map((k) => tid(k)), placeholderSource: PLACEHOLDER_TEXT.source });

  expect(leaks, `${label}：DOM 存在行情数字或占位（Lead m01294：看起来没有 ≠ 实际没有）`).toEqual([]);

  // 5) fail-closed 下唯一该出现的东西：免责声明 + 数据不可用提示，必须可见。
  await expect(page.getByTestId(tid('disclaimer')), `${label}：免责声明必须常驻可见`).toBeVisible();
  await expect(page.getByTestId(tid('entitlementNotice')), `${label}：必须显示数据不可用/无权限提示`).toBeVisible();
}

/**
 * H4 m01421 / H3：掩盖式文案等同未做 403。
 * 四类原因（expired / hold_active / hold_stale / unauthorized_config）的 403 Problem copy 已由 A11
 * 验证 4/4 逐字节一致（check_entitlement_copy.py）；页面必须**原样渲染** Problem 的 title + detail，
 * 不得改写、不得追加自造语句（多一句即 FAIL）。
 */
async function assertEntitlementCopyMatchesProblem(page, problem, label = 'fail-closed') {
  const title = String(problem.title || '').trim();
  const detail = String(problem.detail || '').trim();
  expect(title, `${label}：403 Problem 必须有 title（A12 无法比对自造文案）`).not.toBe('');
  expect(detail, `${label}：403 Problem 必须有 detail`).not.toBe('');
  const notice = (await page.getByTestId(tid('entitlementNotice')).innerText()).replace(/\s+/g, ' ').trim();
  expect(notice, `${label}：页面文案必须原样包含 API Problem title`).toContain(title);
  expect(notice, `${label}：页面文案必须原样包含 API Problem detail`).toContain(detail);
  const leftover = notice.replace(title, '').replace(detail, '').trim();
  expect(leftover, `${label}：页面不得在 API copy 之外自造文案（H4 逐字节口径）`).toBe('');
}

// Lead m01002 / A0 m01022 / decisions.md L56：403 响应头不得把「为什么被拒」还回去，也不得暴露指纹。
const F1_FORBIDDEN_HEADER_NAMES = new Set(['x-entitlement-cause']);
const F1_FORBIDDEN_HEADER_VALUES = /expired|hold|stale|unauthorized/i;
const FINGERPRINT_HEADER_NAMES = new Set(['server', 'x-powered-by']);

function collectLeakedHeaders(headers) {
  const hits = [];
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    const text = String(value ?? '');
    if (F1_FORBIDDEN_HEADER_NAMES.has(lower)) hits.push(`${name}: "${text}"（拒绝原因头）`);
    else if (F1_FORBIDDEN_HEADER_VALUES.test(text)) hits.push(`${name}: "${text}"（拒绝原因词）`);
    if (FINGERPRINT_HEADER_NAMES.has(lower)) hits.push(`${name}: "${text}"（指纹头）`);
  }
  return hits;
}

/** 出口扫描不只扫 body：body 中性化了、header 又还回去，等于白做（L56）。 */
async function assertNoLeakyHeaders(response, label) {
  const leaked = collectLeakedHeaders(response.headers());
  expect(leaked, `${label} 响应头泄漏拒绝原因/指纹（L56：只扫 body 不扫 header 是洞）：`).toEqual([]);
}

/** 受限授权矩阵（403）下价格/时间断言由 E2E-P0-06 覆盖；其余矩阵必须 200，否则就是真实故障。 */
async function quoteJsonForMarketAssertions(page, test) {
  const response = await api(page, 'GET', QUOTE_PATH);
  await assertNoLeakyHeaders(response, 'quote');
  const status = response.status();
  test.skip(status === 403, '受限授权矩阵：行情断言由 E2E-P0-06 覆盖（README §授权矩阵）');
  expect(status, 'normal 矩阵 quote 应 200；403 只应出现在受限授权矩阵').toBe(200);
  return response.json();
}

function collectNumbers(node, out = []) {
  if (typeof node === 'number' && Number.isFinite(node)) out.push(node);
  else if (Array.isArray(node)) node.forEach((v) => collectNumbers(v, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((v) => collectNumbers(v, out));
  return out;
}

const F1_FORBIDDEN_KEYS = new Set(['price', 'volume', 'amount', 'vol', 'close', 'open', 'high', 'low',
  'pct_chg', 'change', 'turnover', 'quote']);

/** F1 否决线：受限矩阵下响应体不得出现行情数值字段（名字可显示、数字不可显示）。 */
function collectMarketFieldNames(node, out = []) {
  if (Array.isArray(node)) node.forEach((v) => collectMarketFieldNames(v, out));
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (F1_FORBIDDEN_KEYS.has(String(key).toLowerCase())) {
        out.push(key);
        continue;
      }
      collectMarketFieldNames(value, out);
    }
  }
  return out;
}

function parseDisplayedNumber(text) {
  const match = String(text).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}

async function openAndSettle(page) {
  const response = await openStockPage(page);
  expect(response, '个股页应返回文档响应（页面未实现时 preflight 已 SKIP）').toBeTruthy();
  expect(response.status(), `打开 ${instrumentPath()} 的 HTTP 状态`).toBeLessThan(400);
  await waitForSettled(page);
}

test('E2E-P0-00 [hop:web-dom] 个股页 DOM 契约：语义化 test-id 齐全且唯一', async ({ page }) => {
  guard(test);
  await openAndSettle(page);
  for (const key of ['stockPage', 'stockHeader', 'stockName', 'quotePrice', 'quoteChange', 'quoteAsOf', 'quoteSource',
    'fundamentalSummary', 'disclaimerText', 'disclaimerVersion', 'watchlistToggle']) {
    await expect(page.getByTestId(tid(key)), `缺少 data-testid=${tid(key)}（test-id 是交接契约，见 testids.json）`).toHaveCount(1);
  }
  // AC-1：首屏 6 元素（名称/最新价/涨跌幅/as_of/数据来源/免责）必须可见且无需滚动
  for (const key of ['stockName', 'quotePrice', 'quoteChange', 'quoteAsOf', 'quoteSource', 'disclaimer']) {
    const node = page.getByTestId(tid(key));
    await expect(node, `${tid(key)} 应首屏可见（AC-1 要求无需滚动）`).toBeVisible();
    await expect(node, `${tid(key)} 应位于首屏视口内（AC-1）`).toBeInViewport();
  }
  const sourceNode = page.getByTestId(tid('quoteSource'));
  const sourceText = (await sourceNode.innerText()).trim();
  expect(sourceText, `数据来源不得为空/占位：${JSON.stringify(sourceText)}`).not.toMatch(/^(undefined|null|-|—|N\/A)$/i);
  // Lead 2026-11-04：断言锚 data-source 属性，不锚中文散文（文案会漂，属性是契约）。
  const sourceAttr = await sourceNode.getAttribute('data-source');
  expect(sourceAttr, 'quote-source 必须带 data-source 属性（A7 DOM 契约）').toBeTruthy();
});

test('E2E-P0-01 [hop:web] 打开个股页：标题/代码与路由参数一致', async ({ page }) => {
  guard(test);
  await openAndSettle(page);
  await expect(page.getByTestId(tid('stockHeader'))).toBeVisible();
  const idText = (await page.getByTestId(tid('instrumentId')).innerText()).trim();
  // 页面可展示 SSE:600519 或 600519 或 贵州茅台；至少必须出现 6 位证券代码（canonical 前缀由 API 负责）
  expect(idText).toMatch(/600519/);
});

test('E2E-P0-02 [hop:web+api.market] 行情可见：价格为正、涨跌幅带符号单位、价格来自 API 数值', async ({ page }) => {
  guard(test);
  const json = await quoteJsonForMarketAssertions(page, test);
  const view = quoteView(json);
  expect(Object.keys(view.meta).length, 'QuoteResponse.meta 缺失').toBeGreaterThan(0);
  test.skip(view.entitlement.is_entitled === false, '受限授权矩阵：价格断言由 E2E-P0-06 覆盖（README §授权矩阵）');

  await openAndSettle(page);
  const priceText = (await page.getByTestId(tid('quotePrice')).innerText()).trim();
  const price = parseDisplayedNumber(priceText);
  expect(Number.isFinite(price), `quote-price 文本不可解析为数值：${JSON.stringify(priceText)}`).toBe(true);
  expect(price, '行情价格必须为正').toBeGreaterThan(0);
  const changeText = (await page.getByTestId(tid('quoteChange')).innerText()).trim();
  const change = parseDisplayedNumber(changeText);
  expect(Number.isFinite(change), 'quote-change 必须可解析为有限数值（涨/跌/平都可以为 0）').toBe(true);
  // AC-8：涨跌幅必须带正负号与 % 单位；价格必须带币种
  expect(changeText, `涨跌幅须匹配 ^[+-]\\d+(\\.\\d+)?%$（AC-8）：${JSON.stringify(changeText)}`)
    .toMatch(/^[+-]\d+(?:\.\d+)?%$/);
  expect(priceText, `价格须带币种符号/单位（AC-8）：${JSON.stringify(priceText)}`).toMatch(/[¥￥元]|CNY|RMB/i);
  // 交叉校验：UI 展示的价格必须来自 API data 的数值（不预设 data 字段名，但禁止前端自算/伪造）。
  // 允许「展示精度四舍五入」：显示 2 位小数时，API 值 round 到 2 位后相等即算一致；不允许凭空算出别的值。
  const apiNumbers = collectNumbers(view.data);
  const decimals = ((priceText.replace(/,/g, '').match(/\.(\d+)/) || [null, ''])[1] || '').length;
  const matchesDisplayed = (n) => Math.abs(n - price) < 1e-6 || Number(n.toFixed(decimals)) === price;
  expect(apiNumbers.some(matchesDisplayed), `UI 价格 ${price} 不在 API data 数值中（允许展示精度舍入）：${apiNumbers.slice(0, 20)}`).toBe(true);
});

test('E2E-P0-03 [hop:api.market+web] as_of 与 API source.as_of 严格一致（AC-2）', async ({ page }) => {
  guard(test);
  const json = await quoteJsonForMarketAssertions(page, test);
  const view = quoteView(json);
  expect(view.asOf, 'QuoteResponse 必须带 SourceRef.as_of（shared 契约 required）').toBeTruthy();
  expect(typeof view.staleness, 'SourceRef.staleness_ms 必须存在').toBe('number');

  await openAndSettle(page);
  const asOfText = (await page.getByTestId(tid('quoteAsOf')).innerText()).trim();
  // AC-2：字符串严格相等（A7 口径：原样展示 source.as_of 的 ISO 字符串）
  expect(asOfText, `as_of 必须与 API source.as_of 严格一致（AC-2）：API=${view.asOf}`).toBe(String(view.asOf));
  expect(asOfText).toMatch(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/);
  expect(asOfText).toContain(isoDateInShanghai(view.asOf));

  // 数据来源属性必须对应 API 的 source（A7 的 DOM 可能加 platform_ 前缀，例如 platform_snapshot）。
  const apiSource = String((view.meta.data_source || view.meta.source || {}).source || '');
  const sourceAttr = await page.getByTestId(tid('quoteSource')).getAttribute('data-source');
  expect(sourceAttr, 'quote-source 缺 data-source 属性').toBeTruthy();
  expect([apiSource, `platform_${apiSource}`], `data-source 必须来自 API source，实际 ${JSON.stringify(sourceAttr)}`)
    .toContain(sourceAttr);
});

test('E2E-P0-04 [hop:web+contract] stale 标记与 staleness_ms 双向一致（>15min 必标）', async ({ page }) => {
  guard(test);
  const json = await quoteJsonForMarketAssertions(page, test);
  const view = quoteView(json);
  const stale = isStale({ data_source: { staleness_ms: view.staleness, as_of: view.asOf } });
  await openAndSettle(page);
  const badge = page.getByTestId(tid('quoteStaleBadge'));
  if (stale) {
    await expect(badge, `staleness_ms=${view.staleness} > ${STALE_THRESHOLD_MS} 必须显示 stale 标记`).toBeVisible();
  } else {
    await expect(badge, `staleness_ms=${view.staleness} 未超阈值，不应显示 stale 标记`).toBeHidden();
  }
});

test('E2E-P0-05 [hop:web+contract] 免责声明常驻、不可关闭、版本与 API meta 一致', async ({ page }) => {
  guard(test);
  const json = await quoteJsonForMarketAssertions(page, test);
  const disclaimer = quoteView(json).meta.disclaimer;
  expect(disclaimer, 'QuoteResponse.meta.disclaimer 必须存在').toBeTruthy();
  expect(disclaimer.closable, '契约规定免责 closable=false').toBe(false);
  expect(disclaimer.version).toMatch(/^[0-9]{4}\.[0-9]{2}\.[0-9]+$/);

  await openAndSettle(page);
  await expect(page.getByTestId(tid('disclaimer'))).toBeVisible();
  const text = (await page.getByTestId(tid('disclaimerText')).innerText()).trim();
  const norm = (value) => String(value).replace(/\s+/g, '');
  expect(norm(text).length, '免责文案不得为空').toBeGreaterThan(10);
  expect(norm(text)).toContain(norm(disclaimer.text).slice(0, 10));
  await expect(page.getByTestId(tid('disclaimerVersion'))).toHaveText(new RegExp(disclaimer.version.replace(/\./g, '\\.')));
  // 不可关闭：关闭件不得渲染（或至少不可见）
  const close = page.getByTestId(tid('disclaimerClose'));
  if (await close.count()) await expect(close).toBeHidden();
});

test('E2E-P0-06 [hop:web+api F1 否决线] entitlement=false 时不渲染可判读价格', async ({ page }) => {
  guard(test);
  const response = await api(page, 'GET', QUOTE_PATH);
  await assertNoLeakyHeaders(response, 'P0-06 quote');
  const status = response.status();
  let json = {};
  try {
    json = await response.json();
  } catch {
    json = {};
  }
  let restricted = false;
  if (status === 403) {
    // AC-5：未授权时 API 直接 403 + Problem(ENTITLEMENT_RESTRICTED)
    assertProblemShape(json);
    expect(json.code, '403 应为 ENTITLEMENT_RESTRICTED 类错误（AC-5）').toMatch(/ENTITLEMENT|RESTRICTED|FORBIDDEN/);
    restricted = true;
  } else {
    // Lead 2026-11-04 裁定（AC-5）：受限矩阵只认 403 + ENTITLEMENT_RESTRICTED，200+is_entitled=false 不接受。
    expect(status, 'restricted 矩阵 quote 必须 403（200+is_entitled=false 不接受）；normal 矩阵必须 200').toBe(200);
    const entitlement = quoteView(json).meta.entitlement || {};
    expect(entitlement.is_entitled, 'normal 矩阵 quote 必须 200 + is_entitled=true（栈 tier 配错见 preflight ENTITLEMENT）').toBe(true);
  }

  await openAndSettle(page);
  const price = page.getByTestId(tid('quotePrice'));
  if (restricted) {
    // F1 否决线：基础信息可以 200（否则页面连证券名都显示不出），但响应体不得出现行情数值字段——只查 tier 太弱。
    const baseRes = await api(page, 'GET', `/v1/instruments/${encodeURIComponent(INSTRUMENT)}`);
    await assertNoLeakyHeaders(baseRes, 'P0-06 instrument');
    expect(baseRes.status(), 'restricted 矩阵基础信息应为 200').toBe(200);
    const baseBody = await baseRes.json();
    expect((baseBody.meta || {}).entitlement?.is_entitled, 'restricted 矩阵基础信息应 is_entitled=false').toBe(false);
    const leaked = collectMarketFieldNames(baseBody.data || {});
    expect(leaked, `基础信息响应泄露行情数值字段（F1 否决线）：${JSON.stringify(leaked)}`).toEqual([]);
    // A11/F1 页面渲染层：DOM 白名单。restricted 与 expired（到期→403）走同一分支。
    await assertNoNumericLeak(page);
    // H4 m01421：页面文案必须逐字节来自 API Problem（不得自造/改写/追加）。
    await assertEntitlementCopyMatchesProblem(page, json, 'E2E-P0-06');
  } else {
    await expect(price).toBeVisible();
    expect(parseDisplayedNumber(await price.innerText())).toBeGreaterThan(0);
  }
});

test('E2E-P0-07 [hop:api.fundamental+web] 基本面摘要：报告期/报表口径来自 API 且可见', async ({ page }) => {
  guard(test);
  const { response, json } = await apiJson(page, FUNDAMENTAL_PATH);
  test.skip(response.status() === 403, '受限授权矩阵：基本面断言不在 F1 矩阵范围内（只跑 P0-06）');
  expect(response.status(), 'fundamental-summary 应 200').toBe(200);
  const data = json.data || {};
  expect(data.report_period, 'data.report_period 必须存在').toMatch(/^[0-9]{4}Q[1-4]$/);
  expect(['reported', 'restated']).toContain(data.statement_basis);

  await openAndSettle(page);
  await expect(page.getByTestId(tid('fundamentalSummary'))).toBeVisible();
  await expect(page.getByTestId(tid('fundamentalReportPeriod'))).toContainText(data.report_period);
  // 基本面同样锚 data-source 属性（A7：span[data-source]），不锚中文描述。
  // 属性可能落在 fundamentalSummary 内部 span 上，两个位置都接受（DOM 结构不是契约，属性是）。
  const summary = page.getByTestId(tid('fundamentalSummary'));
  const sourceNodes = summary.locator('[data-source]');
  const fundamentalSource = (await sourceNodes.count())
    ? await sourceNodes.first().getAttribute('data-source')
    : await summary.getAttribute('data-source');
  expect(fundamentalSource, 'fundamental-summary 必须带 data-source 属性（A7 DOM 契约）').toBeTruthy();
  const basisText = (await page.getByTestId(tid('fundamentalStatementBasis')).innerText()).trim();
  const expectedBasis = data.statement_basis === 'restated' ? /restated|重述/i : /reported|原始/i;
  expect(basisText).toMatch(expectedBasis);
});

test('E2E-P0-08 [hop:web+api.watchlist+db] 加自选：UI 状态 + API + DB 三处一致', async ({ page }) => {
  guard(test);
  test.skip(!AUTH_TOKEN, 'E2E_AUTH_TOKEN 未设置：加自选用例需要登录态（见 README §认证）');
  await api(page, 'DELETE', `${WATCHLIST_PATH}/${encodeURIComponent(INSTRUMENT)}`); // 幂等清理，保证从干净状态开始

  await openAndSettle(page);
  const toggle = page.getByTestId(tid('watchlistToggle'));
  await toggle.click();
  await expect
    .poll(async () => JSON.stringify((await apiJson(page, WATCHLIST_PATH)).json), { timeout: 15000 })
    .toContain(INSTRUMENT);
  await expect
    .poll(() => watchlistRowExists(INSTRUMENT), { timeout: 15000 })
    .toBe(true);
});

test('E2E-P0-09 [hop:web+db] 刷新后自选仍在（刷新必须仍有服务端真相）', async ({ page }) => {
  guard(test);
  test.skip(!AUTH_TOKEN, 'E2E_AUTH_TOKEN 未设置：刷新持久化用例需要登录态');
  await openAndSettle(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSettled(page);

  const toggle = page.getByTestId(tid('watchlistToggle'));
  const pressed = await toggle.getAttribute('aria-pressed');
  const stateText = (await page.getByTestId(tid('watchlistState')).innerText().catch(() => '')).trim();
  expect(
    pressed === 'true' || /已自选|已加入|added/i.test(stateText),
    `刷新后自选状态丢失（aria-pressed=${pressed}, state=${JSON.stringify(stateText)}）`,
  ).toBe(true);

  const { json } = await apiJson(page, WATCHLIST_PATH);
  expect(JSON.stringify(json), '刷新后 API 仍必须包含该标的').toContain(INSTRUMENT);
  expect(watchlistRowExists(INSTRUMENT), '刷新后 DB 记录不应丢失').toBe(true);
});

test('E2E-P0-10 [hop:api→replay] 已录制回放、未录制显式 503，不静默造假数据', async ({ page }) => {
  guard(test);
  // 录播代理只是这一条的前置（Lead 2026-11-04）：replay 不在不影响其余 10 条。
  const replay = status().replay || {};
  test.skip(replay.ready === false, `P0-10 前置缺失（录播代理未就绪）：${replay.detail || 'unknown'}`);

  // ① 已录制请求：原样回放合成录制（值必须是录制里的 SYNTHETIC 数据，不能是实时行情）。
  const recordedPayload = {
    api_name: 'daily',
    params: { ts_code: '600519.SH', start_date: '20261028', end_date: '20261103', offset: 0, limit: 6000 },
    fields: ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'change', 'pct_chg', 'vol', 'amount'],
  };
  const recorded = await replayPost(recordedPayload);
  expect(recorded.status, '已录制请求必须回放成功（200）').toBe(200);
  expect(recorded.json.code, '回放响应必须是 code=0 的 tushare 形状').toBe(0);
  expect(Array.isArray(recorded.json.data?.items) && recorded.json.data.items.length > 0,
    '已录制请求回放不得返回空 data（空 data 会掩盖录制缺失）').toBe(true);

  // ② 未录制请求：必须 503 + FIXTURE_MISSING，且响应里不得出现伪造的 data/items。
  const unrecordedPayload = {
    api_name: 'daily',
    params: { ts_code: '688981.SH', start_date: '20261028', end_date: '20261103', offset: 0, limit: 6000 },
    fields: recordedPayload.fields,
  };
  const unrecorded = await replayPost(unrecordedPayload);
  expect(unrecorded.status, '未录制请求必须显式失败（503），不得返回 200 假数据').toBe(503);
  expect(unrecorded.json.code, '未录制错误体必须带机器可读 code').toBe('FIXTURE_MISSING');
  expect(unrecorded.json.data, '未录制响应不得含任何 data（禁止伪造行情）').toBeUndefined();

  // ③ 产品层：未落库/未录制的标的页面必须显示错误提示，而不是空白或假价格。
  const response = await api(page, 'GET', `/v1/instruments/${encodeURIComponent(UNRECORDED)}/quote`);
  expect(response.status(), '未录制标的不得返回 200 成功').not.toBe(200);
  expect([400, 404, 500, 502, 503, 504]).toContain(response.status());
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  assertProblemShape(body);
  expect(body.code, '错误体必须带机器可读 code').toMatch(/^[A-Z_]+$/);

  await page.goto(`/stocks/${UNRECORDED}`, { waitUntil: 'domcontentloaded' }).catch(() => null);
  const banner = page.getByTestId(tid('errorBanner'));
  const price = page.getByTestId(tid('quotePrice'));
  await expect(banner, '未录制/不可用标的应显示错误提示，而不是空白或假数据').toBeVisible({ timeout: 15000 });
  if (await price.count()) {
    const text = (await price.innerText()).trim();
    expect(text, `错误态不得渲染价格：${JSON.stringify(text)}`).not.toMatch(/\d{1,4}\.\d{2}/);
  }
});

test('E2E-P0-11 [hop:api.compliance+db+web] hold 冻结：行情 403、基础信息可显示、clear 后恢复', async ({ page }) => {
  guard(test);
  // hold 是「控制面」能力：E2E 只在显式声明「stack 已开 hold check + 迁移已跑」时断言。
  // 不静默跳过成假绿——未显式开启时这条 skip，并在报告里保留原因。
  test.skip(process.env.E2E_HOLD_ENABLED !== '1',
    'hold 控制未启用（E2E_HOLD_ENABLED!=1）：未 raise_hold 的栈上断言 hold 语义等于空跑');
  test.skip(!AUTH_TOKEN, 'hold 矩阵需要 Bearer token（受限档）');
  // A3 m01156：clear 后「200 + is_entitled=true」只在已授权矩阵成立；
  // default internal_eval 下 clear 后仍 200 但 is_entitled=false（restricted 下 quote 仍应 403）。
  // 这条用例按已授权矩阵写死，矩阵不符时 skip 并在报告里带原因，不放宽断言。
  const matrix = process.env.E2E_ENTITLEMENT_MATRIX || 'normal';
  test.skip(matrix !== 'normal',
    `P0-11 需已授权矩阵（E2E_ENTITLEMENT_MATRIX=normal + E2E_ENTITLEMENT_TIER=c_end_display）；当前 ${matrix}`);
  const ticket = `E2E-HOLD-${Date.now()}`;
  try {
    try {
      const raised = dbQuery(`SELECT audit.raise_hold('e2e-hold', '${ticket}')`).out;
      expect(raised, 'raise_hold 应把 ticket 写进审计（A3/A5 契约）').toContain(ticket);
    } catch (err) {
      throw new Error('raise_hold 失败：E2E 库必须先跑 A13 infra/scripts/db-migrate.sh'
        + '（应用 services/compliance/migrations/001_audit_entitlement_events.sql + 20_grants），'
        + '禁止 compose 手写 DDL；且 api 需 ENTITLEMENT_HOLD_CHECK=1：' + err.message);
    }

    // A3 的 gate 对「未 hold」control 行有 30s 缓存（正常放行态缓存、hold 态不缓存），
    // raise_hold 后要等缓存过期才能看到 403；这是真实语义，不能用一次请求碰运气。
    const holdDeadline = Date.now() + 40_000;
    let blocked = await api(page, 'GET', QUOTE_PATH);
    while (blocked.status() !== 403 && Date.now() < holdDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      blocked = await api(page, 'GET', QUOTE_PATH);
    }
    await assertNoLeakyHeaders(blocked, 'hold quote');
    expect(blocked.status(), 'hold 期间 quote 必须 403（fail-closed，A3 真栈证据；40s 内未生效）').toBe(403);
    const blockedBody = await blocked.json();
    assertProblemShape(blockedBody);
    expect(blockedBody.code, '403 应为 ENTITLEMENT_RESTRICTED 类错误（AC-5）')
      .toMatch(/ENTITLEMENT|RESTRICTED|FORBIDDEN/);

    // fail-closed 不等于整页藏空：基础信息仍可显示，但不得夹带行情数值（F1 否决线）。
    const baseRes = await api(page, 'GET', `/v1/instruments/${encodeURIComponent(INSTRUMENT)}`);
    await assertNoLeakyHeaders(baseRes, 'hold instrument');
    expect(baseRes.status(), 'hold 期间基础信息仍 200（否则页面连证券名都显示不出）').toBe(200);
    const baseBody = await baseRes.json();
    expect((baseBody.meta || {}).entitlement?.is_entitled, 'hold 期间基础信息 is_entitled=false').toBe(false);
    expect(collectMarketFieldNames(baseBody.data || {}), 'hold 期间基础信息不得含行情数值字段').toEqual([]);

    await openStockPage(page);
    await waitForSettled(page);
    await expect(page.getByTestId(tid('entitlementNotice')), 'hold 期间页面显示降级提示（不锚文案）').toBeVisible();
    await assertNoNumericLeak(page);
  } finally {
    try {
      dbQuery(`SELECT audit.clear_hold('${ticket}', 'e2e-e2e', repeat('a',64))`);
    } catch {
      // 清理失败不能掩盖真正的失败原因；下一次 db-migrate 前的测试数据可重建
    }
  }

  const recoverDeadline = Date.now() + 40_000;
  let recovered = await api(page, 'GET', QUOTE_PATH);
  while (recovered.status() !== 200 && Date.now() < recoverDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    recovered = await api(page, 'GET', QUOTE_PATH);
  }
  await assertNoLeakyHeaders(recovered, 'clear-hold quote');
  expect(recovered.status(), 'clear_hold 后 quote 应立即恢复 200（A3 真栈证据）').toBe(200);
  const recoveredBody = await recovered.json();
  expect((recoveredBody.meta || {}).entitlement?.is_entitled, 'clear 后 is_entitled 恢复 true').toBe(true);
});

// Lead m01294 / H4 门禁 #5：fail-closed 场景（restricted 档）必须真跑一次页面 DOM。
// 与 P0-06 的差别：P0-06 在 normal 矩阵下命中 403 分支时也会走一遍；这条在**整栈按受限档启动**
// 时（E2E_ENTITLEMENT_MATRIX=restricted / E2E_ENTITLEMENT_TIER=internal_eval）提供独立证据，
// 且断言口径是「DOM 里根本不该有数字」，不是「看起来没有」。
test('E2E-P0-12 [hop:web+api F1 fail-closed] 受限档整页：数字不存在、占位不算、hidden 不算没有', async ({ page }) => {
  await guard(test);
  test.skip(process.env.E2E_FAILCLOSED_SCENARIO !== '1',
    'fail-closed 场景需整栈按受限档启动（E2E_FAILCLOSED_SCENARIO=1）：normal 栈上跑这条等于空测');

  const quote = await api(page, 'GET', QUOTE_PATH);
  await assertNoLeakyHeaders(quote, 'fail-closed quote');
  expect(quote.status(), '受限档 quote 必须 403（fail-closed；200+is_entitled=false 不得替代，Lead m00302）').toBe(403);
  const quoteBody = await quote.json();
  assertProblemShape(quoteBody);
  expect(quoteBody.code, '受限档 403 应为 ENTITLEMENT_RESTRICTED 类错误').toMatch(/ENTITLEMENT|RESTRICTED|FORBIDDEN/);
  expect(collectMarketFieldNames(quoteBody.data || {}), '403 响应体不得夹带行情数值字段').toEqual([]);

  // 同一断言对 getInstrument 的 200 也算一遍：名称/代码/交易所可显示，行情字段必须没有。
  const base = await api(page, 'GET', `/v1/instruments/${encodeURIComponent(INSTRUMENT)}`);
  await assertNoLeakyHeaders(base, 'fail-closed instrument');
  expect(base.status(), '受限档基础信息仍应 200（fail-closed 不是整页藏空）').toBe(200);
  const baseBody = await base.json();
  expect((baseBody.meta || {}).entitlement?.is_entitled, '受限档 instrument is_entitled=false').toBe(false);
  expect(collectMarketFieldNames(baseBody.data || {}), 'instrument 200 响应不得含行情数值字段').toEqual([]);

  await openStockPage(page);
  await waitForSettled(page);
  // 5) 免责 + 「数据不可用」提示必须可见；1-4) DOM 不得有数字/占位（含 hidden/伪元素/骨架屏）。
  await assertNoNumericLeak(page, 'E2E-P0-12 fail-closed');
  // H4 m01421：四类原因共用同一 Problem copy，页面必须原样渲染 title + detail。
  await assertEntitlementCopyMatchesProblem(page, quoteBody, 'E2E-P0-12');
});

test.afterAll(async ({ browser }) => {
  // 清理：自选旅程结束后删除测试写入的记录，避免污染下一次运行（DELETE 契约幂等）。
  if (!AUTH_TOKEN) return;
  const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:3000' });
  const page = await context.newPage();
  try {
    await api(page, 'DELETE', `${WATCHLIST_PATH}/${encodeURIComponent(INSTRUMENT)}`);
  } catch {
    // 栈已关/未就绪时清理失败不掩盖真正的失败原因
  } finally {
    await context.close();
  }
});
