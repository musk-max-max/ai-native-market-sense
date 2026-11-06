/**
 * @market-sense/approval 公共出口（A4）。
 *
 * approval 域（/v1/internal/approvals*，契约 contracts/approval/openapi.yaml）与
 * config 域（/v1/internal/configs* + /v1/internal/releases*，契约 contracts/config/openapi.yaml）。
 * 域插件经 services/api/src/domains.ts 接线（H2/lead 执行），routes 写相对路径（shell 加 /v1 prefix）。
 */

export { approvalPlugin, configPlugin, createApprovalPlugin, createConfigPlugin } from './plugin.js';
export type { ApprovalPluginOptions } from './plugin.js';

export { ApprovalService } from './services/approval-service.js';
export type { ActorContext, ApprovalListFilter } from './services/approval-service.js';
export { ConfigService } from './services/config-service.js';

export { MemoryDomainStore } from './adapters/memory-store.js';
export { PgDomainStore } from './adapters/pg-store.js';
export type { PgDomainStoreOptions } from './adapters/pg-store.js';

export type {
  ApplicationFilter,
  ApprovalAuditEvent,
  ApprovalAuditEventType,
  ConfigFilter,
  DomainStore,
  IdempotentRecord,
  ListResult,
  ReleaseBinding,
  ReleaseFilter,
  StoredConfig,
  StoredRelease,
  StoredVersionRow,
} from './ports/stores.js';

export { evaluate, loadPolicy } from './domain/evaluation.js';
export type { LoadedPolicy, PolicyCategory } from './domain/evaluation.js';
export {
  APPROVAL_EVENT_TYPES,
  DECIDABLE_STATUSES,
  GENESIS_HASH,
  computeEventHash,
  foldStatus,
  lastOfType,
  toContractApplication,
  verifyChain,
} from './domain/ledger.js';
export type { ApprovalEventType, EventDraft, LedgerEvent, StoredApplication } from './domain/ledger.js';
export { DomainError, isDomainError } from './domain/errors.js';
export type { ApprovalReason, ConflictExtras } from './domain/errors.js';
export { threeWayDiff, flatten } from './domain/diff.js';
export { toValidationReport, validateOpsWrite } from './domain/validation.js';
export { actorFromPrincipal } from './domain/types.js';
export type {
  Actor,
  ApprovalApplication,
  ApprovalChange,
  ApprovalDecision,
  ApprovalEvaluation,
  ApprovalEvent,
  ApprovalFlow,
  ApprovalStatus,
  ApprovalSubject,
  Environment,
  OpsConfigDocument,
  OpsConfigWrite,
  Release,
  SubmitRequest,
  ThreeWayDiff,
} from './domain/types.js';
