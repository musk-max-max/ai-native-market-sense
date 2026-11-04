/**
 * L70：事件 payload 键集的唯一真源是 `docs/reference/event-payloads.json`（A5 授权写）。
 *
 * 写入前 fail-closed：按 event_type 取 required 键集，缺键即拒绝 insert（不重试）。
 * 只要求 required 存在，不拒绝额外键（A5 validation_contract.unknown_keys）；
 * 但 A3 自己不写未声明键，避免 A11 的 exact-key 断言变红。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { EntitlementEventRecord } from '../ports/entitlement.js';

export interface EventPayloadFieldSpec {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

export interface EventPayloadSpec {
  readonly new_value: EventPayloadFieldSpec;
  readonly old_value: EventPayloadFieldSpec;
}

export interface EventPayloadContract {
  readonly schema_version: number;
  readonly event_types: Readonly<Record<string, EventPayloadSpec>>;
}

export class EventPayloadContractError extends Error {}

const CANDIDATES = [
  process.env.EVENT_PAYLOADS_PATH,
  // 源码/测试布局：services/market/src/domain → 仓库根
  fileURLToPath(new URL('../../../../docs/reference/event-payloads.json', import.meta.url)),
  // 镜像布局（A0 需把 docs/reference 复制进 runtime；未复制时非 prod 只告警）
  '/app/docs/reference/event-payloads.json',
  'docs/reference/event-payloads.json',
].filter((value): value is string => value !== undefined && value !== '');

function parseContract(text: string, source: string): EventPayloadContract {
  const parsed = JSON.parse(text) as Partial<EventPayloadContract>;
  if (parsed.schema_version !== 1 || parsed.event_types === undefined) {
    throw new EventPayloadContractError(`event-payloads 契约格式非法：${source}`);
  }
  for (const [eventType, spec] of Object.entries(parsed.event_types)) {
    for (const field of ['new_value', 'old_value'] as const) {
      const names = spec[field]?.required;
      if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
        throw new EventPayloadContractError(`event-payloads 契约缺 ${eventType}.${field}.required：${source}`);
      }
    }
  }
  return parsed as EventPayloadContract;
}

/** 读取契约；找不到抛最后一个错误，调用方决定 prod 拒启/非 prod 告警。 */
export function loadEventPayloadContract(): EventPayloadContract {
  const failures: string[] = [];
  for (const path of CANDIDATES) {
    try {
      return parseContract(readFileSync(path, 'utf8'), path);
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new EventPayloadContractError(`event-payloads 契约不可用（L70 fail-closed）：${failures.join(' | ')}`);
}

/** 返回缺失的 required 键（按契约顺序）；未声明的 event_type 视为契约缺项。 */
export function missingRequiredPayloadKeys(
  contract: EventPayloadContract,
  record: EntitlementEventRecord,
): string[] {
  const spec = contract.event_types[record.eventType];
  if (spec === undefined) {
    throw new EventPayloadContractError(`event-payloads 契约缺少 event_type=${record.eventType}`);
  }
  const missing: string[] = [];
  for (const [field, value] of [
    ['new_value', record.newValue],
    ['old_value', record.oldValue],
  ] as const) {
    const required = spec[field].required;
    const bag: Readonly<Record<string, unknown>> = value ?? {};
    for (const key of required) {
      if (!(key in bag)) missing.push(`${field}.${key}`);
    }
  }
  return missing;
}
