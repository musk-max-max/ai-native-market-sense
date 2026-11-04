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
      'TRUST_PROXY=true 被禁止：只允许单个 ingress 窄网段（如 10.0.0.0/24 或 /32），否则 IP 桶可被 X-Forwarded-For 伪造绕过',
    );
  }
  if (value.includes(',')) {
    throw new ConfigError(
      'TRUST_PROXY 只接受单个 ingress 窄网段（如 10.0.0.0/24 或 /32）；多段请在 ingress 层收敛后只信任其出口网段',
    );
  }
  validateTrustProxyCidr(value);
  return [value];
}

/**
 * TRUST_PROXY 只允许「单个窄 ingress 网段」：IPv4 /24–/32，IPv6 /64–/128。
 * 宽网段会让客户端伪造 X-Forwarded-For 换限流桶；回环地址会让同机直连也能伪造。
 * 校验在 loadConfig 阶段完成，必须早于 buildApp/listen（Lead m01809 / A19 R4）。
 */
function validateTrustProxyCidr(cidr: string): void {
  if (cidr.includes(':')) {
    const match = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/.exec(cidr);
    if (!match || match[1] === undefined || match[2] === undefined) {
      throw new ConfigError(`TRUST_PROXY 不是合法 CIDR: ${JSON.stringify(cidr)}`);
    }
    const address = match[1].toLowerCase();
    const prefix = Number(match[2]);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) {
      throw new ConfigError(`TRUST_PROXY 前缀长度非法: ${JSON.stringify(cidr)}`);
    }
    if (address === '::' || address === '::1' || address.startsWith('::ffff:127.')) {
      throw new ConfigError(`TRUST_PROXY 不得包含未指定或回环地址: ${JSON.stringify(cidr)}`);
    }
    if (prefix < 64) {
      throw new ConfigError(
        `TRUST_PROXY 网段过宽（/${prefix}）：IPv6 只接受 /64–/128 的 ingress 网段，收到 ${JSON.stringify(cidr)}`,
      );
    }
    return;
  }

  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (!match) {
    throw new ConfigError(`TRUST_PROXY 不是合法 CIDR: ${JSON.stringify(cidr)}`);
  }
  const octets = [match[1], match[2], match[3], match[4]].map((part) => Number(part));
  const prefix = Number(match[5]);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    throw new ConfigError(`TRUST_PROXY 不是合法 IPv4 地址: ${JSON.stringify(cidr)}`);
  }
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new ConfigError(`TRUST_PROXY 前缀长度非法: ${JSON.stringify(cidr)}`);
  }
  if (prefix < 24) {
    throw new ConfigError(
      `TRUST_PROXY 网段过宽（/${prefix}）：只接受 /24–/32 的 ingress 网段（0.0.0.0/0、10.0.0.0/8、192.168.0.0/16 等一律拒绝），收到 ${JSON.stringify(cidr)}`,
    );
  }
  const first = octets[0] as number;
  const second = octets[1] as number;
  if (first === 0) {
    throw new ConfigError(`TRUST_PROXY 不得包含未指定地址: ${JSON.stringify(cidr)}`);
  }
  if (first === 127) {
    throw new ConfigError(`TRUST_PROXY 不得包含回环地址: ${JSON.stringify(cidr)}`);
  }
  if (first === 169 && second === 254) {
    throw new ConfigError(`TRUST_PROXY 不得包含链路本地地址: ${JSON.stringify(cidr)}`);
  }
  if (first >= 224) {
    throw new ConfigError(`TRUST_PROXY 不得包含组播/保留地址: ${JSON.stringify(cidr)}`);
  }
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
