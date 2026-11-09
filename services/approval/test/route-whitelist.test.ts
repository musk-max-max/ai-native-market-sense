/**
 * V-05 路由白名单单测：锁定 validation.isRouteAllowed 与 web/h5/src/lib/router.tsx
 * parseRoute 的对应关系（白名单注释声明的真源）。
 *
 * 背景（decisions.md L165）：A7 路由 = {home, watchlist, portfolio, limitLadder, ai, me,
 * stock/:instrument_id, aiCardFixture, notFound}。其中 aiCardFixture 是视觉采证 fixture（非产品路由，
 * 运营配置不应发布到 fixture 路由）；notFound 是 fallback。运营配置 target_route 可达集合应严格
 * 等于 parseRoute 能解析的非 fixture / 非 notFound 路由。
 *
 * 运行：npm test（node --import tsx --test test/*.test.ts）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isRouteAllowed } from '../src/domain/validation.js';

describe('V-05 target_route 白名单（validation.isRouteAllowed）', () => {
  it('接受 parseRoute 已注册的产品路由', () => {
    assert.equal(isRouteAllowed('/watchlist'), true);
    assert.equal(isRouteAllowed('/review/portfolio'), true);
    assert.equal(isRouteAllowed('/review/limits'), true);
    assert.equal(isRouteAllowed('/ai'), true);
    assert.equal(isRouteAllowed('/me'), true);
    assert.equal(isRouteAllowed('/stocks/SSE:600519'), true);
    assert.equal(isRouteAllowed('/stock/SZSE:000001'), true);
  });

  it('接受 instrument_id 模板段任意单段（保守允许）', () => {
    assert.equal(isRouteAllowed('/stocks/NASDAQ:AAPL'), true);
    assert.equal(isRouteAllowed('/stocks/SSE:600519'), true);
  });

  it('拒绝 parseRoute 返回 notFound 的路径（默认拒绝原则）', () => {
    assert.equal(isRouteAllowed('/unknown'), false);
    assert.equal(isRouteAllowed('/dev/ai-card'), false, 'fixture 路由不能成为运营 target_route');
    assert.equal(isRouteAllowed('/random/deep/path'), false);
  });

  it('拒绝首屏 / 路径（首页无 target_route 入口）', () => {
    assert.equal(isRouteAllowed('/'), false);
  });

  it('拒绝模板段跨段（单段通配仅匹配单段）', () => {
    assert.equal(isRouteAllowed('/stocks/a/b'), false);
  });

  it('拒绝大小写变体（白名单小写，路由大小写敏感）', () => {
    assert.equal(isRouteAllowed('/Watchlist'), false);
    assert.equal(isRouteAllowed('/AI'), false);
  });

  it('接受尾斜杠变体（isRouteAllowed 用 split+filter 忽略尾斜杠，与白名单语义一致）', () => {
    assert.equal(isRouteAllowed('/watchlist/'), true);
    assert.equal(isRouteAllowed('/ai/'), true);
  });
});
