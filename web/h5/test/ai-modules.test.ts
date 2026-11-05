/**
 * KD-AIP0-B1 合规/骨架测试（INF-07 / B1-01 / B1-02 / B1-03）。
 *
 * 这些断言锁的是「验收红线」本身，而不是像素：
 *  1) AI 标识不可关闭、不可硬编码文案：组件无关闭 props，label/disclaimer 必填且来自服务端；
 *  2) AI 文本只能经 AiTextSlot 且必须同时携带标识+免责（类型层 + 源码层双重断言）；
 *  3) 缺口卡只接受受控原因枚举，页面不得写「我的持仓/真实持仓」；
 *  4) B1-01/B1-02 的页面状态 id、指标业务键、梯队行业务键与 A12 登记契约一致；
 *  5) 第 1 批不放假 AI 文案：页面无模型生成文本，五段 AI 位只显示「待接入」。
 *
 * 运行：pnpm --filter @market-sense/h5 test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { copy } from '../src/lib/copy.ts';
import { TID } from '../src/lib/testids.ts';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

/** 去掉注释后再扫文案，避免把「不得写 X」的说明当成违规文案。 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const BADGE = read('components/AiGeneratedBadge.tsx');
const SLOT = read('components/AiTextSlot.tsx');
const GAP = read('components/DataGapCard.tsx');
const AI_SECTION = read('components/AiInterpretation.tsx');
const PORTFOLIO = read('pages/PortfolioReviewPage.tsx');
const LADDER = read('pages/LimitLadderPage.tsx');

test('AI 生成标识不可关闭、文案不硬编码：label/disclaimer 均为必填 props', () => {
  assert.match(BADGE, /label: string;/);
  assert.match(BADGE, /disclaimer: string;/);
  assert.doesNotMatch(BADGE, /label\?:|disclaimer\?:/);
  // 不存在运营/配置层面的关闭路径
  assert.doesNotMatch(stripComments(BADGE), /\bonClose\b|\bclosable\b|\bdisabled\b|<button/);
  // AI 标识文案由服务端 P7 注入，前端不 import copy 自造
  assert.doesNotMatch(BADGE, /from '\.\.\/lib\/copy'/);
  assert.match(BADGE, /data-testid=\{TID\.aiGeneratedBadge\}/);
  assert.match(BADGE, /data-testid=\{TID\.aiDisclaimer\}/);
});

test('AI 文本只能经 AiTextSlot，且必须同时有文本/标识/免责', () => {
  assert.match(SLOT, /text: string;/);
  assert.match(SLOT, /label: string;/);
  assert.match(SLOT, /disclaimer: string;/);
  assert.doesNotMatch(SLOT, /text\?:|label\?:|disclaimer\?:/);
  assert.match(SLOT, /<AiGeneratedBadge label=\{content\.label\} disclaimer=\{content\.disclaimer\} \/>/);
  // 第 1 批没有模型文本：待接入占位来自 copy
  assert.match(SLOT, /copy\.ai\.pendingText/);
});

test('缺口卡只接受受控原因，不允许任意正文', () => {
  assert.match(GAP, /reason: GapReason;/);
  assert.match(GAP, /data-gap-key=\{gapKey\}/);
  assert.match(GAP, /data-gap-code=\{reason\}/);
  assert.match(GAP, /data-gap-reason=\{reason\}/);
  assert.match(GAP, /copy\.gap\.reasons\[reason\]/);
  assert.doesNotMatch(GAP, /children|dangerouslySetInnerHTML/);
  assert.doesNotMatch(GAP, /\{description\}|\{body\}/);
});

test('五段 AI 骨架：固定 testid + 受控段状态，估值/资金/风险走缺口卡', () => {
  assert.ok(AI_SECTION.includes('data-testid={TID.aiInterpretation}'), '缺少 ai-interpretation 容器');
  for (const id of [
    TID.aiSegmentValuation,
    TID.aiSegmentGrowth,
    TID.aiSegmentEarningsQuality,
    TID.aiSegmentCapitalFlow,
    TID.aiSegmentRisk,
  ]) {
    const name = Object.entries(TID).find(([, value]) => value === id)?.[0];
    assert.ok(name, `${id} 未在 TID 中登记`);
    assert.ok(AI_SECTION.includes(`testId={TID.${name}}`), `缺少 ${id} 的 Segment`);
  }
  assert.match(AI_SECTION, /data-segment-status=\{status\}/);
  for (const key of ['valuation', 'growth', 'earnings-quality', 'capital-flow', 'risk']) {
    assert.ok(AI_SECTION.includes(`gapKey="${key}"`), `缺少 gapKey=${key}`);
  }
  // 本批无模型生成文本：所有 AI 文本位都是 null
  assert.match(AI_SECTION, /<AiTextSlot content=\{null\} \/>/);
});

test('B1-01 自选组合复盘：文案口径、状态 id 与指标业务键锚定 A12 契约', () => {
  assert.equal(copy.review.portfolio.title, '自选组合复盘');
  for (const id of [
    TID.portfolioReviewPage,
    TID.portfolioMetrics,
    TID.portfolioMetric,
    TID.portfolioMetricValue,
    TID.portfolioScopeNote,
    TID.portfolioReviewLoading,
    TID.portfolioReviewError,
    TID.portfolioReviewEmpty,
  ]) {
    const name = Object.entries(TID).find(([, value]) => value === id)?.[0];
    assert.ok(name, `${id} 未在 TID 中登记`);
    assert.ok(PORTFOLIO.includes(`TID.${name}`), `缺少 ${id}`);
  }
  for (const key of ['interval-return', 'volatility', 'max-drawdown', 'equal-weight-benchmark']) {
    assert.ok(PORTFOLIO.includes(`metricKey="${key}"`), `缺少 data-metric-key=${key}`);
  }
  assert.match(PORTFOLIO, /copy\.review\.portfolio\.scopeNote/);
  assert.doesNotMatch(stripComments(PORTFOLIO), /我的持仓/);
});

test('B1-02 涨跌停概览：市场级汇总计数，C 端不出现个股名单（H3 排序榜禁区）', () => {
  assert.match(LADDER, /data-testid=\{TID\.limitLadderTable\}/);
  assert.match(LADDER, /data-mode="aggregate"/);
  assert.match(LADDER, /data-testid=\{TID\.limitProvisionalBanner\}/);
  assert.match(LADDER, /data-testid=\{TID\.limitStExclusion\}/);
  // 只允许计数：不得渲染个股行 / 名称 / 代码 / 板块
  assert.doesNotMatch(stripComments(LADDER), /TID\.limitLadderRow/);
  assert.doesNotMatch(stripComments(LADDER), /instrumentId|instrumentRows|row\.name|data-instrument-id/);
  assert.doesNotMatch(stripComments(LADDER), /data-limit-key/);
  // 旧「梯队榜单」文案已移除，避免页面重新出现编选语义
  assert.equal(Object.prototype.hasOwnProperty.call(copy.review.limits, 'lists'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(copy.review.limits, 'columnName'), false);
  assert.match(copy.review.limits.aggregateNote, /不含个股名单|不展示个股/);
  assert.match(copy.review.limits.stExclusion, /ST/);
});

test('页面文案不越界：不写「我的持仓/真实持仓」，AI 标识文案不在前端 copy 中硬编码', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(copy.ai, 'badge'), false);
  assert.match(copy.review.portfolio.subtitle, /不代表真实持仓/);
  assert.match(copy.ai.pendingText, /待接入/);
  assert.match(copy.review.limits.provisional, /provisional/);
});
