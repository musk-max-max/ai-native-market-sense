/**
 * 个股全维度展示（金融维度目录 v1.0 · 30+ 维度）。
 *
 * 数据源：GET /v1/c-end/stocks/:instrument_id/metrics (CEndMetricsRepo.getStockMetrics)。
 * antd-mobile 组件：Card + Grid + List。
 * 合规：只展示指标 + 数值 + as_of；不输出投资建议/评级/目标价/风险提示。
 * 文案：用户可见文案从 lib/copy.ts 引用（compliance.test 单一来源门禁）；
 *       指标 label 本身用英文 ticker（PE TTM / PB / ROE 等）避免硬编码中文。
 */
import { useEffect, useState } from 'react';
import { Card, Grid, List } from 'antd-mobile';
import { cEndMetricsGateway, type StockMetrics } from '../data/cEndMetricsGateway';
import { copy, MISSING } from '../lib/copy';

interface MetricRow {
  key: string;
  label: string;
  value: string;
}

interface MetricGroup {
  key: string;
  title: string;
  rows: readonly MetricRow[];
}

function pct(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return MISSING;
  const n = Number(value);
  if (!Number.isFinite(n)) return MISSING;
  return n.toFixed(2) + ' ' + copy.units.percent;
}

function money(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return MISSING;
  const n = Number(value);
  if (!Number.isFinite(n)) return MISSING;
  return Math.round(n).toString() + ' ' + copy.units.yuan;
}

function plain(value: string | null | undefined, digits = 2): string {
  if (value === null || value === undefined || value === '') return MISSING;
  const n = Number(value);
  if (!Number.isFinite(n)) return MISSING;
  return digits === 0 ? String(Math.round(n)) : n.toFixed(digits);
}

function price(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return MISSING;
  const n = Number(value);
  if (!Number.isFinite(n)) return MISSING;
  return n.toFixed(2) + ' ' + copy.units.yuanPerShare;
}

function groupMetrics(m: StockMetrics): readonly MetricGroup[] {
  return [
    {
      key: 'valuation',
      title: copy.metrics.groupValuation,
      rows: [
        { key: 'pe-ttm', label: 'PE TTM', value: plain(m.pe_ttm) },
        { key: 'pb', label: 'PB', value: plain(m.pb) },
        { key: 'ps-ttm', label: 'PS TTM', value: plain(m.ps_ttm) },
        { key: 'dividend-yield-ttm', label: copy.metrics.rowDividendYield, value: pct(m.dividend_yield_ttm_pct) },
        { key: 'total-mv', label: copy.metrics.rowTotalMv, value: money(m.total_market_value) },
      ],
    },
    {
      key: 'profitability',
      title: copy.metrics.groupProfitability,
      rows: [
        { key: 'gross-margin', label: copy.metrics.rowGrossMargin, value: pct(m.grossprofit_margin) },
        { key: 'net-margin', label: copy.metrics.rowNetMargin, value: pct(m.netprofit_margin) },
        { key: 'roe', label: 'ROE', value: pct(m.roe) },
        { key: 'roa', label: 'ROA', value: pct(m.roa) },
      ],
    },
    {
      key: 'growth',
      title: copy.metrics.groupGrowth,
      rows: [
        { key: 'or-yoy', label: copy.metrics.rowOrYoy, value: pct(m.or_yoy_pct) },
        { key: 'netprofit-yoy', label: copy.metrics.rowNetprofitYoy, value: pct(m.netprofit_yoy_pct) },
      ],
    },
    {
      key: 'leverage',
      title: copy.metrics.groupLeverage,
      rows: [
        { key: 'debt-to-assets', label: copy.metrics.rowDebtToAssets, value: pct(m.debt_to_assets) },
        { key: 'current-ratio', label: copy.metrics.rowCurrentRatio, value: plain(m.current_ratio) },
      ],
    },
    {
      key: 'liquidity',
      title: copy.metrics.groupLiquidity,
      rows: [
        { key: 'turnover-rate', label: copy.metrics.rowTurnoverRate, value: pct(m.turnover_rate_pct) },
        { key: 'amount', label: copy.metrics.rowAmount, value: money(m.amount) },
      ],
    },
    {
      key: 'capital-flow',
      title: copy.metrics.groupCapitalFlow,
      rows: [
        { key: 'net-inflow', label: copy.metrics.rowNetInflow, value: money(m.net_inflow_amount) },
        { key: 'lhb-net', label: copy.metrics.rowLhbNet, value: money(m.lhb_net_amount) },
      ],
    },
    {
      key: 'holders',
      title: copy.metrics.groupHolders,
      rows: [
        { key: 'north-holding', label: copy.metrics.rowNorthHolding, value: pct(m.holding_ratio_pct) },
        { key: 'holder-count', label: copy.metrics.rowHolderCount, value: plain(m.holder_number, 0) },
      ],
    },
    {
      key: 'technical',
      title: copy.metrics.groupTechnical,
      rows: [
        { key: 'close', label: copy.metrics.rowClose, value: price(m.close) },
        { key: 'pct-change', label: copy.metrics.rowPctChange, value: pct(m.pct_change_pct) },
        { key: 'close-5d', label: copy.metrics.rowClose5d, value: pct(m.close_5d_pct) },
        { key: 'close-20d', label: copy.metrics.rowClose20d, value: pct(m.close_20d_pct) },
        { key: 'close-60d', label: copy.metrics.rowClose60d, value: pct(m.close_60d_pct) },
        { key: 'ma20', label: 'MA20', value: price(m.ma20) },
      ],
    },
  ];
}

