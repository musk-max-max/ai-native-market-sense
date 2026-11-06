/**
 * AI 文本位的唯一渲染通道（INF-07）。
 *
 * 规则：模型生成文本只能经由本组件出现，且必须同时携带服务端注入的
 * `label`（AI 生成标识）、`disclaimer`（免责）与 `asOf`（AI 响应时点）。
 * 三者是同一个联合类型，想只渲染文本而不渲染标识，在类型层面就写不出来。
 *
 * fail-closed（规格 §3 / N3）：调用方传 `null`，或 `asOf` 缺失/非法
 * （空串或不可解析为时间戳）时，一律回落「待接入」占位——不渲染
 * badge、免责与块内 ai-as-of，防止非法时点驱动任何 AI 区展示。
 *
 * 块内 ai-as-of：`<time>` 原样输出 asOf（不换算不格式化，AC-2），
 * 位于 badge 之后（E2E badgeBeforeAsOf 断言）；块根为 .ai-slot，
 * 与页面级 ai-as-of（AiInterpretation ai-context）各自独立。
 */
import { copy } from '../lib/copy';
import { TID } from '../lib/testids';
import { AiGeneratedBadge } from './AiGeneratedBadge';

export interface AiGeneratedContent {
  text: string;
  label: string;
  disclaimer: string;
  asOf: string;
}

export interface AiTextSlotProps {
  content: AiGeneratedContent | null;
}

/** 时点必须非空且可解析为时间戳（非法/缺失 → fail-closed 到占位）。 */
function isValidAsOf(value: string): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed !== '' && !Number.isNaN(Date.parse(trimmed));
}

export function AiTextSlot({ content }: AiTextSlotProps) {
  if (content === null || !isValidAsOf(content.asOf)) {
    return (
      <p className="ai-slot ai-slot--pending">{copy.ai.pendingText}</p>
    );
  }
  return (
    <div className="ai-slot">
      <AiGeneratedBadge label={content.label} disclaimer={content.disclaimer} />
      <time className="ai-slot__as-of" dateTime={content.asOf} data-testid={TID.aiAsOf}>
        {content.asOf}
      </time>
      <p className="ai-slot__text">{content.text}</p>
    </div>
  );
}
