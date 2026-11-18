import { interpolate, copy } from '../../lib/copy';

interface Props {
  cachedAt: number;
  now?: number;
}

/** stale-while-error 徽标：旧值回退时标「X 分钟前缓存」（不静默展示旧数据）。 */
export function ColdStaleBadge({ cachedAt, now = Date.now() }: Props) {
  const minutes = Math.max(1, Math.round((now - cachedAt) / 60000));
  return (
    <p className="cold-stale-badge" data-testid="cold-stale-badge">
      {interpolate(copy.cold.staleBadge, { minutes })}
    </p>
  );
}