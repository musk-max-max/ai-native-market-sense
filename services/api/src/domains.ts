/**
 * 域插件的唯一装配点。
 *
 * 约定：域插件从各域包导出（如 services/market/src/plugin.ts 的 marketPlugin），
 * 本文件只负责把它们放进数组，不写任何域逻辑。A0 owns 本文件，域交付后由 A0 接线。
 */

import { identityPlugin } from '@market-sense/identity/plugin';

import { aiPlugin } from '../../ai/src/plugin.js';
import { marketPlugin } from '../../market/src/plugin.js';

import type { DomainPlugin } from './plugin.js';

// aiPlugin 接线（AI1，A3 2026-11-06）：按 Lead m00046 转派实现 /v1/ai/* 业务路由；
// 待 H2 复核（本文件 A0 owns）。ai 域 fail-closed：缺 AI_DATABASE_URL 时启动失败（P8 审计硬依赖）。
export const domainPlugins: DomainPlugin[] = [identityPlugin, marketPlugin, aiPlugin];
