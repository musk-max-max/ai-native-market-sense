import { Component, type ReactNode } from 'react';
import { copy } from '../../lib/copy';
import type { ColdError } from '../../data/themeGateway';
import { ColdThrottleCard } from './ColdThrottleCard';
import { ColdTimeoutCard } from './ColdTimeoutCard';
import { ColdErrorCard } from './ColdErrorCard';
import { ColdStaleBadge } from './ColdStaleBadge';

interface Props {
  loading: boolean;
  /** null=无错误；有错误且无旧值→按分类渲染黄/灰/红卡。 */
  error: ColdError | null;
  /** 旧值时间戳（stale 回退）：非空时渲染旧值 + 缓存徽标，不渲染错误卡。 */
  cachedAt?: number | null;
  throttleKey: string;
  onRetry: () => void;
  children: ReactNode;
}

interface BoundaryState {
  failed: boolean;
}

/**
 * 错误边界（需求 §4.3 通用要求）：冷数据区渲染异常不得拖垮整页；
 * fallback 用受控文案卡，不暴露堆栈。
 */
export class ColdErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  BoundaryState
> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    if (import.meta.env?.DEV) console.error('[cold] section render failed', error);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * 冷数据四态容器：loading / 429 黄卡 / 超时灰卡 / 错误红卡 / stale 旧值+徽标。
 * 热字段由页面自行渲染，不经此容器（热不阻塞、冷不拖垮）。
 */
export function ColdDataWrapper({
  loading,
  error,
  cachedAt,
  throttleKey,
  onRetry,
  children,
}: Props) {
  const fallback = (
    <div className="cold-card cold-card--error" data-testid="cold-error-card">
      <p className="cold-card__title">{copy.cold.errorTitle}</p>
      <p className="cold-card__body">{copy.cold.errorBody}</p>
    </div>
  );

  if (loading) {
    return (
      <div className="cold-loading" data-testid="cold-loading" aria-busy="true">
        {copy.cold.loading}
      </div>
    );
  }

  if (error !== null && (cachedAt === undefined || cachedAt === null)) {
    if (error.status === 429) {
      return (
        <ColdThrottleCard retryAfterSec={error.retryAfterSec} throttleKey={throttleKey} onRetry={onRetry} />
      );
    }
    if (error.timeout || error.network) {
      return <ColdTimeoutCard throttleKey={throttleKey} onRetry={onRetry} />;
    }
    return <ColdErrorCard throttleKey={throttleKey} onRetry={onRetry} />;
  }

  return (
    <ColdErrorBoundary fallback={fallback}>
      {error !== null ? <ColdStaleBadge cachedAt={cachedAt ?? Date.now()} /> : null}
      {children}
    </ColdErrorBoundary>
  );
}