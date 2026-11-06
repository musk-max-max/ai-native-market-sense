/**
 * 埋点（H3 合规出口）。
 *
 * 只定义**白名单字段**，不做网络上报：任何第三方分析 SDK 接入前必须过 DPIA（境外一律不接）。
 *
 * 允许字段：
 *  - instrumentId：证券代码（公开信息，可带）；
 *  - route：页面路由名（home/watchlist/portfolio/limitLadder/ai/me/stock/notFound）；
 *  - uiState：界面状态（loading/ready/restricted/error/empty/add/remove）；
 *  - action：交互动作（toggle/retry）。
 *
 * 禁止字段（白名单机制天然丢弃）：
 *  - 渠道/来源内部 ID、权限分层取值等内部标识；
 *  - 手机号、身份证、邮箱、姓名等个人标识；未告知同意的用户 ID；
 *  - 任何自由文本（防止把业务 detail 或接口原文带出去）。
 *
 * 开发模式打印到 console 便于调试；生产不收集、不上报。
 */

export type AnalyticsEvent =
  | 'page_view'
  | 'stock_page_view'
  | 'ui_state'
  | 'watchlist_toggle'
  | 'retry_click';

export type UiState = 'loading' | 'ready' | 'restricted' | 'error' | 'empty' | 'add' | 'remove';
export type ActionName = 'toggle' | 'retry';

export interface AnalyticsProps {
  readonly instrumentId?: string;
  readonly route?:
    | 'home'
    | 'watchlist'
    | 'portfolio'
    | 'limitLadder'
    | 'ai'
    | 'me'
    | 'stock'
    | 'notFound';
  readonly uiState?: UiState;
  readonly action?: ActionName;
}

const ALLOWED_KEYS: Readonly<Record<AnalyticsEvent, readonly (keyof AnalyticsProps)[]>> = {
  page_view: ['route'],
  stock_page_view: ['instrumentId', 'uiState'],
  ui_state: ['route', 'uiState'],
  watchlist_toggle: ['instrumentId', 'uiState', 'action'],
  retry_click: ['route', 'action'],
};

const INSTRUMENT_ID_PATTERN = /^[A-Z]{2,6}:[A-Za-z0-9._-]{1,32}$/;

export type AnalyticsPayload = Record<string, string>;

/** 白名单清洗：只保留该事件允许的字段，并做最小格式校验；不合法字段直接丢弃。 */
export function sanitizeProps(
  event: AnalyticsEvent,
  props: AnalyticsProps = {},
): AnalyticsPayload {
  const payload: AnalyticsPayload = {};
  for (const key of ALLOWED_KEYS[event]) {
    const value = props[key];
    if (typeof value !== 'string') continue;
    if (key === 'instrumentId' && !INSTRUMENT_ID_PATTERN.test(value)) continue;
    payload[key] = value;
  }
  return payload;
}

/** 开发模式可见、生产静默；不写网络、不落 cookie/localStorage。 */
export function track(event: AnalyticsEvent, props: AnalyticsProps = {}): void {
  if (!import.meta.env.DEV) return;
  const payload = sanitizeProps(event, props);
  console.debug('[analytics]', event, payload);
}
