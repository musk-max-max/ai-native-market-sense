/**
 * AI 服务配置（INF-02 骨架）。
 *
 * P0 只读运行期必需项；不引入数据库/队列/外部 provider 密钥。
 * provider 选择与密钥在 INF-03 接入，本骨架固定 FakeProvider。
 */

export type AiLogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface AiConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: AiLogLevel;
  readonly serviceVersion: string;
}

export class AiConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AiConfigError';
  }
}

const LOG_LEVELS: readonly AiLogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 8081;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new AiConfigError(`AI_PORT 不是合法端口：${raw}`);
  }
  return value;
}

function parseLogLevel(raw: string | undefined): AiLogLevel {
  if (raw === undefined || raw === '') {
    return 'info';
  }
  if (!LOG_LEVELS.includes(raw as AiLogLevel)) {
    throw new AiConfigError(`AI_LOG_LEVEL 不是合法级别：${raw}`);
  }
  return raw as AiLogLevel;
}

/** 从环境变量加载配置；非法值快速失败（server 入口在 listen 前捕获并退出）。 */
export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  return {
    host: env.AI_HOST ?? '0.0.0.0',
    port: parsePort(env.AI_PORT),
    logLevel: parseLogLevel(env.AI_LOG_LEVEL),
    serviceVersion: env.AI_SERVICE_VERSION ?? '0.1.0',
  };
}
