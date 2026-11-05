/**
 * B1-02 盘后复盘 · 涨跌停梯队（provisional 口径）。
 *
 * ADR-007 §D5 第 1 批：从 bars（market-wide）按 board 规则推导涨停/跌停/连板梯队；
 * 精确 `stk_limit` 待第 2 批，H4 确认前按「前收盘 × (1 ± pct)」近似推导：
 *  - 主板 10%、创业板/科创板 20%、北交所 30%；
 *  - ST/*ST 使用 5% 判定当日是否触及涨跌停，但**不进入梯队**，单独 `excluded_st` 显式标注；
 *  - 涨跌停价按分四舍五入；收盘价 >= 涨停价 / <= 跌停价 视为触板；
 *  - 连板数 = 从当日向前连续同向触板的天数（停牌/缺 bar 打断）。
 *
 * 规则版本 `b1-02-provisional-v1` 写入响应；H4 确认后升版本对齐，不得静默改口径。
 * 不含 LHB/两融/北向/大宗；市场涨跌家数聚合本轮不做（响应用固定 gap 暴露）。
 */

import type { Board, ListStatus, SecurityType } from '../ports/serving-repo.js';

export interface LadderRule {
  readonly name: 'provisional_board_pct';
  readonly version: 'b1-02-provisional-v1';
  readonly st_handling: 'excluded';
  readonly price_basis: 'none';
  readonly board_pct: {
    readonly main: 10;
    readonly gem: 20;
    readonly star: 20;
    readonly bse: 30;
    readonly st: 5;
  };
  readonly note: string;
}

export interface LadderInstrument {
  readonly instrumentId: string;
  readonly name: string;
  readonly board: Board;
  readonly securityType: SecurityType;
  readonly listStatus: ListStatus;
}

export interface LadderBar {
  readonly instrumentId: string;
  /** YYYY-MM-DD */
  readonly tradeDate: string;
  /** 十进制字符串（不复权） */
  readonly close: string;
}

export interface LadderEntry {
  readonly instrument_id: string;
  readonly name: string;
  readonly board: Board;
  readonly consecutive_boards: number;
  readonly close: number;
  readonly prev_close: number;
  readonly change_pct: number;
}

export interface ExcludedStEntry {
  readonly instrument_id: string;
  readonly name: string;
  readonly board: Board;
  readonly change_pct: number;
}

export interface LadderGap {
  readonly code: string;
  readonly message: string;
}

export interface LimitLadderData {
  readonly trade_date: string;
  readonly rule: LadderRule;
  readonly limit_up: LadderEntry[];
  readonly limit_down: LadderEntry[];
  readonly excluded_st: ExcludedStEntry[];
  readonly gaps: LadderGap[];
}

const RULE: LadderRule = {
  name: 'provisional_board_pct',
  version: 'b1-02-provisional-v1',
  st_handling: 'excluded',
  price_basis: 'none',
  board_pct: { main: 10, gem: 20, star: 20, bse: 30, st: 5 },
  note:
    '精确涨跌停价待第 2 批 stk_limit 接入；本轮按前收盘与板块涨跌幅近似推导，ST/*ST 先排除并单独标注。',
};

function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

