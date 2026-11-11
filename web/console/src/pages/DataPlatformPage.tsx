import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import type { DataPlatformDomain, DatasetStats, QueryResponse, ResearchRow } from '../adapters/http-data-platform-service';
import { HttpDataPlatformService } from '../adapters/http-data-platform-service';
import { DataTable, type Column } from '../design-system';
import { useAsync } from '../lib/use-async';

const DOMAIN_LABEL: Readonly<Record<DataPlatformDomain, string>> = {
  index: '指数',
  fund: '基金',
  futures: '期货',
  options: '期权',
  bond: '债券',
  fx: '外汇',

  shareholder: '股东与资本',
  quote: '行情与涨跌停',
  flow: '资金流向',
  fundamental: '基本面',
  research: '研究数据',
  sector: '行业成分',
};

/** 优先显示列（数据集特化）：找不到则取全部 key。 */
const PREFERRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  daily_basic: ['instrument_id', 'trade_date', 'close', 'pe_ttm', 'pb', 'turnover_rate_pct', 'total_market_value', 'limit_status'],
  index_daily: ['instrument_id', 'trade_date', 'open', 'high', 'low', 'close', 'pct_change_pct', 'volume', 'amount'],
  top_list: ['instrument_id', 'trade_date', 'name', 'close', 'pct_change_pct', 'turnover_rate_pct', 'lhb_net_amount', 'reason'],
  top_inst: ['instrument_id', 'trade_date', 'seat_name', 'side', 'net_buy_amount', 'buy_amount', 'sell_amount', 'reason'],
  moneyflow: ['instrument_id', 'trade_date', 'net_inflow_amount', 'buy_large_amount', 'buy_medium_amount', 'buy_small_amount', 'buy_extra_large_amount'],
  margin: ['exchange', 'trade_date', 'financing_balance', 'financing_buy_amount', 'securities_balance', 'margin_balance'],
  hk_hold: ['instrument_id', 'trade_date', 'name', 'holding_volume', 'holding_ratio_pct', 'northbound_channel'],
  stk_limit: ['instrument_id', 'trade_date', 'previous_close', 'up_limit', 'down_limit', 'limit_pct', 'exchange'],
  fina_indicator: ['instrument_id', 'announced_at', 'report_period', 'eps', 'roe', 'grossprofit_margin', 'netprofit_margin', 'debt_to_assets'],
  index_classify: ['index_code', 'industry_name', 'level', 'parent_code', 'industry_code', 'snapshot_date'],
  index_member_all: ['instrument_id', 'snapshot_date', 'name', 'l1_name', 'l2_name', 'l3_name', 'in_date', 'out_date'],
  realtime_quote: ['instrument_id', 'name', 'as_of', 'close', 'change_pct', 'volume', 'amount', 'turnover_rate', 'limit_status'],
  dc_index: ['board_code', 'trade_date', 'board_name', 'leading_name', 'leading_code', 'pct_change', 'leading_pct', 'total_mv', 'turnover_rate', 'up_num', 'down_num', 'idx_type', 'level'],
  dc_member: ['trade_date', 'board_code', 'instrument_id', 'name'],
  // L172 第一批
  daily: ['trade_date', 'instrument_id', 'open', 'high', 'low', 'close', 'pct_change_pct', 'volume', 'amount'],
  weekly: ['trade_date', 'instrument_id', 'open', 'high', 'low', 'close', 'pct_change_pct', 'volume', 'amount'],
  monthly: ['trade_date', 'instrument_id', 'open', 'high', 'low', 'close', 'pct_change_pct', 'volume', 'amount'],
  new_share: ['instrument_id', 'name', 'announced_at', 'subscription_date', 'listing_date', 'issue_price', 'raise_funds'],
  income: ['report_end_date', 'instrument_id', 'total_revenue', 'revenue', 'net_profit', 'net_profit_parent', 'basic_eps'],
  balancesheet: ['report_end_date', 'instrument_id', 'total_assets', 'total_liabilities', 'total_equity', 'current_assets', 'noncurrent_assets'],
  cashflow: ['report_end_date', 'instrument_id', 'operating_cashflow', 'investing_cashflow', 'financing_cashflow', 'net_cashflow', 'capex'],
  forecast: ['report_end_date', 'instrument_id', 'forecast_type', 'net_profit_min', 'net_profit_max', 'net_profit', 'reason'],
  express: ['report_end_date', 'instrument_id', 'revenue', 'net_profit', 'yoy_netprofit_pct', 'yoy_revenue_pct'],
  dividend: ['report_end_date', 'instrument_id', 'dividend_per_share', 'stock_dividend_ratio', 'record_date', 'ex_date'],
  pledge_detail: ['announced_at', 'instrument_id', 'pledge_count', 'pledge_ratio_pct', 'total_shares_pledged'],
  pledge_stat: ['announced_at', 'instrument_id', 'pledge_count', 'unpledge_count', 'pledge_ratio_pct', 'total_pledge_ratio_pct'],
  margin_detail: ['trade_date', 'instrument_id', 'financing_balance', 'securities_balance', 'margin_balance'],
  repurchase: ['announced_at', 'instrument_id', 'repurchase_volume', 'repurchase_amount', 'repurchase_high', 'repurchase_low'],
  share_float: ['float_date', 'instrument_id', 'float_share', 'float_ratio_pct', 'holder_name', 'share_type'],
  block_trade: ['trade_date', 'instrument_id', 'price', 'volume', 'amount', 'buyer', 'seller'],
  stk_holdernumber: ['announced_at', 'instrument_id', 'holder_number', 'holder_number_change', 'avg_market_value'],
  stk_holdertrade: ['announced_at', 'instrument_id', 'holder_name', 'change_date', 'change_volume', 'change_ratio_pct', 'direction'],
  index_basic: ['index_code', 'name', 'market', 'publisher', 'category', 'base_date', 'base_point', 'listing_date'],
  index_weekly: ['trade_date', 'instrument_id', 'open', 'high', 'low', 'close', 'pct_change_pct', 'volume'],
  index_monthly: ['trade_date', 'instrument_id', 'open', 'high', 'low', 'close', 'pct_change_pct', 'volume'],
  fund_basic: ['fund_code', 'name', 'management_company', 'custodian', 'fund_type', 'established_date'],
  fund_company: ['company_code', 'name', 'short_name', 'established_date', 'registered_capital', 'city'],
  fund_nav: ['announced_at', 'fund_code', 'unit_nav', 'accumulated_nav', 'unit_nav_return_pct'],
  fund_daily: ['trade_date', 'fund_code', 'open', 'high', 'low', 'close', 'pct_change_pct', 'volume', 'amount'],
  fund_div: ['announced_at', 'fund_code', 'dividend_per_unit', 'record_date', 'ex_date', 'payment_date'],
  fut_basic: ['futures_code', 'name', 'exchange', 'contract_unit', 'listing_date', 'delisting_date'],
  trade_cal: ['calendar_date', 'exchange', 'is_open', 'prev_trade_date'],
  fut_daily: ['trade_date', 'futures_code', 'open', 'high', 'low', 'close', 'settlement', 'volume', 'open_interest'],
  fut_holding: ['trade_date', 'futures_code', 'broker', 'long_volume', 'short_volume', 'long_change', 'short_change'],
  fut_wsr: ['trade_date', 'futures_code', 'warehouse_receipt', 'change'],
  fut_settle: ['trade_date', 'futures_code', 'settlement_price', 'settlement_margin', 'delivery_price'],
  opt_basic: ['option_code', 'name', 'exchange', 'underlying_code', 'option_type', 'exercise_price', 'expiry_date'],
  opt_daily: ['trade_date', 'option_code', 'open', 'high', 'low', 'close', 'settlement', 'volume', 'open_interest'],
  cb_basic: ['bond_code', 'name', 'underlying_code', 'issue_price', 'listing_date', 'maturity_date'],
  cb_issue: ['announced_at', 'bond_code', 'listing_date', 'issue_price', 'coupon', 'maturity_years'],
  cb_daily: ['trade_date', 'bond_code', 'open', 'high', 'low', 'close', 'pct_change_pct', 'volume'],
  fx_obasic: ['fx_code', 'name', 'exchange', 'base_currency', 'quote_currency', 'listing_date'],
  fx_daily: ['trade_date', 'fx_code', 'open', 'high', 'low, close, volume, amount'],

};

