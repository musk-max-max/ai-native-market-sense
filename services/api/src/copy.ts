/**
 * 服务端用户可见文案的单一来源（H3 合规出口；与 web/h5/src/lib/copy.ts 同一版本轴）。
 *
 * 规则（H3 m00839 / m00870）：
 *  - 响应 body/headers 中所有用户可见文本只能来自本文件，禁止在 handler/插件里拼中文；
 *  - 客户端可取得即算出口：包括 HTTP 响应、错误 title/detail、以及生产构建会下发的 DOM 属性；
 *  - 不得出现内部标识：tier 值、source_id、channel、错误码原值、厂商名、F1 等；
 *  - 文案变更必须升 COPY_VERSION、更新 COPY_TEXT_HASH，并在 docs/release/copy-snapshots/
 *    新增该版本快照；快照 append-only，旧版本回指以快照为准；
 *  - 发版 manifest（docs/release/copy-version-manifest.md）成对记录 frontend/backend 版本。
 */

export const COPY_VERSION = '2026.11.5';

/** 所有对外可见文本的确定性哈希（copy.ts 文本 + 版本），构建期由 scripts/check-copy-version.mjs 校验。 */
export const COPY_TEXT_HASH = 'f40eac989d8ae18d3dea7b9a75240525927ef5708d15ff9e5a99b3777357d4d7';

/** HTTP 状态码兜底标题：只描述事实，不含内部码/英文原文。 */
export const ERROR_TITLES = {
  400: '请求参数校验失败',
  401: '未认证',
  403: '无权访问',
  404: '资源不存在',
  405: '请求方法不允许',
  406: '不接受的响应格式',
  408: '请求超时',
  409: '请求状态冲突',
  410: '资源已失效',
  412: '前置条件不满足',
  413: '请求体过大',
  415: '不支持的媒体类型',
  422: '请求无法处理',
  429: '请求过于频繁',
  default: '请求无法完成',
} as const;


/**
 * 域插件的用户可见文案（A3 的 services/market 引用本对象，禁止自拼）。
 * 机器可读 code 不在此处（契约 Problem.code 保持冻结）。
 */
export const MARKET_COPY = {
  validationTitle: '请求参数校验失败',
  instrumentNotFoundTitle: '证券不存在',
  /** 后接 `: <instrument_id>`（id 来自请求，不是内部数据）。 */
  instrumentNotFoundDetailPrefix: '未收录的证券标识',
  dataNotFoundTitle: '数据不存在',
  entitlementRestrictedTitle: '行情数据暂不可用',
  entitlementRestrictedDetail: '当前版本暂不提供该标的行情数据',
  unauthenticatedTitle: '未认证',
  unauthenticatedDetail: '请先登录后再使用自选功能。',
} as const;

/** 429 的 detail：只让用户稍后再试，不露阈值/桶 key/内部码。 */
export const RATE_LIMITED_DETAIL = '请稍后再试。';

/** 校验失败时的 detail：不回传 Fastify/Node 英文原文。 */
export const VALIDATION_FAILED_DETAIL = '请检查请求参数。';

/**
 * AI 生成内容的固定标识与免责声明（ADR-007 D3 P7 / H3 合规出口）。
 *
 * 由 `services/api` 在最终响应层注入；`services/ai` 不持有、前端不拼接、运营不可关闭。
 * 文案变更必须升 COPY_VERSION 并重新走 H3 签字（ADR-006 D2/D3）。
 */
export const AI_COPY = {
  label: 'AI 生成 · 仅供参考',
  disclaimer: '本内容由 AI 生成，基于页面标注时点的市场数据整理，仅供参考，不构成投资建议，也不构成任何买卖依据。',
} as const;