/** 价格字符串 → 分（整数），拒绝超过 2 位小数的非法输入。 */
function toCents(value: string): number | null {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (match === null) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number(match[2]);
  const fraction = Number((match[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(fraction)) return null;
  return sign * (whole * 100 + fraction);
}

function isSt(name: string): boolean {
  return /^\*?ST/i.test(name.trim());
}

function pctFor(board: Board, st: boolean): number {
  if (st) return RULE.board_pct.st;
  return RULE.board_pct[board];
}

interface InstrumentSeries {
  readonly info: LadderInstrument;
  /** 升序日期与收盘分 */
  readonly points: ReadonlyArray<{ date: string; closeCents: number }>;
}

function limitDirection(
  series: InstrumentSeries,
  index: number,
): 'limit_up' | 'limit_down' | 'none' {
  const point = series.points[index];
  const prev = series.points[index - 1];
  if (point === undefined || prev === undefined || prev.closeCents <= 0) return 'none';
  const pct = pctFor(series.info.board, isSt(series.info.name));
  const upCents = Math.round((prev.closeCents * (100 + pct)) / 100);
  const downCents = Math.round((prev.closeCents * (100 - pct)) / 100);
  if (point.closeCents >= upCents) return 'limit_up';
  if (point.closeCents <= downCents) return 'limit_down';
  return 'none';
}

/**
 * 纯函数：调用方先按 entitlement 决定是否可对外（受限档在路由层 403），
 * 输入 bars 应覆盖 trade_date 及其前若干交易日（连板窗口，建议 ≥5）。
 */
export function buildLimitLadder(input: {
  readonly tradeDate: string;
  readonly instruments: readonly LadderInstrument[];
  readonly bars: readonly LadderBar[];
}): LimitLadderData {
  const infoById = new Map(input.instruments.map((item) => [item.instrumentId, item]));
  const barsById = new Map<string, Array<{ date: string; closeCents: number }>>();
  for (const bar of input.bars) {
    if (!infoById.has(bar.instrumentId)) continue;
    const cents = toCents(bar.close);
    if (cents === null) continue;
    const list = barsById.get(bar.instrumentId) ?? [];
    list.push({ date: bar.tradeDate, closeCents: cents });
    barsById.set(bar.instrumentId, list);
  }

  const limitUp: LadderEntry[] = [];
  const limitDown: LadderEntry[] = [];
  const excludedSt: ExcludedStEntry[] = [];

  for (const [instrumentId, points] of barsById) {
    const info = infoById.get(instrumentId);
    if (info === undefined) continue;
    points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const series: InstrumentSeries = { info, points };
    const latestIndex = points.length - 1;
    const latest = points[latestIndex];
    if (latest === undefined || latest.date !== input.tradeDate) continue;
    if (info.securityType !== 'stock' || info.listStatus !== 'listed') continue;

    const direction = limitDirection(series, latestIndex);
    if (direction === 'none') continue;
    const prev = points[latestIndex - 1];
    if (prev === undefined || prev.closeCents <= 0) continue;

    const changePct = round4((latest.closeCents / prev.closeCents - 1) * 100);
    if (isSt(info.name)) {
      excludedSt.push({
        instrument_id: instrumentId,
        name: info.name,
        board: info.board,
        change_pct: changePct,
      });
      continue;
    }

    let consecutive = 1;
    for (let index = latestIndex - 1; index >= 1; index -= 1) {
      if (limitDirection(series, index) !== direction) break;
      consecutive += 1;
    }

    const entry: LadderEntry = {
      instrument_id: instrumentId,
      name: info.name,
      board: info.board,
      consecutive_boards: consecutive,
      close: latest.closeCents / 100,
      prev_close: prev.closeCents / 100,
      change_pct: changePct,
    };
    (direction === 'limit_up' ? limitUp : limitDown).push(entry);
  }

  const byStrength = (a: LadderEntry, b: LadderEntry): number =>
    b.consecutive_boards - a.consecutive_boards || a.instrument_id.localeCompare(b.instrument_id);
  limitUp.sort(byStrength);
  limitDown.sort(byStrength);
  excludedSt.sort((a, b) => a.instrument_id.localeCompare(b.instrument_id));

  return {
    trade_date: input.tradeDate,
    rule: RULE,
    limit_up: limitUp,
    limit_down: limitDown,
    excluded_st: excludedSt,
    gaps: [
      {
        code: 'STK_LIMIT_PRECISE_PENDING',
        message: '精确涨跌停价待第 2 批 stk_limit 接入；本轮为按前收盘推导的 provisional 口径。',
      },
      {
        code: 'MARKET_BREADTH_PENDING',
        message: '市场涨跌家数聚合本轮不做，待研究数据批次接入。',
      },
    ],
  };
}
