/**
 * 多维度市场概览（金融维度目录 v1.0 · 5 tab）。
 *
 * 数据源：GET /v1/c-end/overview (CEndMetricsRepo.getMarketOverview)。
 * antd-mobile 组件：Tabs + Card + List。
 * 合规：只展示指标 + 数值 + as_of + 单位 + 来源数据集 + 派生标记；不输出投资建议/评级/目标价。
 * 文案：用户可见文案从 lib/copy.ts 引用（compliance.test 单一来源门禁）。
 */
import { useEffect, useState } from 'react';
import { Card, List, Tabs } from 'antd-mobile';
import { cEndMetricsGateway, type MarketOverviewMetric } from '../data/cEndMetricsGateway';
import { copy, MISSING } from '../lib/copy';

const DOMAIN_TABS: readonly { key: string; testid: string }[] = [
  { key: 'quote', testid: 'tab-quote' },
  { key: 'flow', testid: 'tab-flow' },
  { key: 'fundamental', testid: 'tab-fundamental' },
  { key: 'sector', testid: 'tab-sector' },
  { key: 'index', testid: 'tab-index' },
];

function groupByDomain(
  metrics: readonly MarketOverviewMetric[]
): Record<string, readonly MarketOverviewMetric[]> {
  const out: Record<string, MarketOverviewMetric[]> = {};
  for (const m of metrics) {
    const domain = (m.metric_key.split('.')[0] ?? 'other').trim();
    (out[domain] = out[domain] ?? []).push(m);
  }
  return out;
}

function tabLabel(key: string): string {
  const map: Record<string, string> = {
    quote: copy.metrics.tabQuote,
    flow: copy.metrics.tabFlow,
    fundamental: copy.metrics.tabFundamental,
    sector: copy.metrics.tabSector,
    index: copy.metrics.tabIndex,
  };
  return map[key] ?? key;
}

function MetricRow({ metric }: { metric: MarketOverviewMetric }) {
  const value = metric.value_text ?? MISSING;
  const unit = metric.unit ?? '';
  const unitSuffix = unit.length > 0 ? ' ' + unit : '';
  return (
    <List.Item
      data-testid={`overview-metric-${metric.metric_key}`}
      aria-label={`${metric.metric_key}: ${value}${unitSuffix}`}
      extra={
        <span data-testid="overview-metric-value" style={{ fontSize: 13 }}>
          {value}{unitSuffix}
        </span>
      }
      description={
        <span data-testid="overview-metric-meta" style={{ fontSize: 12 }}>
          {metric.dataset ?? MISSING} · {metric.derivation === 'derived' ? copy.metrics.derived : copy.metrics.direct}
        </span>
      }
    >
      <span data-testid="overview-metric-key">{metric.metric_key}</span>
    </List.Item>
  );
}

export function MetricsOverviewPage() {
  const [metrics, setMetrics] = useState<readonly MarketOverviewMetric[] | null>(null);
  const [error, setError] = useState<{ status: number | null; network: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await cEndMetricsGateway.getOverview();
      if (!alive) return;
      if (r.kind === 'ready') setMetrics(r.metrics);
      else setError({ status: r.status, network: r.network });
    })();
    return () => {
      alive = false;
    };
  }, []);

  const grouped = metrics === null ? null : groupByDomain(metrics);

  return (
    <section data-testid="metrics-overview" aria-label={copy.metrics.pageAriaLabel}>
      <Card title={copy.metrics.pageTitle}>
        <p data-testid="metrics-overview-note" style={{ fontSize: 12 }}>
          {copy.metrics.pageNote}
        </p>
      </Card>
      {error !== null ? (
        <div data-testid="metrics-overview-error" role="alert">
          <p>{copy.metrics.errorTitle}</p>
          <p>{error.network ? copy.metrics.errorNetwork : 'HTTP ' + (error.status ?? 'n/a')}</p>
        </div>
      ) : grouped === null ? (
        <div data-testid="metrics-overview-loading" aria-busy="true">
          <p>{copy.metrics.loading}</p>
        </div>
      ) : (
        <Tabs data-testid="metrics-overview-tabs">
          {DOMAIN_TABS.map((tab) => {
            const rows = grouped[tab.key] ?? [];
            return (
              <Tabs.Tab key={tab.key} title={tabLabel(tab.key)}>
                {rows.length === 0 ? (
                  <div data-testid={`${tab.testid}-empty`} style={{ padding: 24 }}>
                    {copy.metrics.empty}
                  </div>
                ) : (
                  <List data-testid={`${tab.testid}-list`}>
                    {rows.map((m) => (
                      <MetricRow key={m.metric_key} metric={m} />
                    ))}
                  </List>
                )}
              </Tabs.Tab>
            );
          })}
        </Tabs>
      )}
    </section>
  );
}