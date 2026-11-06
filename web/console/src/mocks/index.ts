export { MockBackend, type MockBackendOptions } from './backend';
export type {
  ApprovalServicePort,
  ApproveInput,
  AuditPort,
  ConfigItemDetail,
  ConfigItemSummary,
  ConfigServicePort,
  ConflictPayload,
  PublishInput,
  RejectInput,
  RollbackInput,
  SaveDraftInput,
  SaveDraftOutcome,
  SubmitApprovalInput,
  ValidationOutcome,
} from './ports';
export { ApprovalAuthorityError, ConfigGateError } from './ports';
