import type { ApprovalServicePort, AuditPort, ConfigServicePort } from '../mocks/ports';

/**
 * 页面依赖的服务集合。
 * 双实现：src/mocks/backend.ts（MockBackend，本地 fallback 默认）+ src/adapters/index.ts（HTTP 适配器，URL ?backend=http 启用）。
 */
export interface ConsoleServices extends ConfigServicePort, ApprovalServicePort, AuditPort {}
