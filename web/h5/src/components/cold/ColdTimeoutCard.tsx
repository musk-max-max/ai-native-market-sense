import { useEffect, useState } from 'react';
import { copy, interpolate } from '../../lib/copy';
import { markAttempt, remainingSec } from '../../data/coldThrottle';

interface Props {
  throttleKey: string;
  onRetry: () => void;
}

/**
 * 场景 B 灰卡（需求 §4.3）：超时/网络失败——30s 客户端节流倒计时，
 * 冷却期内禁用重试、无自动重试，仅手动点击。
 */
export function ColdTimeoutCard({ throttleKey, onRetry }: Props) {
  const [left, setLeft] = useState(() => remainingSec(throttleKey));

  useEffect(() => {
    if (left <= 0) return;
    const id = window.setInterval(() => setLeft((v) => Math.max(0, v - 1)), 1000);
    return () => window.clearInterval(id);
  }, [left]);

  return (
    <div className="cold-card cold-card--timeout" data-testid="cold-timeout-card">
      <p className="cold-card__title">{copy.cold.timeoutTitle}</p>
      <p className="cold-card__body">{copy.cold.timeoutBody}</p>
      {left > 0 ? (
        <p className="cold-card__countdown" data-testid="cold-timeout-countdown">
          {interpolate(copy.cold.timeoutCountdown, { seconds: left })}
        </p>
      ) : null}
      <button
        type="button"
        className="cold-card__retry"
        data-testid="cold-timeout-retry"
        disabled={left > 0}
        onClick={() => {
          if (left > 0) return;
          markAttempt(throttleKey);
          onRetry();
        }}
      >
        {copy.cold.timeoutRetryAction}
      </button>
    </div>
  );
}