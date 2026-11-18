import { useEffect, useState } from 'react';
import { copy, interpolate } from '../../lib/copy';
import { markAttempt, remainingSec } from '../../data/coldThrottle';

interface Props {
  throttleKey: string;
  onRetry: () => void;
}

/**
 * 场景 C 红卡（需求 §4.3）：5xx 等服务端失败——30s 节流倒计时，
 * 明示不影响热字段查看，冷却期内仅手动重试。
 */
export function ColdErrorCard({ throttleKey, onRetry }: Props) {
  const [left, setLeft] = useState(() => remainingSec(throttleKey));

  useEffect(() => {
    if (left <= 0) return;
    const id = window.setInterval(() => setLeft((v) => Math.max(0, v - 1)), 1000);
    return () => window.clearInterval(id);
  }, [left]);

  return (
    <div className="cold-card cold-card--error" data-testid="cold-error-card">
      <p className="cold-card__title">{copy.cold.errorTitle}</p>
      <p className="cold-card__body">{copy.cold.errorBody}</p>
      {left > 0 ? (
        <p className="cold-card__countdown" data-testid="cold-error-countdown">
          {interpolate(copy.cold.timeoutCountdown, { seconds: left })}
        </p>
      ) : null}
      <button
        type="button"
        className="cold-card__retry"
        data-testid="cold-error-retry"
        disabled={left > 0}
        onClick={() => {
          if (left > 0) return;
          markAttempt(throttleKey);
          onRetry();
        }}
      >
        {copy.cold.errorRetryAction}
      </button>
    </div>
  );
}