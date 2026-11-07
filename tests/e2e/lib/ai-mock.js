// tests/e2e/lib/ai-mock.js —— AI 卡 E2E 的契约边界 mock（A7 owns）。
//
// 职责：在浏览器网络层（page.route）拦截 /v1/ai/* 与行情三件套，按 contracts/ 的 wire 形状
// 返回 tests/fixtures/ai/ 的哨兵响应，使 AI-2/AI-3 展示层用例不依赖 A3 在途的 /v1/ai/* 实现，
// 也不碰共享栈端口。判据只认契约字段（data.as_of / meta.disclaimer.text），不认展示格式。
//
// hop 定位约定：requestLog 记录 /v1/ai/* 请求。用例失败时：
//   - requestLog 为空 → web 未发起契约请求 → 模型文本路径未接线（A6，web/h5 写域）；
//   - requestLog 非空但 DOM 缺节点 → web 渲染丢弃了响应（A6，web/h5 写域）；
//   - 响应形状与契约不符 → mock/契约层（A7 自查）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

/** 哨兵 as_of：带 +08:00 偏移，用于严格相等断言（换算/格式化会立刻暴露）。 */
export const AI_AS_OF = '2026-11-06T15:00:00+08:00';
export const AI_FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'ai');

/** 缺失 fixture = 资产缺陷（FAIL），不许当「没东西可测」跳过（README 跳过语义）。 */
export function loadAiFixture(name) {
  const file = path.join(AI_FIXTURE_DIR, name);
  if (!fs.existsSync(file)) {
    throw new Error(`FIXTURE_MISSING: ${file}（tests/fixtures/ai 资产缺陷，判 FAIL 不判 skip）`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const DISCLAIMER = {
  text:
    '本平台展示的行情、基本面与自选信息均来自公开数据源，可能存在延迟、缺失或误差；' +
    '所有内容仅作为客观数据展示，不构成任何投资建议、要约或收益承诺。' +
    '投资有风险，入市需谨慎，请独立判断并自行承担投资决策后果。',
  version: '2026.11.1',
  closable: false,
};

const ENTITLEMENT = { tier: 'c_end_display', is_entitled: true };

/** asOf 取值语义：'valid' | 'missing' | 'invalid' | 'empty'（对应 AI2-2 三个对抗场景）。 */
function sourceRef(asOf, { source = 'platform_snapshot', stalenessMs = 120000 } = {}) {
  const ref = { source, staleness_ms: stalenessMs };
  if (asOf === 'missing') return ref;
  ref.as_of = asOf === 'valid' ? AI_AS_OF : asOf === 'invalid' ? 'not-a-date' : '';
  return ref;
}

function marketPayloads(asOf) {
  return {
    instrument: {
      data: {
        instrument_id: 'SSE:600519',
        exchange: 'SSE',
        name: '贵州茅台',
        board: 'main',
        security_type: 'stock',
        list_status: 'listed',
        listed_at: '2001-08-27',
      },
      meta: { source: sourceRef(asOf), entitlement: ENTITLEMENT },
    },
    quote: {
      data: {
        instrument_id: 'SSE:600519',
        trade_date: '2026-11-06',
        last_price: 1680.0,
        prev_close: 1667.66,
        change: 12.34,
        change_pct: 0.74,
        open: 1670.0,
        high: 1688.8,
        low: 1665.0,
        volume: 12345600,
        amount: 20734560000,
        suspended: false,
        limit_status: 'none',
      },
      meta: {
        source: sourceRef(asOf),
        entitlement: ENTITLEMENT,
        adjustment: 'none',
        disclaimer: DISCLAIMER,
      },
    },
    fundamental: {
      data: {
        instrument_id: 'SSE:600519',
        report_period: '2026Q3',
        report_end_date: '2026-09-30',
        announced_at: '2026-10-30T18:00:00+08:00',
        statement_basis: 'reported',
        currency: 'CNY',
        revenue: 123456789000,
        net_profit: 6012300000,
        revenue_yoy_pct: 10.5,
        net_profit_yoy_pct: 12.3,
        eps: 47.82,
        roe_pct: 30.15,
        gross_margin_pct: 91.28,
        total_assets: 300000000000,
      },
      meta: {
        source: sourceRef(asOf, { source: 'platform_fundamental', stalenessMs: 3600000 }),
        entitlement: ENTITLEMENT,
      },
    },
  };
}

/**
 * 安装契约边界 mock。
 *   marketAsOf：行情 meta.source.as_of 的对抗场景（'valid'|'missing'|'invalid'|'empty'）。
 *   aiFixture：  /v1/ai/analyses* 的响应信封（tests/fixtures/ai/analysis-*.json）；
 *                null = 不拦 /v1/ai/*（让请求打到真实后端，供真栈验证用）。
 *   requestLog：数组，追加 `${method} ${url}`，供 hop 定位。
 */
export async function installAiCardMocks(page, { marketAsOf = 'valid', aiFixture = undefined, requestLog = [] } = {}) {
  const payloads = marketPayloads(marketAsOf);

  await page.route('**/v1/ai/**', async (route) => {
    const request = route.request();
    requestLog.push(`${request.method()} ${request.url()}`);
    if (aiFixture === null) return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(aiFixture ?? loadAiFixture('analysis-valid.json')),
    });
  });

  // 注册顺序：先宽后窄（page.route 后注册者先匹配）。
  await page.route('**/v1/instruments/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payloads.instrument) }));
  await page.route('**/v1/instruments/*/fundamental-summary*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payloads.fundamental) }));
  await page.route('**/v1/instruments/*/quote*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payloads.quote) }));

  // 自选列表：WatchlistToggle 挂载即 GET /v1/watchlist（apiGateway.getWatchlist 映射 data.items[].instrument_id）。
  // 空列表 mock = 消除「无后端时经 server.mjs 反代 502」的证据噪声；不影响 AI 卡判据。
  await page.route('**/v1/watchlist*', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: { items: [] },
        meta: { source: sourceRef('valid', { source: 'platform_watchlist' }), entitlement: ENTITLEMENT },
      }),
    });
  });

  return requestLog;
}

