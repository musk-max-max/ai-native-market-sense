/**
 * AI 解读条目模板（B1-04 / backlog P1-5 尾项：AiAnalysisList 的单元）。
 *
 * 结构固定：header（badge + as_of + 免责展示位）+ body（文本位）。
 * 数据来源：调用方注入 AiGeneratedContent（text/label/disclaimer/asOf）或 null。
 * null = 尚未拿到聚合接口数据 → AiTextSlot 内部走 fail-closed 占位
 * （不渲染 badge、不渲染 ai-as-of、不渲染免责——防伪造/防非法时点驱动展示）。
 *
 * 合规：本组件不硬编码任何 AI 文案；label/disclaimer 由服务端 P7 注入
 * （AiGeneratedBadge 已强制），文本只经 AiTextSlot 单一渲染通道。
 */
import { AiTextSlot, type AiGeneratedContent } from './AiTextSlot';

export interface AiContentBlockProps {
  /** 模型生成内容（null = 占位）；结构与 AiTextSlot.AiGeneratedContent 同。 */
  content: AiGeneratedContent | null;
}

export function AiContentBlock({ content }: AiContentBlockProps) {
  return (
    <article className="ai-content-block">
      <AiTextSlot content={content} />
    </article>
  );
}
