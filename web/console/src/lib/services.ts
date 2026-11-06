import type { ApprovalServicePort, AuditPort, ConfigServicePort } from '../mocks/ports';

/**
 * 页面依赖的服务集合。
 * 当前由 MockBackend 实现；TODO(A8/A0)：契约落地后由 HTTP 适配器实现同一个接口。
 */
export interface ConsoleServices extends ConfigServicePort, ApprovalServicePort, AuditPort {}
