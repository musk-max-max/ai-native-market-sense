/**
 * 登录页（/login · Q5-front Phase 2）。
 *
 * 契约（services/identity plugin.ts:148-163）：POST /v1/auth/login，body {email, password}
 * （additionalProperties:false），200 → {token, expires_at}；该路径在 services/api
 * PUBLIC_ROUTES 白名单内，无需 Bearer。写态后用 hasAuthToken() 复核（隐私模式写入
 * 失败时报存储错误并留在本页，避免 401 跳转回环）。
 * next 只接受站内绝对路径（'/' 开头且非 '//'），防 open redirect（Q5 裁定）。
 * 文案全部来自 copy.login.*（compliance 中文扫描只豁免 lib/copy.ts）。
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { hasAuthToken, writeAuthToken } from '../lib/auth';
import { copy } from '../lib/copy';
import { navigate } from '../lib/router';

interface NextTarget {
  target: string;
  invalid: boolean;
}

function readNext(): NextTarget {
  const raw = new URLSearchParams(window.location.search).get('next');
  if (raw === null || raw.length === 0) return { target: '/', invalid: false };
  if (raw.startsWith('/') && !raw.startsWith('//')) return { target: raw, invalid: false };
  return { target: '/', invalid: true };
}

export function LoginPage() {
  const [next] = useState<NextTarget>(readNext);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const trimmedEmail = email.trim();
    if (trimmedEmail.length === 0 || !trimmedEmail.includes('@') || password.length === 0) {
      setError(copy.login.errorValidation);
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        const res = await fetch('/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: trimmedEmail, password }),
        });
        if (res.status === 400 || res.status === 422) {
          setError(copy.login.errorValidation);
          return;
        }
        if (res.status === 401) {
          setError(copy.login.errorInvalid);
          return;
        }
        if (res.status === 403 || res.status === 429 || !res.ok) {
          setError(copy.login.errorForbidden);
          return;
        }
        const body = (await res.json()) as { token?: unknown };
        if (typeof body.token !== 'string' || body.token.trim().length === 0) {
          setError(copy.login.errorForbidden);
          return;
        }
        writeAuthToken(body.token);
        if (!hasAuthToken()) {
          setError(copy.login.errorStorage);
          return;
        }
        navigate(next.target, { replace: true });
      } catch {
        setError(copy.login.errorNetwork);
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="page login-page">
      <section className="card login" aria-labelledby="login-heading">
        <h1 id="login-heading" className="login__title">
          {copy.login.title}
        </h1>
        <p className="login__lede">{copy.login.lede}</p>
        {next.invalid ? (
          <p className="login__notice" role="status">
            {copy.login.nextInvalid}
          </p>
        ) : null}
        <form className="login__form" onSubmit={onSubmit} noValidate>
          <label className="login__label" htmlFor="login-email">
            {copy.login.emailLabel}
          </label>
          <input
            id="login-email"
            className="login__input"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            spellCheck={false}
            data-testid="login-email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              if (error) setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'login-form-error' : undefined}
          />
          <label className="login__label" htmlFor="login-password">
            {copy.login.passwordLabel}
          </label>
          <input
            id="login-password"
            className="login__input"
            name="password"
            type="password"
            autoComplete="current-password"
            data-testid="login-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              if (error) setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'login-form-error' : undefined}
          />
          <button className="login__submit" type="submit" disabled={busy} data-testid="login-submit">
            {busy ? copy.login.submitting : copy.login.submit}
          </button>
          {error ? (
            <p id="login-form-error" className="login__error" role="alert" data-testid="login-error">
              {error}
            </p>
          ) : null}
        </form>
      </section>
    </div>
  );
}
