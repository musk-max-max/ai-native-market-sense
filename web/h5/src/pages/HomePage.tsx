/**
 * 首页：入口 + 数据口径说明。
 * 首页刻意不展示任何行情数值——P0 只对个股页的数据展示负责，
 * 避免「首页示例数字」被误读为真实行情。
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { copy } from '../lib/copy';
import { Link, navigate, normalizeInstrumentId } from '../lib/router';

const INSTRUMENT_PATTERN = /^[A-Z]{2,6}:\S+$/;

export function HomePage() {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = normalizeInstrumentId(input);
    if (!INSTRUMENT_PATTERN.test(candidate)) {
      setError(copy.home.inputInvalid);
      return;
    }
    setError(null);
    navigate(`/stocks/${encodeURIComponent(candidate)}`);
  };

  return (
    <div className="page home">
      <section className="hero" aria-labelledby="home-heading">
        <p className="hero__eyebrow">{copy.home.eyebrow}</p>
        <h1 id="home-heading" className="hero__title">
          {copy.home.titleLine1}
          <br />
          {copy.home.titleLine2}
        </h1>
        <p className="hero__lede">{copy.home.lede}</p>
      </section>

      <form className="search" onSubmit={onSubmit} noValidate>
        <label className="search__label" htmlFor="instrument-input">
          {copy.home.searchLabel}
        </label>
        <div className="search__row">
          <input
            id="instrument-input"
            className="search__input"
            name="instrument"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder={copy.home.searchPlaceholder}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              if (error) setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'instrument-input-error' : 'instrument-input-hint'}
          />
          <button className="search__submit" type="submit">
            {copy.home.searchSubmit}
          </button>
        </div>
        {error ? (
          <p id="instrument-input-error" className="search__error" role="alert">
            {error}
          </p>
        ) : (
          <p id="instrument-input-hint" className="search__hint">
            {copy.home.inputHint}
          </p>
        )}
      </form>

      <div className="home__links">
        <Link className="home__link" href="/stocks/SSE%3A600519">
          {copy.home.exampleLink}
        </Link>
        <Link className="home__link" href="/watchlist">
          {copy.home.watchlistLink}
        </Link>
        <Link className="home__link" href="/review/portfolio">
          {copy.home.reviewLink}
        </Link>
        <Link className="home__link" href="/review/limits">
          {copy.home.limitLink}
        </Link>
        <Link className="home__link" href="/metrics" data-testid="home-metrics-link">
          {copy.home.metricsLink}
        </Link>
      </div>

      <section className="card home__notes" aria-labelledby="home-notes-heading">
        <h2 id="home-notes-heading" className="card__title">
          {copy.home.notesTitle}
        </h2>
        <ul className="notes">
          {copy.home.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
