import { useEffect, useState } from 'react';
import { copy, interpolate } from '../../lib/copy';
import { markAttempt, remainingSec } from '../../data/coldThrottle';

interface Props {
  /** 服务端 Retry-After 秒数；null 时用默认 60s 冷却。 */
  retryAfterSec: number | null;
  throttleKey: string;
  onRetry: () => void;
}

/**
 * 场景 A 黄卡（需求 §4.3）：429 频控——倒计时内禁用手动重试，且不自动重试；
 * 结束后按钮变「重新加载历史数据」。倒计时 >300s 统一显示 5 分钟。
 */
export function ColdThrottleCard({ retryAfterSec, throttleKey, onRetry }: Props) {
  const [left, setLeft] = useState(() => Math.max(retryAfterSec ?? 60, remainingSec(throttleKey)));

  useEffect(() => {
    if (left <= 0) return;
    const id = window.setInterval(() => setLeft((v) => Math.max(0, v - 1)), 1000);
    return () => window.clearInterval(id);
  }, [left]);

  const countdown =
    left > 300
      ? copy.cold.throttleCountdownMax
      : interpolate(copy.cold.throttleCountdown, { seconds: left });

  return (
    <div className="cold-card cold-card--throttle" data-testid="cold-throttle-card">
      <p className="cold-card__title">{copy.cold.throttleTitle}</p>
      <p className="cold-card__body">{copy.cold.throttleBody}</p>
      {left > 0 ? (
        <p className="cold-card__countdown" data-testid="cold-throttle-countdown">
          {countdown}
        </p>
      ) : null}
      <button
        type="button"
        className="cold-card__retry"
        data-testid="cold-throttle-retry"
        disabled={left > 0}
        onClick={() => {
          if (left > 0) return;
          markAttempt(throttleKey);
          onRetry();
        }}
      >
        {copy.cold.throttleRetryAction}
      </button>
    </div>
  );
}