function pickColumns(rows: readonly ResearchRow[], dataset: string): Column<ResearchRow>[] {
  if (rows.length === 0) return [];
  const keys = Object.keys(rows[0] ?? {});
  const preferred = PREFERRED_COLUMNS[dataset] ?? keys;
  const ordered = [...preferred.filter((key) => keys.includes(key)), ...keys.filter((key) => !preferred.includes(key))];
  return ordered.map((key) => ({
    key,
    title: key,
    render: (row: ResearchRow) => {
      const value = row[key];
      if (value === null || value === undefined) return <span className="c-muted">—</span>;
      if (typeof value === 'number') return <span className="c-mono">{value.toLocaleString('zh-CN')}</span>;
      if (typeof value === 'string') return <span className={/^[0-9.-]+$/.test(value) ? 'c-mono' : undefined}>{value}</span>;
      return <span>{String(value)}</span>;
    },
  }));
}

export interface DataPlatformPageProps {
  /** HTTP 数据平台服务；Mock 模式下未装配，需提示切到 ?backend=http。 */
  readonly service: HttpDataPlatformService | null;
}

function ResultView({ query, dataset }: { query: QueryResponse; dataset: string }): ReactNode {
  const columns = pickColumns(query.rows, dataset);
  return (
    <>
      <p className="c-muted">
        返回 {query.rows.length} 行 / 共 {query.total.toLocaleString('zh-CN')} 行 · as_of {query.as_of}
      </p>
      {query.rows.length === 0 ? (
        <div className="c-muted">无匹配行。</div>
      ) : (
        <DataTable<ResearchRow> columns={columns} rows={query.rows} rowKey={(row) => JSON.stringify(row).slice(0, 128)} />
      )}
    </>
  );
}

