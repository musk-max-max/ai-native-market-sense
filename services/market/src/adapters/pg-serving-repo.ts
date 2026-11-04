/**
 * ServingRepo 的 PostgreSQL 实现：只 SELECT `serving.*` 只读 view（A2 提供，见 warehouse/serving/）。
 *
 * 边界（必须遵守）：
 *  - 不 SELECT warehouse 的 dwd_ 与 dim_ 前缀表 → A13 的只读角色只 GRANT serving schema；
 *  - 不计算 qfq/hfq → serving.serving_bar_daily 已按 adj_type 固化三口径；
 *  - 不在适配器里做契约映射（数字字符串→number 在 domain/build.ts 的 HTTP 边界完成）。
 */

import type { Pool } from 'pg';

import {
  assertCanonicalSource,
} from '../domain/time.js';
import type {
  AdjType,
  Audience,
  BarRow,
  BarsPage,
  BarsQuery,
  FactorRow,
  FundamentalSummaryRow,
  InstrumentRow,
  QuoteRow,
  ServingRepo,
  SourceInfo,
} from '../ports/serving-repo.js';

interface AsOfColumns {
  source: string;
  as_of: string;
  staleness_ms: string | number;
}

interface InstrumentDbRow extends AsOfColumns {
  instrument_id: string;
  exchange: string;
  code: string;
  name: string;
  board: string;
  security_type: string;
  list_status: string;
  lot_size: string | number;
  listed_at: string | null;
  display_safe: boolean;
}

interface QuoteDbRow extends AsOfColumns {
  instrument_id: string;
  trade_date: string | null;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  prev_close: string | null;
  change: string | null;
  change_pct: string | null;
  volume: string | number | null;
  amount: string | null;
  suspended: boolean;
  limit_status: string;
}

interface BarDbRow extends AsOfColumns {
  instrument_id: string;
  trade_date: string;
  adj_type: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | number;
  amount: string;
  factor: string | null;
}

interface FactorDbRow extends AsOfColumns {
  instrument_id: string;
  trade_date: string;
  factor: string;
}

interface FundamentalDbRow extends AsOfColumns {
  instrument_id: string;
  report_period: string;
  report_end_date: string;
  announced_at: string;
  statement_basis: string;
  currency: string;
  revenue: string;
  net_profit: string;
  revenue_yoy_pct: string | null;
  net_profit_yoy_pct: string | null;
  eps: string | null;
  roe_pct: string | null;
  gross_margin_pct: string | null;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`serving 列 ${field} 取值非法: ${JSON.stringify(value)}`);
  }
  return value as T;
}

function integer(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`serving 列 ${field} 不是非负整数: ${JSON.stringify(value)}`);
  }
  return parsed;
}

function sourceInfo(row: AsOfColumns): SourceInfo {
  assertCanonicalSource(row.source);
  const stalenessMs = typeof row.staleness_ms === 'number' ? row.staleness_ms : Number(row.staleness_ms);
  if (!Number.isSafeInteger(stalenessMs) || stalenessMs < 0) {
    throw new Error(`serving 列 staleness_ms 非法: ${JSON.stringify(row.staleness_ms)}`);
  }
  return { source: row.source, asOf: row.as_of, stalenessMs };
}

const EXCHANGES = ['SSE', 'SZSE', 'BSE'] as const;
const BOARDS = ['main', 'gem', 'star', 'bse'] as const;
const SECURITY_TYPES = ['stock', 'etf', 'index'] as const;
const LIST_STATUSES = ['listed', 'delisted', 'pre_listed'] as const;
const LIMIT_STATUSES = ['none', 'limit_up', 'limit_down'] as const;
const ADJ_TYPES = ['none', 'qfq', 'hfq'] as const;

const INSTRUMENT_COLUMNS = `
  instrument_id, exchange, code, name, board, security_type, list_status,
  lot_size, display_safe,
  to_char(listed_at, 'YYYY-MM-DD') AS listed_at,
  source,
  to_char(as_of AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD"T"HH24:MI:SS') || '+08:00' AS as_of,
  staleness_ms`;

const QUOTE_COLUMNS = `
  instrument_id,
  to_char(trade_date, 'YYYY-MM-DD') AS trade_date,
  open, high, low, close, prev_close, change, change_pct, volume, amount, suspended, limit_status,
  source,
  to_char(as_of AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD"T"HH24:MI:SS') || '+08:00' AS as_of,
  staleness_ms`;

const BAR_COLUMNS = `
  instrument_id,
  to_char(trade_date, 'YYYY-MM-DD') AS trade_date,
  adj_type, open, high, low, close, volume, amount, factor,
  source,
  to_char(as_of AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD"T"HH24:MI:SS') || '+08:00' AS as_of,
  staleness_ms`;

const FACTOR_COLUMNS = `
  instrument_id,
  to_char(trade_date, 'YYYY-MM-DD') AS trade_date,
  factor,
  source,
  to_char(as_of AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD"T"HH24:MI:SS') || '+08:00' AS as_of,
  staleness_ms`;