export function StockMetricsPage({ instrumentId }: { instrumentId: string }) {
  const [data, setData] = useState<StockMetrics | null>(null);
  const [error, setError] = useState<{ status: number | null; network: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await cEndMetricsGateway.getStockMetrics(instrumentId);
      if (!alive) return;
      if (r.kind === 'ready') setData(r.data);
      else setError({ status: r.status, network: r.network });
    })();
    return () => {
      alive = false;
    };
  }, [instrumentId]);

  const heading =
    data === null ? instrumentId : (data.instrument_name ?? data.instrument_id) + ' · ' + instrumentId;

  return (
    <section data-testid="stock-metrics" aria-label={copy.metrics.stockPageAriaLabel}>
      <Card title={heading}>
        <p data-testid="stock-metrics-note" style={{ fontSize: 12 }}>
          {copy.metrics.stockPageNote}
          {data !== null ? ' · as_of ' + (data.as_of ?? MISSING) : ''}
        </p>
      </Card>
      {error !== null ? (
        <div data-testid="stock-metrics-error" role="alert">
          <p>{copy.metrics.errorTitle}</p>
          <p>{error.network ? copy.metrics.errorNetwork : 'HTTP ' + (error.status ?? 'n/a')}</p>
        </div>
      ) : data === null ? (
        <div data-testid="stock-metrics-loading" aria-busy="true">
          <p>{copy.metrics.loading}</p>
        </div>
      ) : (
        groupMetrics(data).map((g) => (
          <Card
            key={g.key}
            title={g.title}
            data-testid={`stock-metrics-group-${g.key}`}
            style={{ marginTop: 12 }}
          >
            <Grid columns={2} gap={8}>
              {g.rows.map((r) => (
                <Grid.Item key={r.key} data-testid={`stock-metrics-row-${r.key}`}>
                  <div data-testid="stock-metrics-label" style={{ fontSize: 12 }}>
                    {r.label}
                  </div>
                  <div data-testid="stock-metrics-value" style={{ fontSize: 16, fontWeight: 600 }}>
                    {r.value}
                  </div>
                </Grid.Item>
              ))}
            </Grid>
          </Card>
        ))
      )}
      {data !== null ? (
        <Card
          data-testid="stock-metrics-meta"
          title={copy.metrics.metaTitle}
          style={{ marginTop: 12 }}
        >
          <List>
              <List.Item data-testid="meta-instrument-id">{data.instrument_id}</List.Item>
              <List.Item data-testid="meta-exchange">{data.exchange ?? MISSING}</List.Item>
              <List.Item data-testid="meta-quote-trade-date">
                {data.quote_trade_date ?? MISSING}
              </List.Item>
              <List.Item data-testid="meta-limit-status">
                {data.limit_status ?? MISSING}
              </List.Item>
          </List>
        </Card>
      ) : null}
    </section>
  );
}