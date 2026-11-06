import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AiPolicyConfigError,
  parseAiContentPolicy,
  parseRedlineBasis,
  REDLINE_BASIS_EXPECTED_VERSION,
  type AiContentPolicy,
  type RedlineBasis,
} from "@market-sense/ai-policy";

/** 策略单一真源（相对仓库根）。 */
export const AI_CONTENT_POLICY_RELATIVE_PATH = "rules/ai-content-policy.json";

/**
 * 从模块位置推导仓库根（services/compliance/src/*.ts → 仓库根）。
 * 仅供本服务的 I/O loader 使用；packages/ai-policy 保持无 I/O。
 */
export function resolveRepoRoot(startDirectory: string = dirname(fileURLToPath(import.meta.url))): string {
  return resolve(startDirectory, "../../..");
}

/**
 * 只读加载并校验 rules/ai-content-policy.json。
 *
 * fail-closed：文件不可读、JSON 非法、结构/正则非法 → 抛 AiPolicyConfigError。
 * 调用方（A3 在线 / A16 离线）**不得** catch 后回退到“无过滤”；必须阻断请求/样本判红。
 */
export function loadAiContentPolicy(policyPath?: string): AiContentPolicy {
  const file = policyPath ?? resolve(resolveRepoRoot(), AI_CONTENT_POLICY_RELATIVE_PATH);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AiPolicyConfigError(
      "policy_file_unreadable",
      `无法读取 AI 内容策略文件 ${file}：${detail}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AiPolicyConfigError("policy_json_invalid", `AI 内容策略文件不是合法 JSON：${detail}`);
  }

  const sourceSha256 = createHash("sha256").update(raw, "utf8").digest("hex");
  const policy = parseAiContentPolicy(parsed, { sourceSha256 });
  if (policy.canonical_source_of_truth !== AI_CONTENT_POLICY_RELATIVE_PATH) {
    throw new AiPolicyConfigError(
      "canonical_path_mismatch",
      `策略文件 canonical_source_of_truth=${policy.canonical_source_of_truth} 与加载路径 ${AI_CONTENT_POLICY_RELATIVE_PATH} 不一致`,
    );
  }
  return policy;
}

/** 红线依据单一真源（相对仓库根，H3 定义、A5 实现）。 */
export const REDLINE_BASIS_RELATIVE_PATH = "rules/redline-basis.json";

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || process.env.APP_PROFILE === "prod";
}

/**
 * 只读加载并校验 rules/redline-basis.json，并与已加载 policy 做双向一致性校验。
 *
 * fail-closed：文件/JSON 非法 → AiPolicyConfigError；结构/集合/版本/双 sha
 * 不一致 → RedlineBasisError（调用方必须阻断启动/请求，不得回退）。
 * 生产环境要求 redline-basis.signed=true，且 policy 部署文件 sha 必须等于
 * policy 实际加载文件字节的 sha256。
 */
export function loadRedlineBasis(
  policy: AiContentPolicy,
  redlinePath?: string,
): RedlineBasis {
  const file = redlinePath ?? resolve(resolveRepoRoot(), REDLINE_BASIS_RELATIVE_PATH);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AiPolicyConfigError(
      "redline_file_unreadable",
      `无法读取 H3 红线依据文件 ${file}：${detail}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AiPolicyConfigError("redline_json_invalid", `H3 红线依据文件不是合法 JSON：${detail}`);
  }

  const policySourceSha256 = createHash("sha256")
    .update(readFileSync(resolve(resolveRepoRoot(), AI_CONTENT_POLICY_RELATIVE_PATH), "utf8"), "utf8")
    .digest("hex");

  return parseRedlineBasis(parsed, {
    policy,
    expectedVersion: REDLINE_BASIS_EXPECTED_VERSION,
    expectedPolicyDeployedFileSha256: policySourceSha256,
    ...(isProductionRuntime() ? { requireSigned: true } : {}),
  });
}
