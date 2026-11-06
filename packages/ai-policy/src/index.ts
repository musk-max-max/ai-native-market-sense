/**
 * @market-sense/ai-policy — AI 内容策略纯函数包（A5 owner，L126）。
 *
 * 无 I/O：不读文件、不访问网络/DB。策略文本由调用方从
 * `rules/ai-content-policy.json` 加载后经 parseAiContentPolicy 校验传入。
 * A3 在线后处理与 A16 离线复核必须调用本包，禁止复制过滤规则。
 */
export * from "./types.js";
export { parseAiContentPolicy, compileAiContentPolicy } from "./policy.js";
export type { CompiledAiContentPolicy } from "./policy.js";
export {
  collectClaims,
  validateStructure,
  bindEvidence,
  checkNumericConsistency,
  filterCompliance,
  qualifyConclusion,
  runAiPolicy,
  extractNumericTokens,
} from "./engine.js";

export { canonicalJson, hashCanonicalJson } from "./canonical.js";
export * from "./audit.js";
export * from "./redline.js";
