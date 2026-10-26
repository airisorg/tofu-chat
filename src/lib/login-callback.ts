/** Bind the broker callback to this tab's explicit sign-in request. */
export const LOGIN_REQUEST_KEY = 'chat-login-request-v1';
export const LOGIN_NONCE_QUERY = 'chat_login_nonce';
export const LOGIN_REQUEST_TTL_MS = 10 * 60 * 1000;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTH_KEYS = [
  'access_token',
  'refresh_token',
  'provider_token',
  'provider_refresh_token',
  'expires_in',
  'expires_at',
  'token_type',
  'type',
  'error',
  'error_description',
  'error_code',
];
type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The host's sign-in start address when it is a plain https URL, else null: the app has no built-in one. */
export function signInStart(configured: unknown): string | null {
  if (typeof configured !== 'string') return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export function beginLogin(returnUrl: string, storage: StorageAccess, now = Date.now()): string {
  const nonce = crypto.randomUUID();
  const record = JSON.stringify({ nonce, createdAt: now });
  storage.setItem(LOGIN_REQUEST_KEY, record);
  if (storage.getItem(LOGIN_REQUEST_KEY) !== record)
    throw new Error('This browser could not save the sign-in request.');
  const callback = new URL(returnUrl);
  callback.searchParams.set(LOGIN_NONCE_QUERY, nonce);
  return callback.href;
}

export function inspectLoginCallback(
  url: URL,
  storage: Pick<Storage, 'getItem'>,
  now = Date.now(),
) {
  const hash = new URLSearchParams(url.hash.slice(1));
  const hasCallback = AUTH_KEYS.some((key) => hash.has(key) || url.searchParams.has(key));
  if (!hasCallback) return { hasCallback: false, accepted: false };
  let accepted = false;
  try {
    const raw = storage.getItem(LOGIN_REQUEST_KEY);
    if (raw && raw.length <= 200) {
      const pending = JSON.parse(raw) as { nonce?: unknown; createdAt?: unknown };
      accepted =
        typeof pending.nonce === 'string' &&
        NONCE.test(pending.nonce) &&
        url.searchParams.get(LOGIN_NONCE_QUERY) === pending.nonce &&
        typeof pending.createdAt === 'number' &&
        Number.isFinite(pending.createdAt) &&
        now >= pending.createdAt &&
        now - pending.createdAt < LOGIN_REQUEST_TTL_MS;
    }
  } catch {
    /* Unavailable or malformed tab storage cannot authorize a callback. */
  }
  return { hasCallback: true, accepted };
}

export function cleanLoginCallback(url: URL): string {
  const clean = new URL(url.href);
  clean.searchParams.delete(LOGIN_NONCE_QUERY);
  for (const key of AUTH_KEYS) clean.searchParams.delete(key);
  const hash = new URLSearchParams(clean.hash.slice(1));
  for (const key of AUTH_KEYS) hash.delete(key);
  clean.hash = hash.toString();
  return clean.pathname + clean.search + clean.hash;
}
