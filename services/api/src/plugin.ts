/**
 * 域插件注册契约（A0 定义，A3 等域 owner 实现）。
 *
 * 域插件 = 标准 Fastify plugin + 两个只读元数据字段：
 *   - domain:           域标识，与 contracts/<domain>/ 目录、ownership.yaml 条目一致
 *   - contractVersion:  该域契约版本（可选），启动日志与 /healthz 暴露，便于排障
 *
 * A3 的 services/market 需导出（示例）：
 *   export const marketPlugin: DomainPlugin = Object.assign(
 *     async (app) => { app.get('/instruments/:instrument_id', ...); },
 *     { domain: 'market', contractVersion: '0.2.0' } as const,
 *   );
 *
 * 外壳在 services/api/src/domains.ts 汇总注册；域插件不得自己 listen、不得自己
 * 注册全局错误处理器（外壳已统一），也不得直接 reply.send(problem) —— 抛 HttpProblem。
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export interface DomainPluginOptions {
  /** 挂载前缀，外壳统一传 /v1（契约 servers 路径已含 /v1，插件内路由写相对路径） */
  readonly prefix?: string;
}

export type DomainPlugin = FastifyPluginAsync<DomainPluginOptions> & {
  readonly domain: string;
  readonly contractVersion?: string;
  /**
   * 可选：健康检查贡献者（A3 的 market 用它上报 data_ready/data_ready_reason/data_quality）。
   * 外壳在 /healthz 里逐个 await 并合并结果；单个贡献者失败只跳过，不使健康检查 500。
   */
  readonly health?: () => Promise<Record<string, unknown>>;
};

const DOMAIN_PATTERN = /^[a-z][a-z0-9-]*$/;

export class DomainRegistryError extends Error {
  override readonly name = 'DomainRegistryError';
}

function assertDomainPlugin(plugin: DomainPlugin, index: number): void {
  const domain = (plugin as { domain?: unknown }).domain;
  if (typeof domain !== 'string' || !DOMAIN_PATTERN.test(domain)) {
    throw new DomainRegistryError(
      `domainPlugins[${index}] 缺少合法 domain（小写字母开头，[a-z0-9-]*）`,
    );
  }
  if (typeof plugin !== 'function') {
    throw new DomainRegistryError(`domainPlugins[${index}] (${domain}) 不是 Fastify plugin 函数`);
  }
}

/**
 * 注册全部域插件，返回去重后的域列表（供 /healthz 与启动日志使用）。
 * 重复 domain 直接启动失败：同一域两个插件会导致路由/权限语义不可预测。
 */
export function registerDomainPlugins(
  app: FastifyInstance,
  plugins: readonly DomainPlugin[],
  options: { prefix?: string } = {},
): string[] {
  const prefix = options.prefix ?? '/v1';
  const seen = new Set<string>();

  plugins.forEach((plugin, index) => {
    assertDomainPlugin(plugin, index);
    if (seen.has(plugin.domain)) {
      throw new DomainRegistryError(`重复注册 domain: ${plugin.domain}`);
    }
    seen.add(plugin.domain);
    app.register(plugin, { prefix });
  });

  return [...seen];
}
