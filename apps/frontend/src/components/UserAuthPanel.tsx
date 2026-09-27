import { useEffect, useState } from 'react';

type PublicUser = Readonly<{
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}>;

type AuthResponse = Readonly<{ user: PublicUser }>;

export function UserAuthPanel({
  onAuthenticated,
}: Readonly<{ onAuthenticated(userId: string): void }>) {
  const [mode, setMode] = useState<'register' | 'login'>('register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [user, setUser] = useState<PublicUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void authRequest<{ user: PublicUser }>('/api/v1/auth/me')
      .then(({ user: current }) => {
        setUser(current);
        onAuthenticated(current.id);
      })
      .catch(() => undefined);
  }, [onAuthenticated]);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const result = await authRequest<AuthResponse>(`/api/v1/auth/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          mode === 'register'
            ? { email, password, name }
            : { email, password, deviceLabel: 'Exchange browser console' },
        ),
      });
      setUser(result.user);
      onAuthenticated(result.user.id);
      setPassword('');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Authentication failed');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setError('');
    try {
      await authRequest('/api/v1/auth/logout', {
        method: 'POST',
        headers: { 'x-csrf-token': csrfCookie() },
      });
      setUser(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Logout failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel user-auth-panel" id="user-auth">
      <div className="panel-title-row">
        <div>
          <p className="eyebrow">Human authentication</p>
          <h2>Регистрация и вход пользователя</h2>
          <p className="muted">
            Password никогда не сохраняется в браузере. Backend выдаёт opaque HttpOnly session
            cookie, а изменяющие запросы защищены CSRF-токеном.
          </p>
        </div>
        <span className={`auth-state ${user ? 'authenticated' : ''}`}>
          {user ? 'authenticated' : 'anonymous'}
        </span>
      </div>

      {user ? (
        <div className="authenticated-user">
          <div>
            <strong>{user.name}</strong>
            <span>{user.email}</span>
            <code>{user.id}</code>
          </div>
          <button className="danger" disabled={busy} onClick={logout}>
            Выйти
          </button>
        </div>
      ) : (
        <div className="auth-form">
          <div className="auth-tabs">
            <button
              className={mode === 'register' ? 'active' : ''}
              onClick={() => setMode('register')}
            >
              Регистрация
            </button>
            <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
              Вход
            </button>
          </div>
          {mode === 'register' ? (
            <label>
              Имя
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
          ) : null}
          <label>
            Email
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            Пароль
            <input
              type="password"
              minLength={12}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button
            disabled={busy || !email || !password || (mode === 'register' && !name)}
            onClick={submit}
          >
            {busy ? 'Выполняется…' : mode === 'register' ? 'Создать аккаунт' : 'Войти'}
          </button>
        </div>
      )}
      {error ? <p className="simulation-error">{error}</p> : null}
    </section>
  );
}

async function authRequest<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'include' });
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? String(body.message)
        : `Authentication HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function csrfCookie(): string {
  return (
    document.cookie
      .split(';')
      .map((item) => item.trim())
      .find((item) => item.startsWith('exchange_csrf='))
      ?.slice('exchange_csrf='.length) ?? ''
  );
}