// ---------------------------------------------------------------------------
// dev+mock 生成块喂入（A6 item3 形态，m00418 约定）：
//   喂入不走 /v1/ai/* 网络形状（contracts/ai 未冻结），走 web/h5 mockGateway
//   （data/index.ts:18 `import.meta.env.DEV && DATA_MODE === 'mock'`，仅 DEV 可达，
//   生产构建摇树删除 = H4 控制）。URL 开关定档：
//     ?mock=ai-full       五块全量、合法 asOf
//     ?mock=ai-no-asof    缺 as_of
//     ?mock=ai-bad-asof   as_of='not-a-date'
//     ?mock=ai-empty-asof as_of=''（AI2-2 空串例，已向 A6 提需，待落）
//   两域分工：生成块域（badge/disclaimer/块内数值/块级 ai-as-of=content.asOf）
//   由 URL 档位驱动；ai-context 域（数值/ai-as-of=source.asOf）由行情侧驱动，
//   断言按容器区分，两域不串。
// ---------------------------------------------------------------------------

/** 生产构建上生成块恒为 unavailableGateway 显式缺口（本身即 fail-closed 证据）；生成块用例跑 dev server。 */
export const AI_MOCK_MODES = ['ai-full', 'ai-no-asof', 'ai-bad-asof', 'ai-empty-asof'];

/** dev server 专用端口（独立端口口径，不碰共享栈）；可用 E2E_AI_DEV_BASE_URL 覆盖。 */
export const AI_DEV_BASE_URL = process.env.E2E_AI_DEV_BASE_URL ?? 'http://127.0.0.1:5175';

/**
 * 打开 dev+mock 生成块页面。
 *   mode：AI_MOCK_MODES 之一；path 默认 stock 页（与构建产物用例同一路径）。
 * 启动命令：`VITE_DATA_MODE=mock pnpm -C web/h5 dev --port 5175`（A7 起，独立端口）。
 */
export async function openAiMockPage(page, mode, { path = '/stocks/SSE:600519', baseUrl = AI_DEV_BASE_URL } = {}) {
  if (!AI_MOCK_MODES.includes(mode)) {
    throw new Error(`AI_MOCK_MODE_UNKNOWN: ${mode}（可选 ${AI_MOCK_MODES.join('|')}）`);
  }
  await page.addInitScript(() => {
    try { window.localStorage.setItem('e2e_token', 'e2e-mock-token'); } catch { /* 忽略 */ }
  });
  const url = new URL(path, baseUrl);
  url.searchParams.set('mock', mode);
  await page.goto(url.toString());
  return url.toString();
}

/** dev+mock 域 hop 定位文案（与网络域 hopHint 分开：喂入不在网络层）。 */
export function mockHopHint(mode, detail) {
  return (
    `hop定位：dev+mock（?mock=${mode}）下${detail} → AiTextSlot 喂入/渲染未接线`
    + '（A6 web/h5 写域；生成块域=badge/disclaimer/块内数值/块级 ai-as-of，ai-context 域不在此判）'
  );
}

/** hop 定位文案：失败信息里必须能一眼看出「哪一跳坏了」。 */
export function hopHint(requestLog) {
  if (!requestLog || requestLog.length === 0) {
    return (
      'hop定位：web 未发起 /v1/ai/* 契约请求 → 模型文本路径未接线（A6 web/h5 写域；'
      + '若喂入路径不走 contracts/ai/openapi.yaml 的 /v1/ai/analyses*，请回 A7 修订 mock 层，判据不变）'
    );
  }
  return `hop定位：/v1/ai/* 请求已发出（${requestLog.join(' ; ')}）但 DOM 缺节点 → web 渲染丢弃响应（A6 web/h5 写域）`;
}
