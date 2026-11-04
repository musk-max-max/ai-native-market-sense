/**
 * 契约错误工厂：域插件只抛 `HttpProblem`，由外壳（services/api/src/errors.ts）统一映射为
 * RFC 9457 Problem（application/problem+json）。域插件**不得**自己 reply.send(problem)。
 *
 * 用户可见文案一律来自外壳 `services/api/src/copy.ts` 的 MARKET_COPY（H3 m00865：域内不自拼中文）。
 * 机器可读 code 保持契约冻结值。
 */

import { MARKET_COPY, VALIDATION_FAILED_DETAIL } from '../../api/src/copy.js';
import { HttpProblem } from '../../api/src/errors.js';

export function validationError(_detail?: string): HttpProblem {
  return new HttpProblem(400, 'VALIDATION_ERROR', MARKET_COPY.validationTitle, VALIDATION_FAILED_DETAIL);
}

export function instrumentNotFound(instrumentId: string): HttpProblem {
  // instrumentId 来自请求本身，不是内部数据；前端渲染时仍需转义（A7）。
  return new HttpProblem(
    404,
    'INSTRUMENT_NOT_FOUND',
    MARKET_COPY.instrumentNotFoundTitle,
    `${MARKET_COPY.instrumentNotFoundDetailPrefix}: ${instrumentId}`,
  );
}

export function dataNotFound(_detail?: string): HttpProblem {
  return new HttpProblem(404, 'NOT_FOUND', MARKET_COPY.dataNotFoundTitle);
}

export function entitlementRestricted(): HttpProblem {
  return new HttpProblem(
    403,
    'ENTITLEMENT_RESTRICTED',
    MARKET_COPY.entitlementRestrictedTitle,
    // H3 红线：中性产品语言，不出现"授权/未取得/授权范围"等法律定性；对外不区分 expired/hold/stale。
    MARKET_COPY.entitlementRestrictedDetail,
  );
}

export function unauthenticated(): HttpProblem {
  return new HttpProblem(
    401,
    'UNAUTHENTICATED',
    MARKET_COPY.unauthenticatedTitle,
    MARKET_COPY.unauthenticatedDetail,
  );
}

/**
 * serving 视图数据不符合端口契约（无法映射成合法数值/字段）→ 交给外壳映射为 500 INTERNAL_ERROR。
 * 不得静默转换成 NaN 或 0；不向 C 端暴露字段名等内部细节。
 */
export class ServingDataError extends Error {
  override readonly name = 'ServingDataError';
}
