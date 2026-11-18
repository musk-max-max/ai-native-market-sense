/**
 * S 层支撑卡（§3.3：4-8 卡、2 列网格）。label/value 全部由调用方从 copy.* 取。
 */

interface MetricCardProps {
  testid: string;
  label: string;
  value: string;
  sub?: string;
}

export function MetricCard({ testid, label, value, sub }: MetricCardProps) {
  return (
    <div className="theme-card" data-testid={testid}>
      <p className="theme-card__label">{label}</p>
      <p className="theme-card__value">{value}</p>
      {sub !== undefined ? <p className="theme-card__sub">{sub}</p> : null}
    </div>
  );
}
