/**
 * DataPlatformPage SSR smoke tests (L172+).
 *
 * renderToStaticMarkup runs the component once synchronously, so useAsync's
 * effects never fire: service === null renders the HTTP-backend alert and any
 * non-null service renders the initial "loading catalog" shell. Both paths
 * are pinned here so the page cannot silently regress into a blank render.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DataPlatformPage } from '../src/pages/DataPlatformPage';
import type { HttpDataPlatformService } from '../src/adapters/http-data-platform-service';

test('DataPlatformPage: service=null 渲染 HTTP backend 提示（Mock 模式守卫）', () => {
  const html = renderToStaticMarkup(createElement(DataPlatformPage, { service: null }));
  assert.match(html, /c-alert/);
  assert.match(html, /is-warning/);
  assert.match(html, /backend=http/);
  assert.match(html, /baseUrl=\/v1/);
  // 不应渲染 catalog / 查询 / 结果三段（未装配 HTTP service）。
  assert.doesNotMatch(html, /数据集 catalog/);
});

test('DataPlatformPage: 装配 service 后 SSR 首帧处于 loading（useAsync effect 不在 SSR 跑）', () => {
  const stub = {
    listDatasets: async () => ({
      datasets: [],
      as_of: '2026-11-11T00:00:00Z',
    }),
    getDatasetMeta: async () => {
      throw new Error('not used in SSR smoke');
    },
    queryDataset: async () => {
      throw new Error('not used in SSR smoke');
    },
  } as unknown as HttpDataPlatformService;
  // renderToStaticMarkup 是同步单 pass：useAsync effect 不跑，loading 始终 true，
  // 页面渲染的是「加载 catalog…」骨架，而非完整三段。
  const html = renderToStaticMarkup(createElement(DataPlatformPage, { service: stub }));
  assert.match(html, /c-card/);
  assert.match(html, /加载 catalog/);
  // 不应出现 alert/error 状态（stub 不抛错）。
  assert.doesNotMatch(html, /c-alert/);
});
