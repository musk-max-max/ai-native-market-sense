/**
 * approval/config 域类型（A4）。
 *
 * 契约形状的真源是 contracts/approval/openapi.yaml 与 contracts/config/openapi.yaml（H2 拥有，禁改）。
 * 本文件通过 type-only 引入 H2 生成的 packages/api-client 内部类型做**编译期契约对齐**：
 * 服务层返回值直接用这些类型，形状漂移会在 typecheck 报红。
 */

import type { components as ApprovalComponents } from '../../../../packages/api-client/src/internal/approval.js';
import type { components as ConfigComponents } from '../../../../packages/api-client/src/internal/config.js';

import type { Principal } from '../../../identity/src/domain/principal.js';

import { DomainError } from './errors.js';

// ---- approval 契约 ----
export type Actor = ApprovalComponents['schemas']['Actor'];
export type ApprovalFlow = ApprovalComponents['schemas']['ApprovalFlow'];
export type ApprovalStatus = ApprovalComponents['schemas']['ApprovalStatus'];
export type ApprovalSubject = ApprovalComponents['schemas']['ApprovalSubject'];
export type ApprovalChange = ApprovalComponents['schemas']['ApprovalChange'];
export type ApprovalEvaluation = ApprovalComponents['schemas']['ApprovalEvaluation'];
export type ApprovalDecision = ApprovalComponents['schemas']['ApprovalDecision'];
export type ApprovalDecisionRequest = ApprovalComponents['schemas']['ApprovalDecisionRequest'];
export type ApprovalApplication = ApprovalComponents['schemas']['ApprovalApplication'];
export type ApprovalEvent = ApprovalComponents['schemas']['ApprovalEvent'];
export type ApprovalApplicationList = ApprovalComponents['schemas']['ApprovalApplicationList'];
export type ApprovalEventList = ApprovalComponents['schemas']['ApprovalEventList'];
export type CreateApprovalRequest = ApprovalComponents['schemas']['CreateApprovalRequest'];

// ---- config 契约 ----
export type OpsConfigDocument = ConfigComponents['schemas']['OpsConfigDocument'];
export type OpsConfigWrite = ConfigComponents['schemas']['OpsConfigWrite'];
export type OpsSpec = ConfigComponents['schemas']['OpsSpec'];
export type ValidationIssue = ConfigComponents['schemas']['ValidationIssue'];
export type ValidationReport = ConfigComponents['schemas']['ValidationReport'];
export type SubmitRequest = ConfigComponents['schemas']['SubmitRequest'];
export type ApprovalSubmission = ConfigComponents['schemas']['ApprovalSubmission'];
export type PublishRequest = ConfigComponents['schemas']['PublishRequest'];
export type RollbackRequest = ConfigComponents['schemas']['RollbackRequest'];
export type Release = ConfigComponents['schemas']['Release'];
export type ReleaseMeta = ConfigComponents['schemas']['ReleaseMeta'];
export type Rollback = ConfigComponents['schemas']['Rollback'];
export type OpsConfigList = ConfigComponents['schemas']['OpsConfigList'];
export type ReleaseList = ConfigComponents['schemas']['ReleaseList'];
export type ThreeWayDiff = ConfigComponents['schemas']['ThreeWayDiff'];
export type FieldChange = ConfigComponents['schemas']['FieldChange'];
export type FieldConflict = ConfigComponents['schemas']['FieldConflict'];
export type DiffValue = ConfigComponents['schemas']['DiffValue'];
export type SystemMeta = ConfigComponents['schemas']['SystemMeta'];

/** 三种 environment（契约 EnvironmentQuery）。 */
export type Environment = 'dev' | 'staging' | 'prod';
export const ENVIRONMENTS: readonly Environment[] = ['dev', 'staging', 'prod'];

/**
 * token 主体 → 账本/审计 Actor（谁执行了这次写操作）。
 *
 * 过渡语义（README「已知缺口」）：identity Principal 目前不带 agent 标记，按编制席位推导——
 * H* / user 为人类席位，其余（a* 机器身份等）按 agent 处理。
 * agent 的 model_version 取自 x-model-version 头（A15/A14 调用方携带）：缺失/空白/超长一律
 * 400 拒绝，**不得以 'unknown' 落审计**（写前 fail-fast；契约本要求 agent 必带 model_version）。
 * 待 identity Principal 增加身份种类字段后切换为显式标记。
 */
export function actorFromPrincipal(principal: Principal, modelVersion?: string): Actor {
  const isHumanSeat = /^H[0-9]+$/.test(principal.userId) || principal.userId === 'user';
  if (isHumanSeat) {
    return { kind: 'human', id: principal.userId };
  }
  const normalized = modelVersion?.trim();
  if (normalized === undefined || normalized.length === 0 || normalized.length > 64) {
    throw new DomainError(400, 'validation_failed', {}, [
      {
        path: 'x-model-version',
        code: 'required',
        message: 'agent 主体必须携带 x-model-version（不得以 unknown 落审计）。',
      },
    ]);
  }
  return { kind: 'agent', id: principal.userId, model_version: normalized };
}
