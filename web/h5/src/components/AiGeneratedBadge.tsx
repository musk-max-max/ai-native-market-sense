/**
 * AI 生成标识（硬合规组件，INF-07 / ADR-007 D3）。
 *
 * 文案来源：服务端 P7 从 `copy.ts`（A5 版本轴）注入的 `label` / `disclaimer`。
 * 前端**不硬编码、不提供关闭/隐藏开关、不接受样式开关**——因此不存在运营侧关闭标识的路径。
 *
 * 两个字段都是**必填**：
 *  - 只有同时拿到「AI 生成」标识与免责文本，才允许渲染模型生成内容；
 *  - 缺任一字段时调用方必须走「AI 解读待接入」的占位，而不是只渲染文本。
 */
import { TID } from '../lib/testids';

export interface AiGeneratedBadgeProps {
  /** 服务端注入的标识文案，例如「AI 生成 · 仅供参考」（最终文案以 H3 m02666 为准，服务端注入）。 */
  label: string;
  /** 服务端注入的 AI 免责声明（不得由前端拼接）。 */
  disclaimer: string;
}

export function AiGeneratedBadge({ label, disclaimer }: AiGeneratedBadgeProps) {
  return (
    <div className="ai-generated">
      <p className="ai-badge" role="note" data-testid={TID.aiGeneratedBadge}>
        <span className="ai-badge__mark" aria-hidden="true">
          AI
        </span>
        <span className="ai-badge__text">{label}</span>
      </p>
      <p className="ai-disclaimer" data-testid={TID.aiDisclaimer}>
        {disclaimer}
      </p>
    </div>
  );
}
