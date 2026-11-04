/**
 * 异步状态占位。
 *
 * loading / error 使用 testids.json 中的独立 state id，不复用业务 id，
 * 便于 E2E 断言「先 loading 后内容」而不依赖时序。
 *
 * 合规（H3）：
 *  - 文案全部来自 lib/copy.ts；
 *  - 不渲染内部错误码，也不输出 data-* 内部标识属性；
 *  - 仅可恢复状态（断网 / 429 / 5xx）提供重试入口；403 是确定状态，不给可恢复暗示（H3）。
 */
import type { ErrorCopy } from '../lib/copy';
import { copy } from '../lib/copy';
import { TID } from '../lib/testids';

export function LoadingState() {
  return (
    <div
      className="state state--loading"
      data-testid={TID.loading}
      role="status"
      aria-live="polite"
    >
      <p className="state__title">{copy.states.loadingTitle}</p>
      <div className="skeleton" aria-hidden="true">
        <span className="skeleton__line skeleton__line--lg" />
        <span className="skeleton__line skeleton__line--md" />
        <span className="skeleton__line skeleton__line--sm" />
      </div>
      <p className="state__hint">{copy.states.loadingHint}</p>
    </div>
  );
}

interface ErrorStateProps {
  text: ErrorCopy;
  onRetry?: (() => void) | undefined;
}

export function ErrorState({ text, onRetry }: ErrorStateProps) {
  return (
    <div className="state state--error" data-testid={TID.stockPageError}>
      <div className="error-banner" data-testid={TID.errorBanner} role="alert">
        <p className="error-banner__title">{text.title}</p>
        <p className="error-banner__message">{text.message}</p>
        {onRetry && text.retry !== null && (
          <button type="button" className="error-banner__retry" onClick={onRetry}>
            {text.retry}
          </button>
        )}
      </div>
      <p className="state__hint">{text.hint}</p>
    </div>
  );
}
