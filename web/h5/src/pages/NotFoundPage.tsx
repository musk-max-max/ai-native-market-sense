import { copy } from '../lib/copy';
import { Link } from '../lib/router';

export function NotFoundPage() {
  return (
    <div className="page">
      <h1 className="page__title">{copy.notFound.title}</h1>
      <p className="empty-note">{copy.notFound.message}</p>
      <Link href="/">{copy.notFound.back}</Link>
    </div>
  );
}
