/**
 * 配置加载：只做环境变量 → 强类型配置的映射与校验。
 * 不读取业务数据、不连接数据库、不依赖 Fastify。
 */

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface AppConfig {
  /** 服务名，固定值，用于日志与健康检查 */
  readonly serviceName: string;
  /** 版本号，来自 npm_package_version（本地/容器一致） */
  readonly serviceVersion: string;
  /** development | test | production */
  readonly nodeEnv: string;
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  /** Fastify 信任的代理列表（ingress CIDR）。只允许显式 CIDR 列表或 false，禁止 true。 */
  readonly trustProxy: boolean | string[];
  readonly rateLimit: RateLimitConfig;
}

export interface RateLimitConfig {
  /** 单 IP 每分钟配额（令牌桶 refill = ipPerMin / 60 每秒） */
  readonly ipPerMin: number;
  readonly ipBurst: number;
  /** 列表类请求（带 limit/offset）每分钟配额 */
  readonly clusterPerMin: number;
  readonly clusterBurst: number;
  /** Redis 共享计数；缺省则只用本地桶 */
  readonly redisUrl?: string;
  /** Redis 不可用时每副本本地桶配额（绝不放行到 unlimited） */
  readonly redisFallbackPerMin: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  ipPerMin: 60,
  ipBurst: 10,
  clusterPerMin: 600,
  clusterBurst: 10,
  redisFallbackPerMin: 30,
};

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const LOG_LEVELS: ReadonlySet<string> = new Set<LogLevel>([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

const SERVICE_NAME = 'market-sense-api';
const DEFAULT_PORT = 3000;

/**
 * 从环境变量加载配置。非法配置**快速失败**（启动即报错），不静默回退，
 * 避免生产环境因拼写错误跑在错误端口/日志级别上。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV?.trim() || 'development';

  const rawPort = env.PORT?.trim() || String(DEFAULT_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT 必须是 1–65535 的整数，收到: ${JSON.stringify(rawPort)}`);
  }

  const host = env.HOST?.trim() || '0.0.0.0';

  const rawLogLevel = env.LOG_LEVEL?.trim() || 'info';
  if (!LOG_LEVELS.has(rawLogLevel)) {
    throw new ConfigError(
      `LOG_LEVEL 必须是 ${[...LOG_LEVELS].join('|')} 之一，收到: ${JSON.stringify(rawLogLevel)}`,
    );
  }

  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  const rateLimit = parseRateLimit(env);

  return {
    serviceName: SERVICE_NAME,
    serviceVersion: env.npm_package_version?.trim() || '0.1.0',
    nodeEnv,
    host,
    port,
    logLevel: rawLogLevel as LogLevel,
    trustProxy,
    rateLimit,
  };
}

function parseTrustProxy(raw: string | undefined): boolean | string[] {
  const value = raw?.trim();
  if (!value || value === 'false') return false;
  if (value === 'true') {
    throw new ConfigError(
      'TRUST_PROXY=true 被禁止：只允许 ingress CIDR 列表（如 10.0.0.0/8,192.168.0.0/16），否则 IP 桶可被 X-Forwarded-For 伪造绕过',
    );
  }
  const cidrs = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (cidrs.length === 0) throw new ConfigError('TRUST_PROXY 必须是非空 CIDR 列表或 false');
  return cidrs;
}

function parsePositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 1): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(`${key} 必须是 ≥${min} 的整数，收到: ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseRateLimit(env: NodeJS.ProcessEnv): RateLimitConfig {
  const ipPerMin = parsePositiveInt(env, 'RATE_LIMIT_IP_PER_MIN', 60);
  const ipBurst = parsePositiveInt(env, 'RATE_LIMIT_IP_BURST', 10);
  const clusterPerMin = parsePositiveInt(env, 'RATE_LIMIT_CLUSTER_PER_MIN', 600);
  const clusterBurst = parsePositiveInt(env, 'RATE_LIMIT_CLUSTER_BURST', 10);
  const redisFallbackPerMin = parsePositiveInt(env, 'RATE_LIMIT_REDIS_FALLBACK_PER_MIN', 30);
  const redisUrl = env.REDIS_URL?.trim();
  return {
    ipPerMin,
    ipBurst,
    clusterPerMin,
    clusterBurst,
    ...(redisUrl ? { redisUrl } : {}),
    redisFallbackPerMin,
  };
}
