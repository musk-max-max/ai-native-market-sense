// tests/e2e/specs/auth-boundary.spec.js
// KD-E2E-AUTH-ALIGN（ADR-008 S1，A0 认证 preHandler）：
//   匿名访问非公开 /v1/*  -> 401 UNAUTHENTICATED（默认拒绝，getInstrument 也不在白名单）
//   已认证但未授权        -> 403 ENTITLEMENT_RESTRICTED（internal_eval 档）
// 这两条是**不同语义**：把 401 写成 403（或反过来）都会让「认证」与「授权」的边界失真。
// 公开白名单只有 /healthz、/v1/auth/{register,login}、/v1/internal/auth/register；本文件顺带守住白名单没被扩大。

import { test, expect } from '@playwright/test';
import { guard, scenario, AUTH_TOKEN, BASE_URL } from '../lib/harness.js';

test.describe.configure({ mode: 'serial' });

const INSTRUMENT = scenario().instrument_id;
const ENC = encodeURIComponent(INSTRUMENT);
const MATRIX = (process.env.E2E_ENTITLEMENT_MATRIX || 'normal').trim().toLowerCase();
const BASE = `/v1/instruments/${ENC}`;

/** 六个非公开端点 + watchlist（watchlist 原本就要 Bearer，不变，但一起守住）。 */
const NON_PUBLIC_PATHS = [
  BASE,
  `${BASE}/quote`,
  `${BASE}/bars`,
  `${BASE}/fundamental-summary`,
  `${BASE}/page-summary`,
  '/v1/market/limit-ladder',
  '/v1/watchlist',
];

/** F1 数字字段的精确 key 集合（与 preflight/spec 同口径：名字可显示、数字不可显示）。 */
const F1_KEYS = new Set([
  'price', 'volume', 'amount', 'vol', 'close', 'open', 'high', 'low',
  'pct_chg', 'change', 'turnover', 'quote', 'last_price', 'pre_close',
]);

function findNumericKeys(node, where = 'data') {
  const hits = [];
  if (Array.isArray(node)) {
    node.forEach((v, i) => hits.push(...findNumericKeys(v, `${where}[${i}]`)));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (F1_KEYS.has(String(k).toLowerCase())) hits.push(`${where}.${k}`);
      hits.push(...findNumericKeys(v, `${where}.${k}`));
    }
  }
  return hits;
}

async function anonymousGet(page, apiPath) {
  return page.request.get(`${BASE_URL}${apiPath}`, { headers: { Accept: 'application/json' } });
}

async function authedGet(page, apiPath) {
  return page.request.get(`${BASE_URL}${apiPath}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
  });
}

// ---- 匿名：401，不是 403，也不是 200 ----

test('E2E-AUTH-01 [hop:api.auth] 匿名访问非公开 /v1 必须 401 UNAUTHENTICATED（含 getInstrument，不做公开例外）', async ({ page }) => {
  guard(test);

  for (const path of NON_PUBLIC_PATHS) {
    const res = await anonymousGet(page, path);
    expect(res.status(), `匿名 ${path} 必须 401（ADR-008 S1 默认拒绝；403=preHandler 漏拦、200=误公开）`).toBe(401);
    const body = await res.json();
    expect(body.code, `匿名 ${path} 的 Problem code 必须是 UNAUTHENTICATED`).toBe('UNAUTHENTICATED');
    expect(body.data, `匿名 ${path} 不得返回 data（未认证不能拿到任何业务载荷）`).toBeUndefined();
  }

  // getInstrument 从公开 200 改成 401 是 Lead 裁定（不进 PublicRoutes）；这里显式写死，防止有人「顺手」放开。
  const instrument = await anonymousGet(page, BASE);
  expect(instrument.status(), 'getInstrument 不在公开白名单（Lead 裁定：F1 落地后再议）').toBe(401);

  // 公开白名单不能被 S1 过度封禁：/healthz 匿名必须仍 200。
  const health = await page.request.get(`${BASE_URL}/healthz`, { headers: { Accept: 'application/json' } });
  expect(health.status(), '/healthz 是公开白名单，匿名必须 200').toBe(200);
});

// ---- 认证后：仍未授权 -> 403；401 只属于「没认证」 ----

test('E2E-AUTH-02 [hop:api.auth+api.market] 已认证但未授权仍为 403 ENTITLEMENT_RESTRICTED（不是 401）', async ({ page }) => {
  guard(test);
  test.skip(MATRIX !== 'restricted',
    `当前矩阵=${MATRIX}：403 形态只在受限档（E2E_ENTITLEMENT_MATRIX=restricted + internal_eval token）验证；`
    + 'normal 的 200 由 E2E-P0-02..05 覆盖');

  expect(AUTH_TOKEN, '受限矩阵需要 E2E_AUTH_TOKEN（internal_eval 用户）才能验「认证后 403」').not.toBe('');

  // quote / bars / fundamental-summary：认证+无权 -> 403（不能因为匿名改 401 就把这里也改成 401）
  for (const suffix of ['quote', 'bars', 'fundamental-summary']) {
    const res = await authedGet(page, `${BASE}/${suffix}`);
    expect(res.status(), `认证后 ${suffix} 必须 403（internal_eval 无权），不能是 401`).toBe(403);
    const body = await res.json();
    expect(body.code, `认证后 ${suffix} 403 应为 ENTITLEMENT_RESTRICTED 类 Problem`).toMatch(/ENTITLEMENT|RESTRICTED/);
  }

  // limit-ladder：同样要求认证，internal_eval 下 403。
  const ladder = await authedGet(page, '/v1/market/limit-ladder');
  expect(ladder.status(), '认证后 limit-ladder 必须 403（internal_eval 无权）').toBe(403);
  expect((await ladder.json()).code).toMatch(/ENTITLEMENT|RESTRICTED/);

  // instrument：fail-closed 只藏数字、不藏标的 -> 200 + is_entitled=false，无行情数值字段。
  const instrument = await authedGet(page, BASE);
  expect(instrument.status(), '认证后 instrument 应 200（fail-closed 不是整页藏空）').toBe(200);
  const instrumentBody = await instrument.json();
  expect(instrumentBody.meta?.entitlement?.is_entitled, 'internal_eval 的 instrument 必须 is_entitled=false').toBe(false);
  expect(findNumericKeys(instrumentBody.data), 'instrument 200 不得夹带行情数值字段（F1）').toEqual([]);

  // page-summary：受限形态是 200 骨架 + 显式缺口，不是 403（ADR-007：不得用 403 隐藏标的本身）。
  const summary = await authedGet(page, `${BASE}/page-summary`);
  expect(summary.status(), '认证后 page-summary 受限形态应为 200 骨架（403 只保留给页面级全阻断）').toBe(200);
  const summaryBody = await summary.json();
  expect(summaryBody.meta?.entitlement?.is_entitled, 'page-summary 受限形态必须 is_entitled=false').toBe(false);
  expect(findNumericKeys(summaryBody.data), 'page-summary 受限骨架不得携带可判读数值（F1）').toEqual([]);
});
