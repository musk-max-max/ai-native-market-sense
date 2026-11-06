import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { computeImpact } from '../src/domain/impact';
import { diffValues, threeWayMerge } from '../src/domain/diff';
import { findConfigItem, DEFAULT_VALUES } from '../src/domain/registry';

/**
 * DiffViewer 交互测试：需要真实 DOM（jsdom）。
 * 这是 KD-CONSOLE-001 要求的那条交互测试：未勾选 diff 确认不能提交、冲突需逐项解决。
 */

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/console/',
});
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.defineProperty(globalThis, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true });
Object.defineProperty(globalThis, 'MouseEvent', { value: dom.window.MouseEvent, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const feed = findConfigItem('ops.home-feed');
if (!feed) throw new Error('ops.home-feed 未注册');
const feedSeed = DEFAULT_VALUES['ops.home-feed'];
if (!feedSeed) throw new Error('ops.home-feed 种子缺失');

function query(container: HTMLElement, testId: string): HTMLElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`未找到 data-testid=${testId}`);
  return element as HTMLElement;
}

test('DiffViewer：两点 diff 展示 before/after，勾选确认前禁止提交', async () => {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { createElement, useState, act } = React;
  const { DiffViewer } = await import('../src/design-system/DiffViewer');
  const { TESTIDS } = await import('../src/lib/testids');

  const before = { ...feedSeed };
  const after = { ...feedSeed, page_size: 30, rank_strategy: '热度优先' };
  const impacts = computeImpact(feed.fields, diffValues(feed.fields, before, after), feed.level);

  let submitCalls = 0;

  function Harness() {
    const [acknowledged, setAcknowledged] = useState(false);
    return createElement(DiffViewer, {
      fields: feed.fields,
      before,
      after,
      impacts,
      acknowledged,
      onAcknowledgedChange: setAcknowledged,
      onSubmit: () => {
        submitCalls += 1;
      },
    });
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Harness));
  });

  const submit = query(container, TESTIDS.diffSubmit) as HTMLButtonElement;
  assert.equal(submit.disabled, true, '未确认 diff 前提交必须禁用');

  // before/after 两列都渲染了
  const changedRow = query(container, TESTIDS.diffRow('page_size'));
  assert.match(changedRow.textContent ?? '', /20/);
  assert.match(changedRow.textContent ?? '', /30/);

  const ack = query(container, TESTIDS.diffAck) as HTMLInputElement;
  await act(async () => {
    ack.click();
  });
  assert.equal(ack.checked, true);
  assert.equal(submit.disabled, false, '勾选确认后允许提交');

  await act(async () => {
    submit.click();
  });
  assert.equal(submitCalls, 1);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

test('DiffViewer：409 三点冲突必须逐项选择后才能提交', async () => {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { createElement, useState, act } = React;
  const { DiffViewer } = await import('../src/design-system/DiffViewer');
  const { TESTIDS } = await import('../src/lib/testids');

  const base = { ...feedSeed };
  const mine = { ...feedSeed, rank_strategy: '热度优先' };
  const theirs = { ...feedSeed, rank_strategy: '时效优先', page_size: 30 };
  const impacts = computeImpact(feed.fields, diffValues(feed.fields, base, mine), feed.level);

  const mergeRows = threeWayMerge(feed.fields, base, mine, theirs);
  assert.ok(mergeRows.some((row) => row.resolution === 'conflict'));

  let submitCalls = 0;

  function Harness() {
    const [acknowledged, setAcknowledged] = useState(false);
    const [resolutions, setResolutions] = useState({});
    return createElement(DiffViewer, {
      title: '409 冲突',
      fields: feed.fields,
      before: theirs,
      after: mine,
      conflict: { base, mine, theirs },
      impacts,
      acknowledged,
      onAcknowledgedChange: setAcknowledged,
      resolutions,
      onResolveConflict: (key: string, choice: 'mine' | 'theirs') =>
        setResolutions((current: Record<string, string>) => ({ ...current, [key]: choice })),
      onSubmit: () => {
        submitCalls += 1;
      },
    });
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Harness));
  });

  // conflict 传入后自动切三点模式
  assert.ok(container.querySelector('[data-testid="diff-three-way-table"]'));
  assert.ok(query(container, TESTIDS.conflictChoiceMine('rank_strategy')));

  const submit = query(container, TESTIDS.diffSubmit) as HTMLButtonElement;
  const ack = query(container, TESTIDS.diffAck) as HTMLInputElement;
  await act(async () => {
    ack.click();
  });
  assert.equal(submit.disabled, true, '仍有未决冲突时不能提交');

  const chooseMine = query(container, TESTIDS.conflictChoiceMine('rank_strategy'));
  await act(async () => {
    chooseMine.click();
  });
  assert.equal(chooseMine.getAttribute('aria-pressed'), 'true');
  assert.equal(submit.disabled, false, '冲突解决 + 确认 diff 后允许提交');

  await act(async () => {
    submit.click();
  });
  assert.equal(submitCalls, 1);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});
