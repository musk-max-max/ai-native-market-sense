/**
 * 域插件的唯一装配点。
 *
 * 约定：域插件从各域包导出（如 services/market/src/plugin.ts 的 marketPlugin），
 * 本文件只负责把它们放进数组，不写任何域逻辑。A0 owns 本文件，域交付后由 A0 接线。
 */

import { identityPlugin } from '../../identity/src/plugin.js';
// L156：approval 插件用相对路径导入（同 market），tsc --rootDir=../.. 会把源码编进 dist；
// 包路径 `@market-sense/approval/plugin` 在 pnpm deploy 后的 node_modules 里是 .ts 源码，
// Node 运行时 ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING 拒启（identity 同问题已绕过，见下）。
import { approvalPlugin, configPlugin } from '../../approval/src/plugin.js';

import { aiPlugin } from '../../ai/src/plugin.js';
import { marketPlugin } from '../../market/src/plugin.js';

import type { DomainPlugin } from './plugin.js';

// aiPlugin 接线（AI1，A3 2026-11-06）：按 Lead m00046 转派实现 /v1/ai/* 业务路由；
// 待 H2 复核（本文件 A0 owns）。ai 域 fail-closed：缺 AI_DATABASE_URL 时启动失败（P8 审计硬依赖）。
// approvalPlugin + configPlugin 接线（L154，2026-11-07）：Console P1-6 HTTP adapter smoke 阻塞点；
//   /v1/internal/configs/* + /v1/internal/approvals/* 后端路由已就绪（A4 契约实现），
//   缺失装配导致 Console HTTP backend 一律 404。默认 MemoryDomainStore（无 DATABASE_URL 时），
//   部署侧注入 APPROVAL_DATABASE_URL / OPS_DATABASE_URL 切 Pg 实现（adapters/pg-store.ts）。
export const domainPlugins: DomainPlugin[] = [
  identityPlugin,
  marketPlugin,
  aiPlugin,
  approvalPlugin,
  configPlugin,
];
