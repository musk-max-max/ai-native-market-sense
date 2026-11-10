/**
 * AI 解读聚合列表（B1-04 / backlog P1-5 尾项）。
 *
 * 结构固定：列表容器 + 0..N 个 AiContentBlock；每条 = 一个标的的 AI 解读。
 * 聚合接口未接入前，items 恒为空数组（空态由调用方在页级渲染
 * DataGapCard / aggregateEmpty 文案；本组件不渲染假数据、不摆样例解读）。
 *
 * 合规：组件层不拉接口、不注入文案；调用方接 /v1/ai 聚合域后，逐条
 * AiGeneratedContent 走 AiContentBlock → AiTextSlot 单一通道渲染。
 */
import { AiContentBlock } from './AiContentBlock';
import type { AiGeneratedContent } from './AiTextSlot';

export interface AiAnalysisListProps {
  /** 解读条目集合；空数组 = 聚合接口未接入（页级 DataGapCard 占位）。 */
  items: readonly (AiGeneratedContent | null)[];
}

export function AiAnalysisList({ items }: AiAnalysisListProps) {
  if (items.length === 0) {
    return null;
  }
  return (
    <ul className="ai-analysis-list" aria-label="AI interpretations">
      {items.map((item, index) => (
        <li key={index} className="ai-analysis-list__item">
          <AiContentBlock content={item} />
        </li>
      ))}
    </ul>
  );
}