/** 数据中台：业务域 → 数据集 → 维度查询，仅内部使用。 */
export function DataPlatformPage({ service }: DataPlatformPageProps) {
  const catalogState = useAsync(
    async () => {
      if (service === null) return null;
      return service.listDatasets();
    },
    [service],
  );

  const [selectedDataset, setSelectedDataset] = useState<string | null>(null);
  const [queryLimit, setQueryLimit] = useState<number>(200);
  const [queryInstrument, setQueryInstrument] = useState<string>('');
  const [queryFrom, setQueryFrom] = useState<string>('');
  const [queryTo, setQueryTo] = useState<string>('');
  const [queryTrigger, setQueryTrigger] = useState<number>(0);

  const catalog = catalogState.data;

  const datasetsByDomain = useMemo(() => {
    if (catalog == null) return {} as Record<DataPlatformDomain, DatasetStats[]>;
    const grouped: Record<string, DatasetStats[]> = {};
    for (const item of catalog.datasets) {
      const bucket = grouped[item.domain] ?? [];
      bucket.push(item);
      grouped[item.domain] = bucket;
    }
    return grouped as Record<DataPlatformDomain, DatasetStats[]>;
  }, [catalog]);

  // 数据集选择默认第一个 catalog 数据集。
  const activeDataset = selectedDataset ?? catalog?.datasets[0]?.name ?? null;
  const activeMeta = catalog?.datasets.find((item) => item.name === activeDataset) ?? null;

  const queryState = useAsync(
    async (): Promise<QueryResponse | null> => {
      if (service === null || activeDataset === null) return null;
      return service.queryDataset(activeDataset, {
        limit: queryLimit,
        offset: 0,
        ...(queryInstrument.trim().length > 0 ? { instrumentId: queryInstrument.trim() } : {}),
        ...(queryFrom.trim().length > 0 ? { from: queryFrom.trim() } : {}),
        ...(queryTo.trim().length > 0 ? { to: queryTo.trim() } : {}),
      });
    },
    [service, activeDataset, queryLimit, queryInstrument, queryFrom, queryTo, queryTrigger],
  );

  if (service === null) {
    return (
      <div className="c-card c-alert is-warning">
        数据中台需要 HTTP backend：URL 带 <code>?backend=http&amp;baseUrl=/v1&amp;environment=dev</code> 后访问。
      </div>
    );
  }

  if (catalogState.loading) return <div className="c-card">加载 catalog…</div>;
  if (catalogState.error) return <div className="c-card c-alert is-danger">{catalogState.error}</div>;

  const query = queryState.data;

  return (
    <div className="data-platform">
      <section className="c-card" aria-label="数据集目录">
        <h2 className="c-h2">数据集 catalog</h2>
        <p className="c-muted">
          共 {catalog?.datasets.length ?? 0} 个数据集；仅内部使用，不进 C 端契约（SEC-011 F1 residual：tushare 授权 0/3）。
        </p>
        {Object.entries(datasetsByDomain).map(([domain, items]) => (
          <div key={domain} className="data-platform__domain">
            <h3 className="c-h3">{DOMAIN_LABEL[domain as DataPlatformDomain] ?? domain}</h3>
            <ul className="data-platform__list">
              {items.map((item) => (
                <li key={item.name}>
                  <button
                    type="button"
                    className={item.name === activeDataset ? 'c-btn is-active' : 'c-btn'}
                    onClick={() => setSelectedDataset(item.name)}
                  >
                    {item.title}
                    <span className="c-muted c-mono">{item.rowCount.toLocaleString('zh-CN')} 行</span>
                    <span className="c-muted">· 最新 {item.latestDate ?? '—'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="c-card" aria-label="查询参数">
        <h2 className="c-h2">查询</h2>
        {activeMeta === null ? (
          <p className="c-muted">未选择数据集。</p>
        ) : (
          <>
            <div className="data-platform__meta">
              <div><strong>{activeMeta.title}</strong> <span className="c-mono c-muted">{activeMeta.name}</span></div>
              <div>{activeMeta.description}</div>
              <div>
                <span className="c-muted">来源：</span>
                {activeMeta.source}
                {activeMeta.pointsMin !== null ? (
                  <span className="c-muted"> · tushare points_min={activeMeta.pointsMin} · doc {activeMeta.docId}</span>
                ) : (
                  <span className="c-muted"> · AKshare 东方财富源（F1 residual，仅内部）</span>
                )}
              </div>
              <div>
                <span className="c-muted">模式：</span>
                {activeMeta.mode} <span className="c-muted">· 最新 as_of：</span> {activeMeta.latestAsOf ?? '—'}
              </div>
            </div>
            <div className="data-platform__filters">
              <label>
                <span>instrument_id</span>
                <input type="text" value={queryInstrument} onChange={(event) => setQueryInstrument(event.target.value)} placeholder="SSE:600519" />
              </label>
              <label>
                <span>from</span>
                <input type="date" value={queryFrom} onChange={(event) => setQueryFrom(event.target.value)} />
              </label>
              <label>
                <span>to</span>
                <input type="date" value={queryTo} onChange={(event) => setQueryTo(event.target.value)} />
              </label>
              <label>
                <span>limit</span>
                <select value={queryLimit} onChange={(event) => setQueryLimit(Number(event.target.value))}>
                  {[50, 200, 500, 1000, 5000].map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="c-btn is-primary" onClick={() => setQueryTrigger((value) => value + 1)}>
                查询
              </button>
            </div>
          </>
        )}
      </section>

      <section className="c-card" aria-label="查询结果">
        <h2 className="c-h2">结果</h2>
        {queryState.loading ? (
          <div className="c-muted">查询中…</div>
        ) : queryState.error !== null ? (
          <div className="c-alert is-danger">{queryState.error}</div>
        ) : query == null ? (
          <div className="c-muted">未执行查询。</div>
        ) : (
          <ResultView query={query} dataset={activeDataset ?? ''} />
        )}
      </section>
    </div>
  );
}
