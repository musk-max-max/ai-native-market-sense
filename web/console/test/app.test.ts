import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

/**
 * App 冒烟测试（jsdom）：四中台导航壳 + 路由切换。
 * 不覆盖业务细节，只保证「脚手架能起来、nav 能切页、配置编辑器能挂载」。
 */

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/console/overview',
});
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.defineProperty(globalThis, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true });
Object.defineProperty(globalThis, 'MouseEvent', { value: dom.window.MouseEvent, configurable: true });
Object.defineProperty(globalThis, 'Event', { value: dom.window.Event, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function query(container: ParentNode, testId: string): HTMLElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`未找到 data-testid=${testId}`);
  return element as HTMLElement;
}

test('App：四中台导航壳渲染，nav 切换后配置编辑器挂载', async () => {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const { App } = await import('../src/App');
  const { TESTIDS } = await import('../src/lib/testids');

  const root = createRoot(document.getElementById('root') as HTMLElement);
  await act(async () => {
    root.render(React.createElement(App));
  });
  // 等 useAsync 的 mock 数据落地
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const shell = query(document, TESTIDS.appShell);
  assert.match(shell.textContent ?? '', /Market Sense · 中后台/);
  for (const route of ['overview', 'config', 'approvals', 'compliance', 'crm'] as const) {
    query(document, TESTIDS.navItem(route));
  }

  // 切到配置编辑器：出现可配项选择（默认选中第一个可配项）
  await act(async () => {
    query(document, TESTIDS.navItem('config')).click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  query(document, TESTIDS.configItemSelect('ops.home-feed'));
  assert.match(document.body.textContent ?? '', /配置编辑器/);

  await act(async () => {
    root.unmount();
  });
});
