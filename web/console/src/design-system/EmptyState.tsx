import { TESTIDS } from '../lib/testids';

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="c-empty" data-testid={TESTIDS.emptyState}>
      <div>{title}</div>
      {hint ? <div className="c-muted">{hint}</div> : null}
    </div>
  );
}
