/**
 * AI 文本位的唯一渲染通道（INF-07）。
 *
 * 规则：模型生成文本只能经由本组件出现，且必须同时携带服务端注入的
 * `label`（AI 生成标识）与 `disclaimer`（免责）。三者是同一个联合类型，
 * 想只渲染文本而不渲染标识，在类型层面就写不出来。
 *
 * 第 1 批 AI 文本尚未接入：调用方传 `null`，这里渲染「AI 解读待接入」占位，
 * 不展示任何「像 AI 的话」（lead 验收红线：不得放假 AI 文案）。
 */
import { copy } from '../lib/copy';
import { AiGeneratedBadge } from './AiGeneratedBadge';

export interface AiGeneratedContent {
  text: string;
  label: string;
  disclaimer: string;
}

export interface AiTextSlotProps {
  content: AiGeneratedContent | null;
}

export function AiTextSlot({ content }: AiTextSlotProps) {
  if (content === null) {
    return (
      <p className="ai-slot ai-slot--pending">{copy.ai.pendingText}</p>
    );
  }
  return (
    <div className="ai-slot">
      <AiGeneratedBadge label={content.label} disclaimer={content.disclaimer} />
      <p className="ai-slot__text">{content.text}</p>
    </div>
  );
}
