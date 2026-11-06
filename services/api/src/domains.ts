/**
 * 域插件的唯一装配点。
 *
 * 约定：域插件从各域包导出（如 services/market/src/plugin.ts 的 marketPlugin），
 * 本文件只负责把它们放进数组，不写任何域逻辑。A0 owns 本文件，域交付后由 A0 接线。
 */

import { identityPlugin } from '@market-sense/identity/plugin';

import { marketPlugin } from '../../market/src/plugin.js';

import type { DomainPlugin } from './plugin.js';

export const domainPlugins: DomainPlugin[] = [identityPlugin, marketPlugin];
