/**
 * §3.3 数据集角标：数据集名 + 截止时间（原样 ISO8601）+ 热/冷标记。
 */
import { copy, MISSING } from '../../lib/copy';

interface DatasetLineProps {
  dataset: string;
  asOf: string | null;
  badge: 'hot' | 'cold';
}

export function DatasetLine({ dataset, asOf, badge }: DatasetLineProps) {
  return (
    <p className="theme-dataset" data-testid="theme-dataset">
      <span className="theme-dataset__badge" data-testid="theme-dataset-badge">
        {badge === 'hot' ? copy.dataBadge.hot : copy.dataBadge.cold}
      </span>
      <span className="theme-dataset__text">
        {dataset} · {copy.theme.asOfLabel}: {asOf ?? MISSING}
      </span>
    </p>
  );
}
