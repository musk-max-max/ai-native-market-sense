import { hashCanonicalJson } from "./canonical.js";
import type { Audience, OutputClass } from "./types.js";

/** 审计用输入证据项（API 取数层提供；只含 id/text/numbers，不含未引用证据）。 */
export interface AuditEvidenceItem {
  id: string;
  text: string;
  numbers?: number[];
}

export interface AuditInputEvidence {
  kind: string;
  audience: Audience;
  /** 数据业务时点（ISO-8601 UTC）。 */
  asOf: string;
  /** 本轮模型实际可见的证据集；按 id 排序后再哈希，保证跨调用稳定。 */
  evidence: AuditEvidenceItem[];
}

/**
 * `audit.ai_generation_events.input_evidence_hash` 的 canonical 规则：
 * sha256( canonicalJson({ kind, audience, as_of, evidence:[{id,text,numbers?}] }) )，
 * evidence 按 id 字典序排序。A3 写入、A16 复核都调用本函数，禁止各自序列化。
 */
export function computeInputEvidenceHash(input: AuditInputEvidence): string {
  const evidence = [...input.evidence]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((item) => ({
      id: item.id,
      text: item.text,
      ...(item.numbers === undefined ? {} : { numbers: item.numbers }),
    }));
  return hashCanonicalJson({
    kind: input.kind,
    audience: input.audience,
    as_of: input.asOf,
    evidence,
  });
}

export interface AuditOutputClaim {
  text: string;
  /** P2 判定为 class_missing 时模型确实未给出 class，用 null 如实记录，不得用真实白名单类占位。 */
  class: OutputClass | null;
  evidence_ids: string[];
}

/**
 * `audit.ai_generation_events.output_hash` 的 canonical 规则：
 * sha256( canonicalJson({ claims:[{text,class,evidence_ids}] }) )。
 * claims 为经 P2–P6 后的最终 claim 文本（P6 改写后的文本），保持输出顺序；
 * blocked 时仍哈希被阻断的候选 claim，而不是降级卡。P7 copy 版本由 content_version 记录。
 */
export function computeOutputHash(claims: AuditOutputClaim[]): string {
  return hashCanonicalJson({
    claims: claims.map((claim) => ({
      text: claim.text,
      class: claim.class,
      evidence_ids: [...claim.evidence_ids],
    })),
  });
}

/**
 * 阻断事件 `blocked_draft` 的哈希（H2 ADR-007 P5/P6 执行条件）：
 * sha256( canonicalJson(被阻断的完整 draft) )。decision=blocked 时
 * `output_hash` 必须使用该值，保证 P8 模型输出 hash 与 P5 原文 hash
 * 指向同一份 draft；`blocked_draft` 只落 audit.ai_generation_events 受限列。
 */
export function computeBlockedDraftHash(draft: unknown): string {
  return hashCanonicalJson(draft);
}
