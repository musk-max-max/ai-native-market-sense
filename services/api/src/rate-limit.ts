/**
 * 限流与分页参数校验（H4/A11 m01043、Lead m01054 ②）。
 *
 * 唯一判定点：所有 /v1/* 请求走同一个 preHandler。
 * - 单 IP 令牌桶：capacity=burst，refill=perMin/60 每秒；
 * - 列表类（带 limit/offset）单独一个桶，默认 600/min；
 * - Redis 共享计数；Redis 不可用时**每副本**降级为 fallbackPerMin/min 的本地桶，绝不放行到 unlimited；
 * - 分页：limit 硬上限 50，>50 直接 400（不 clamp）；offset ≤1000；offset+limit ≤1050；
 *   行情 bars 的 limit 按契约上限 500 校验（它不是全市场列表）。
 * - 429：Retry-After 整数 ≥1 秒、problem+json、code=RATE_LIMITED，文案来自 copy.ts。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';

import type { RateLimitConfig } from './config.js';
import { HttpProblem } from './errors.js';
import { ERROR_TITLES, RATE_LIMITED_DETAIL, VALIDATION_FAILED_DETAIL } from './copy.js';

interface ConsumeResult {
  readonly allowed: boolean;
  /** 仅 allowed=false 时有意义，单位秒 */
  readonly retryAfter: number;
}

interface BucketStore {
  consume(
    key: string,
    capacity: number,
    refillPerSec: number,
    fallbackCapacity?: number,
    fallbackRefillPerSec?: number,
  ): Promise<ConsumeResult>;
  close(): Promise<void>;
}

/** 进程内令牌桶：Redis 未配置或不可用时的兜底，绝不放行到 unlimited。 */
class LocalTokenBucket implements BucketStore {
  private readonly buckets = new Map<string, { tokens: number; ts: number }>();

  async consume(key: string, capacity: number, refillPerSec: number): Promise<ConsumeResult> {
    const now = Date.now() / 1000;
    const bucket = this.buckets.get(key);
    if (bucket === undefined) {
      this.buckets.set(key, { tokens: capacity - 1, ts: now });
      return { allowed: true, retryAfter: 0 };
    }
    const tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.ts) * refillPerSec);
    if (tokens < 1) {
      bucket.tokens = tokens;
      bucket.ts = now;
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((1 - tokens) / refillPerSec)) };
    }
    bucket.tokens = tokens - 1;
    bucket.ts = now;
    return { allowed: true, retryAfter: 0 };
  }

  async close(): Promise<void> {
    this.buckets.clear();
  }
}

const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) + tonumber(t[2]) / 1000000
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end
tokens = math.min(capacity, tokens + math.max(0, now - ts) * refill)
if tokens < 1 then
  redis.call('HSET', key, 'tokens', tokens, 'ts', now)
  redis.call('PEXPIRE', key, math.ceil(capacity / refill * 1000) + 5000)
  return {0, math.ceil((1 - tokens) / refill)}
end
tokens = tokens - 1
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(capacity / refill * 1000) + 5000)
return {1, 0}
`;

class RedisTokenBucket implements BucketStore {
  private readonly redis: Redis;
  private readonly fallback = new LocalTokenBucket();
  private healthy = true;
  private unhealthyUntil = 0;

  constructor(url: string) {
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1000,
      retryStrategy: () => 5000,
    });
    this.redis.on('error', () => {
      this.healthy = false;
      this.unhealthyUntil = Date.now() + 5000;
    });
    this.redis.connect().catch(() => {
      this.healthy = false;
      this.unhealthyUntil = Date.now() + 5000;
    });
  }

  async consume(
    key: string,
    capacity: number,
    refillPerSec: number,
    fallbackCapacity: number,
    fallbackRefillPerSec: number,
  ): Promise<ConsumeResult> {
    if (this.healthy || Date.now() > this.unhealthyUntil) {
      try {
        const result = (await this.redis.eval(
          TOKEN_BUCKET_LUA,
          1,
          key,
          String(capacity),
          String(refillPerSec),
        )) as [number, number];
        this.healthy = true;
        if (result[0] === 1) return { allowed: true, retryAfter: 0 };
        return { allowed: false, retryAfter: Math.max(1, Math.ceil(result[1])) };
      } catch {
        this.healthy = false;
        this.unhealthyUntil = Date.now() + 5000;
      }
    }
    // Redis 不可用：每副本本地桶（30/min 缺省），绝不 unlimited
    return this.fallback.consume(`fallback:${key}`, fallbackCapacity, fallbackRefillPerSec);
  }

  async close(): Promise<void> {
    await this.fallback.close();
    this.redis.disconnect();
  }
}

function isListRequest(path: string, query: unknown): boolean {
  if (path.endsWith('/bars')) return false;
  if (typeof query !== 'object' || query === null) return false;
  const q = query as Record<string, unknown>;
  return q.limit !== undefined || q.offset !== undefined;
}

function parseInteger(raw: unknown, field: string, min: number, max: number): number {
  const value = typeof raw === 'number' ? raw : Number(String(raw));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpProblem(400, 'VALIDATION_ERROR', ERROR_TITLES[400], `${field} 超出允许范围。`);
  }
  return value;
}

/** 分页校验：>50 直接 400，不静默截断；offset 与 total 窗口同样硬限制。 */
function validatePagination(path: string, query: unknown): void {
  if (typeof query !== 'object' || query === null) return;
  const q = query as Record<string, unknown>;
  if (q.limit === undefined && q.offset === undefined) return;
  const isBars = path.endsWith('/bars');
  const limitMax = isBars ? 500 : 50;
  const limit = q.limit === undefined ? 120 : parseInteger(q.limit, 'limit', 1, limitMax);
  const offset = q.offset === undefined ? 0 : parseInteger(q.offset, 'offset', 0, 1000);
  if (!isBars && offset + limit > 1050) {
    throw new HttpProblem(400, 'VALIDATION_ERROR', ERROR_TITLES[400], '分页窗口超出允许范围。');
  }
}

export function installRateLimit(app: FastifyInstance, config: RateLimitConfig): void {
  const store: BucketStore =
    config.redisUrl === undefined ? new LocalTokenBucket() : new RedisTokenBucket(config.redisUrl);
  const fallbackCapacity = config.redisFallbackPerMin;
  const fallbackRefill = config.redisFallbackPerMin / 60;

  app.addHook('preHandler', async (request: FastifyRequest, reply) => {
    if (!request.url.startsWith('/v1/')) return;
    const path = request.url.split('?')[0] ?? request.url;
    validatePagination(path, request.query);

    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    const list = isListRequest(path, request.query);
    const key = list ? `ratelimit:${ip}:list` : `ratelimit:${ip}`;
    // Redis 健康时用配置配额；store 内部不可用时自动切到本地 30/min 桶。
    const capacity = list ? config.clusterBurst : config.ipBurst;
    const refill = list ? config.clusterPerMin / 60 : config.ipPerMin / 60;
    const consume =
      store instanceof RedisTokenBucket
        ? store.consume(key, capacity, refill, fallbackCapacity, fallbackRefill)
        : store.consume(key, capacity, refill);
    const result = await consume;
    if (!result.allowed) {
      reply.header('retry-after', String(Math.max(1, Math.ceil(result.retryAfter))));
      throw new HttpProblem(429, 'RATE_LIMITED', ERROR_TITLES[429], RATE_LIMITED_DETAIL);
    }
  });

  app.addHook('onClose', async () => {
    await store.close();
  });
}
