/**
 * 时间/序列化工具：A 股市场时点统一用 +08:00（契约 SourceRef.as_of 约定）。
 *
 * 注意：行情数据的 as_of/staleness_ms 来自 serving view，本文件只在两类场景使用：
 *   1. 自选（platform 数据）的 as_of = 服务端响应时刻；
 *   2. 降级快照（source=snapshot）时按"响应时刻 − 快照 as_of"重算 staleness。
 */

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Date → `YYYY-MM-DDTHH:mm:ss+08:00`（秒级，A 股行情时点足够） */
export function toCstIso(date: Date): string {
  const shifted = new Date(date.getTime() + CST_OFFSET_MS);
  const iso = shifted.toISOString();
  return `${iso.slice(0, 19)}+08:00`;
}

/** 毫秒差（响应时刻 − 数据时点），钳制 ≥0（时钟偏差不产生负 staleness）。 */
export function stalenessMs(asOf: string, now: Date): number {
  const parsed = Date.parse(asOf);
  if (Number.isNaN(parsed)) {
    throw new Error(`as_of 不是合法时间: ${JSON.stringify(asOf)}`);
  }
  return Math.max(0, Math.trunc(now.getTime() - parsed));
}

/** 校验 serving 行 source 是否符合契约 pattern ^[a-z0-9_.:-]+$（长度 1..64）。 */
export function assertCanonicalSource(source: string): void {
  if (!/^[a-z0-9_.:-]{1,64}$/.test(source)) {
    throw new Error(`serving source 不符合契约 pattern: ${JSON.stringify(source)}`);
  }
}
