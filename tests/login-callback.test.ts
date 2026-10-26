import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginLogin,
  cleanLoginCallback,
  inspectLoginCallback,
  LOGIN_NONCE_QUERY,
  LOGIN_REQUEST_KEY,
  LOGIN_REQUEST_TTL_MS,
  signInStart,
} from '../src/lib/login-callback';
const nonce = '00000000-0000-4000-8000-000000000111',
  now = 1000000;
function storage(record?: unknown) {
  const values = new Map<string, string>();
  if (record !== undefined) values.set(LOGIN_REQUEST_KEY, JSON.stringify(record));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
const url = () =>
  new URL(
    `https://app.example/?join=room&${LOGIN_NONCE_QUERY}=${nonce}#access_token=LOCAL_FAKE&refresh_token=LOCAL_FAKE&expires_in=3600&token_type=bearer`,
  );
test('only a same-tab unexpired exact nonce accepts token callbacks', () => {
  const store = storage({ nonce, createdAt: now });
  assert.deepEqual(inspectLoginCallback(url(), store, now + 100), {
    hasCallback: true,
    accepted: true,
  });
  assert.equal(inspectLoginCallback(url(), storage(), now).accepted, false);
  assert.equal(
    inspectLoginCallback(url(), storage({ nonce: 'other', createdAt: now }), now).accepted,
    false,
  );
});
test('expired and future-dated requests reject', () => {
  assert.equal(
    inspectLoginCallback(url(), storage({ nonce, createdAt: now }), now + LOGIN_REQUEST_TTL_MS)
      .accepted,
    false,
  );
  assert.equal(
    inspectLoginCallback(url(), storage({ nonce, createdAt: now + 1 }), now).accepted,
    false,
  );
});
test('malformed and inaccessible storage rejects without throwing', () => {
  assert.equal(
    inspectLoginCallback(url(), storage({ nonce: 123, createdAt: now }), now).accepted,
    false,
  );
  const store = storage();
  store.getItem = () => {
    throw Error('blocked');
  };
  assert.equal(inspectLoginCallback(url(), store, now).accepted, false);
});
test('callback tokens in query parameters require the same nonce', () => {
  const query = new URL('https://app.example/?access_token=LOCAL_FAKE&refresh_token=LOCAL_FAKE');
  assert.equal(inspectLoginCallback(query, storage(), now).hasCallback, true);
  assert.equal(inspectLoginCallback(query, storage(), now).accepted, false);
});
test('URL cleanup removes provider and session secrets while preserving invitation', () => {
  const value = url();
  value.searchParams.set('provider_token', 'LOCAL_FAKE');
  value.searchParams.set('error_description', 'private');
  assert.equal(cleanLoginCallback(value), '/?join=room');
});
test('normal navigation does not accept callback processing', () => {
  assert.deepEqual(
    inspectLoginCallback(new URL('https://app.example/?join=room'), storage(), now),
    { hasCallback: false, accepted: false },
  );
});
test('sign-in initiation saves a UUID challenge in this tab before returning a URL', () => {
  const store = storage();
  const callback = new URL(beginLogin('https://app.example/', store, now));
  const saved = JSON.parse(store.getItem(LOGIN_REQUEST_KEY)!);
  assert.equal(callback.searchParams.get(LOGIN_NONCE_QUERY), saved.nonce);
  assert.equal(saved.createdAt, now);
  assert.equal(
    inspectLoginCallback(new URL(callback.href + '#access_token=LOCAL_FAKE'), store, now).accepted,
    true,
  );
});
test('sign-in starts only at a configured plain https address', () => {
  assert.equal(signInStart('https://broker.example/start'), 'https://broker.example/start');
  for (const refused of [
    undefined,
    '',
    'not a url',
    'http://broker.example/start',
    'https://user:password@broker.example/start',
    'https://broker.example/start?return=https://evil.example',
    'https://broker.example/start#fragment',
    42,
  ])
    assert.equal(signInStart(refused), null, String(refused));
});
