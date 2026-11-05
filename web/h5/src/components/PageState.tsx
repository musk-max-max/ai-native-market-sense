/**
 * 通用异步状态块（新页面用）。
 *
 * 与个股页 States 的区别：testid 由调用方传入（A12 为每个页面登记了独立状态 id），
 * 不硬编码 stock-page-*，避免不同页面状态 id 混用。
 *
 * 文案一律来自 copy.ts；错误文案来自 errorCopy(status, network)，不渲染内部错误码。
 */
import type { ReactNode } from 'react';
import type { ErrorCopy } from '../lib/copy';
import { copy } from '../lib/copy';

interface LoadingBlockProps {
  testId: string;
  text: string;
}

export function LoadingBlock({ testId, text }: LoadingBlockProps) {
  return (
    <div className="state state--loading" data-testid={testId} role="status" aria-live="polite">
      <p className="state__title">{text}</p>
      <div className="skeleton" aria-hidden="true">
        <span className="skeleton__line skeleton__line--lg" />
        <span className="skeleton__line skeleton__line--md" />
        <span className="skeleton__line skeleton__line--sm" />
      </div>
    </div>
  );
}

interface ErrorBlockProps {
  testId: string;
  text: ErrorCopy;
  onRetry?: (() => void) | undefined;
}

export function ErrorBlock({ testId, text, onRetry }: ErrorBlockProps) {
  return (
    <div className="state state--error" data-testid={testId}>
      <div className="error-banner" role="alert">
        <p className="error-banner__title">{text.title}</p>
        <p className="error-banner__message">{text.message}</p>
        {onRetry && text.retry !== null ? (
          <button type="button" className="error-banner__retry" onClick={onRetry}>
            {text.retry}
          </button>
        ) : null}
      </div>
      <p className="state__hint">{text.hint}</p>
    </div>
  );
}

interface EmptyBlockProps {
  testId: string;
  title: string;
  hint?: string;
  action?: ReactNode;
}

export function EmptyBlock({ testId, title, hint, action }: EmptyBlockProps) {
  return (
    <div className="state state--empty" data-testid={testId}>
      <p className="state__title">{title}</p>
      {hint ? <p className="state__hint">{hint}</p> : null}
      {action}
      <p className="state__hint">{copy.gap.footnote}</p>
    </div>
  );
}