const FUNDAMENTAL_COLUMNS = `
  instrument_id, report_period,
  to_char(report_end_date, 'YYYY-MM-DD') AS report_end_date,
  to_char(announced_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD"T"HH24:MI:SS') || '+08:00' AS announced_at,
  statement_basis, currency, revenue, net_profit,
  revenue_yoy_pct, net_profit_yoy_pct, eps, roe_pct, gross_margin_pct,
  source,
  to_char(as_of AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD"T"HH24:MI:SS') || '+08:00' AS as_of,
  staleness_ms`;

export class PgServingRepo implements ServingRepo {
  constructor(private readonly pool: Pool) {}

  async getInstrument(instrumentId: string, audience: Audience = 'c_end'): Promise<InstrumentRow | null> {
    // L30：c_end 受众在 repo 层过滤 display_safe=false（不进 C 端结果集，内部评测态仍可取）。
    const displayFilter = audience === 'c_end' ? ' AND display_safe = true' : '';
    const result = await this.pool.query<InstrumentDbRow>(
      `SELECT ${INSTRUMENT_COLUMNS} FROM serving.serving_instrument WHERE instrument_id = $1${displayFilter}`,
      [instrumentId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      ...sourceInfo(row),
      instrument_id: row.instrument_id,
      exchange: oneOf(row.exchange, EXCHANGES, 'exchange'),
      code: row.code,
      name: row.name,
      board: oneOf(row.board, BOARDS, 'board'),
      security_type: oneOf(row.security_type, SECURITY_TYPES, 'security_type'),
      list_status: oneOf(row.list_status, LIST_STATUSES, 'list_status'),
      lot_size: integer(row.lot_size, 'lot_size'),
      listed_at: row.listed_at,
      display_safe: row.display_safe === true,
    };
  }

  async getQuote(instrumentId: string): Promise<QuoteRow | null> {
    const result = await this.pool.query<QuoteDbRow>(
      `SELECT ${QUOTE_COLUMNS} FROM serving.serving_quote_latest WHERE instrument_id = $1`,
      [instrumentId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      ...sourceInfo(row),
      instrument_id: row.instrument_id,
      trade_date: row.trade_date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      prev_close: row.prev_close,
      change: row.change,
      change_pct: row.change_pct,
      volume: row.volume === null ? null : integer(row.volume, 'volume'),
      amount: row.amount,
      suspended: row.suspended,
      limit_status: oneOf(row.limit_status, LIMIT_STATUSES, 'limit_status'),
    };
  }

  async getBars(query: BarsQuery): Promise<BarsPage> {
    const conditions = ['instrument_id = $1', 'adj_type = $2'];
    const params: Array<string | number> = [query.instrumentId, query.adjType];
    if (query.from !== undefined) {
      params.push(query.from);
      conditions.push(`trade_date >= $${params.length}::date`);
    }
    if (query.to !== undefined) {
      params.push(query.to);
      conditions.push(`trade_date <= $${params.length}::date`);
    }
    params.push(query.limit + 1);

    const result = await this.pool.query<BarDbRow>(
      `SELECT ${BAR_COLUMNS}
         FROM serving.serving_bar_daily
        WHERE ${conditions.join(' AND ')}
        ORDER BY trade_date DESC
        LIMIT $${params.length}`,
      params,
    );

    const hasMore = result.rows.length > query.limit;
    const rows = result.rows.slice(0, query.limit).reverse().map<BarRow>((row) => ({
      ...sourceInfo(row),
      instrument_id: row.instrument_id,
      trade_date: row.trade_date,
      adj_type: oneOf(row.adj_type, ADJ_TYPES, 'adj_type'),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: integer(row.volume, 'volume'),
      amount: row.amount,
      factor: row.factor,
    }));

    return { rows, hasMore, adjustment: query.adjType as AdjType };
  }

  async getLatestFactor(instrumentId: string): Promise<FactorRow | null> {
    const result = await this.pool.query<FactorDbRow>(
      `SELECT ${FACTOR_COLUMNS} FROM serving.serving_factor_latest WHERE instrument_id = $1`,
      [instrumentId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      ...sourceInfo(row),
      instrument_id: row.instrument_id,
      trade_date: row.trade_date,
      factor: row.factor,
    };
  }

  async getFundamentalSummary(instrumentId: string): Promise<FundamentalSummaryRow | null> {
    const result = await this.pool.query<FundamentalDbRow>(
      `SELECT ${FUNDAMENTAL_COLUMNS} FROM serving.serving_fundamental_summary WHERE instrument_id = $1`,
      [instrumentId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      ...sourceInfo(row),
      instrument_id: row.instrument_id,
      report_period: row.report_period,
      report_end_date: row.report_end_date,
      announced_at: row.announced_at,
      statement_basis: oneOf(row.statement_basis, ['reported', 'restated'] as const, 'statement_basis'),
      currency: oneOf(row.currency, ['CNY'] as const, 'currency'),
      revenue: row.revenue,
      net_profit: row.net_profit,
      revenue_yoy_pct: row.revenue_yoy_pct,
      net_profit_yoy_pct: row.net_profit_yoy_pct,
      eps: row.eps,
      roe_pct: row.roe_pct,
      gross_margin_pct: row.gross_margin_pct,
    };
  }
}
