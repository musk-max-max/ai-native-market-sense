import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActorBadge } from '../src/design-system/ActorBadge';
import { StatusBadge, LevelBadge } from '../src/design-system/StatusBadge';
import { ImpactPanel } from '../src/design-system/ImpactPanel';
import { EmptyState } from '../src/design-system/EmptyState';

test('StatusBadge / LevelBadge：状态机文案与风险等级', () => {
  const draft = renderToStaticMarkup(createElement(StatusBadge, { state: 'draft' }));
  assert.match(draft, /草稿/);
  const pending = renderToStaticMarkup(createElement(StatusBadge, { state: 'pending_approval' }));
  assert.match(pending, /待审批/);

  const c3 = renderToStaticMarkup(createElement(LevelBadge, { level: 'C3' }));
  assert.match(c3, />C3</);
  assert.match(c3, /高风险/);
});

test('ActorBadge：agent 与人类来源可区分（含 modelVersion / runId）', () => {
  const human = renderToStaticMarkup(
    createElement(ActorBadge, { actor: { kind: 'human', id: 'H2' } }),
  );
  assert.match(human, /人类/);
  assert.match(human, /is-human/);

  const agent = renderToStaticMarkup(
    createElement(ActorBadge, {
      actor: { kind: 'agent', id: 'A15', modelVersion: 'sensenova-6.8-flash', runId: 'run-1' },
    }),
  );
  assert.match(agent, /AI/);
  assert.match(agent, /is-agent/);
  assert.match(agent, /sensenova-6\.8-flash/);
  assert.match(agent, /run-1/);
});

test('ImpactPanel：影响面按严重度展示；EmptyState 空态', () => {
  const panel = renderToStaticMarkup(
    createElement(ImpactPanel, {
      impacts: [
        { kind: 'users', label: '全部 C 端用户', detail: '首页立刻生效', severity: 'high' },
        { kind: 'page', label: 'H5 首页', detail: '顶部 Banner', severity: 'low' },
      ],
    }),
  );
  assert.match(panel, /影响面/);
  assert.match(panel, /全部 C 端用户/);
  assert.match(panel, /is-high/);
  assert.match(panel, /is-low/);

  const empty = renderToStaticMarkup(createElement(EmptyState, { title: '暂无数据', hint: '稍后再试' }));
  assert.match(empty, /暂无数据/);
  assert.match(empty, /稍后再试/);
});
