/**
 * 数据缺口卡（重复组件，INF-07）。
 *
 * 作用：显式说明「这块为什么没有数据」，替代 0 / 样例值 / 假 AI 文案。
 *
 * 契约（A12 KD-COPY-REG-01）：
 *  - `data-testid="data-gap-card"`，**必需** `data-gap-key`（业务键，如 valuation / capital-flow）；
 *  - 机器原因码放 `data-gap-code`（受控枚举 GapReason）；
 *  - 可见原因文本带 `data-testid="data-gap-reason"` 与 `data-gap-reason` 属性；
 *  - 禁止调用方传任意说明正文：正文只能来自 copy.gap.reasons（H3 文案单一来源）。
 */
import { copy } from '../lib/copy';
import type { GapReason } from '../lib/copy';
import { TID } from '../lib/testids';

export interface DataGapCardProps {
  /** 缺口的业务键（稳定、语义化，如 valuation / benchmark / risk）。 */
  gapKey: string;
  /** 缺口标题（调用方从 copy.ts 取，用于区分维度）。 */
  title: string;
  /** 受控原因枚举。 */
  reason: GapReason;
}

export function DataGapCard({ gapKey, title, reason }: DataGapCardProps) {
  return (
    <section
      className="gap-card"
      role="note"
      data-testid={TID.dataGapCard}
      data-gap-key={gapKey}
      data-gap-code={reason}
      aria-label={`${copy.gap.title}：${title}`}
    >
      <h3 className="gap-card__title">
        {copy.gap.title} · {title}
      </h3>
      <p className="gap-card__reason" data-testid={TID.dataGapReason} data-gap-reason={reason}>
        {copy.gap.reasons[reason]}
      </p>
    </section>
  );
}
