/**
 * 最近成功快照缓存（进程内，满足 system_prompt 硬规则 #2）：
 *   行情数据源不可用时，返回"最近一次成功快照 + 原始数据时点"，绝不返回空。
 *
 * 为什么是进程内而不是 Redis（must_escalate「新增缓存层」边界）：
 *   P0 这是**降级兜底**而非性能缓存，不新增基础设施、不改变数据语义；命中后响应 meta.source.source
 *   会显式变成 `platform_snapshot`/`platform_degraded`，页面据此展示 stale。Redis 级缓存/预热属架构变更，
 *   需 A0/Lead 批准，本实现不做。
 */

import type { SourceValue } from '@market-sense/api-client';

import type { SourceInfo } from './ports/serving-repo.js';
import { stalenessMs, toCstIso } from './domain/time.js';

interface CacheEntry {
  readonly payload: unknown;
  /** 快照数据时点（用于降级时重算 staleness，而不是沿用旧 staleness） */
  readonly asOf: string;
}

export class SnapshotCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly maxEntries = 500) {}

  get(key: string): { payload: unknown; asOf: string } | undefined {
    const hit = this.entries.get(key);
    return hit === undefined ? undefined : { payload: hit.payload, asOf: hit.asOf };
  }

  set(key: string, payload: unknown, source: SourceInfo): void {
    this.entries.delete(key);
    this.entries.set(key, { payload, asOf: source.asOf });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

interface SourceRef {
  source: SourceValue;
  source_id?: string;
  as_of: string;
  staleness_ms: number;
}

interface MetaWithSource {
  source: SourceRef;
}

/** 与 shared 契约一致：staleness_ms > 15 分钟即 stale，降级来源档位随之变化。 */
const STALE_THRESHOLD_MS = 900_000;

/**
 * 把缓存中的成功响应改写成降级快照：
 *  - data 原样保留（最近成功值）；
 *  - meta.source.source = platform_snapshot（近 15 分钟内）/ platform_degraded（已过期），保留原始 as_of、
 *    按当前时刻重算 staleness_ms；source_id（内部溯源）原样保留；
 *  - entitlement/adjustment/disclaimer 不变。
 */
export function degradePayload<T extends { meta: MetaWithSource }>(payload: T, now: Date): T {
  const clone = structuredClone(payload);
  const previous = clone.meta.source;
  const nextStaleness = stalenessMs(previous.as_of, now);
  clone.meta.source = {
    source: nextStaleness > STALE_THRESHOLD_MS ? 'platform_degraded' : 'platform_snapshot',
    ...(previous.source_id !== undefined ? { source_id: previous.source_id } : {}),
    as_of: previous.as_of,
    staleness_ms: nextStaleness,
  };
  return clone;
}

/** 构造 platform 数据（自选）的 SourceRef：as_of=服务端响应时刻、staleness_ms=0。 */
export function platformSource(now: Date): SourceRef {
  return { source: 'platform_watchlist', as_of: toCstIso(now), staleness_ms: 0 };
}
