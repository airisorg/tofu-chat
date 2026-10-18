import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { NextRequest } from 'next/server';
import { proxy } from '../src/proxy';
import { contentSecurityPolicy } from '../src/lib/security-headers';
import { databaseTls } from '../src/lib/database-tls';
import { uploadAttachments } from '../src/lib/media-upload';
import { audioDataUrlBytes } from '../src/lib/audio-bytes';
import {
  apiError,
  attachmentResponse,
  ChatError,
  publicConfig,
  readActionBody,
} from '../src/lib/server';
import { GET as configGet } from '../src/app/api/config/route';
import { GET as chatGet, POST as chatPost } from '../src/app/api/chat/route';
import type { ChatAction } from '../src/lib/types';

function environment(t: TestContext, values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('config handler preserves public fallback settings and hides malformed deployment values', (t) => {
  environment(t, {
    SUPABASE_URL: undefined,
    SUPABASE_ANON_KEY: undefined,
    NEXT_PUBLIC_SUPABASE_URL: 'https://identity.fixture.invalid/project/',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_fixture',
    DATABASE_URL: undefined,
    TOFU_AUTH_BROKER_URL: undefined,
  });
  const response = configGet();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type')!, /^application\/json/);
  assert.deepEqual(publicConfig(), {
    authBrokerUrl: 'https://oauth.trytofu.ai',
    supabaseUrl: 'https://identity.fixture.invalid/project',
    supabaseAnonKey: 'sb_publishable_fixture',
    databaseConfigured: false,
  });
  process.env.SUPABASE_URL = 'this is not a URL';
  assert.deepEqual(publicConfig(), {
    authBrokerUrl: 'https://oauth.trytofu.ai',
    supabaseUrl: '',
    supabaseAnonKey: '',
    databaseConfigured: false,
  });
  process.env.SUPABASE_URL = 'https://identity.fixture.invalid';
  process.env.SUPABASE_ANON_KEY = 'malformed-public-key';
  assert.equal(publicConfig().supabaseAnonKey, '');
});

test('config reads the broker origin at runtime and never publishes an invalid setting', async (t) => {
  environment(t, { TOFU_AUTH_BROKER_URL: undefined });
  assert.equal((await configGet().json()).authBrokerUrl, 'https://oauth.trytofu.ai');
  process.env.TOFU_AUTH_BROKER_URL = 'https://oauth-autopush.trytofu.ai/';
  assert.equal((await configGet().json()).authBrokerUrl, 'https://oauth-autopush.trytofu.ai');
  for (const value of [
    '',
    'not a URL',
    'http://oauth-autopush.trytofu.ai',
    'https://user:private@oauth-autopush.trytofu.ai',
    'https://oauth-autopush.trytofu.ai:444',
    'https://oauth-autopush.trytofu.ai/start',
    'https://oauth-autopush.trytofu.ai?private=1',
    'https://oauth-autopush.trytofu.ai#private',
  ]) {
    process.env.TOFU_AUTH_BROKER_URL = value;
    assert.equal((await configGet().json()).authBrokerUrl, '', value);
  }
});

test('chat handlers reject unconfigured, unsigned and foreign-origin requests without database access', async (t) => {
  environment(t, {
    SUPABASE_URL: undefined,
    SUPABASE_ANON_KEY: undefined,
    NEXT_PUBLIC_SUPABASE_URL: undefined,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
    DATABASE_URL: undefined,
  });
  const unconfigured = await chatGet(new Request('https://chat.fixture.invalid/api/chat'));
  assert.equal(unconfigured.status, 503);
  assert.deepEqual(await unconfigured.json(), { error: 'Google sign-in is not connected yet.' });
  process.env.SUPABASE_URL = 'https://identity.fixture.invalid';
  process.env.SUPABASE_ANON_KEY = 'sb_publishable_fixture';
  const unsigned = await chatGet(new Request('https://chat.fixture.invalid/api/chat'));
  assert.equal(unsigned.status, 401);
  const foreign = await chatPost(
    new Request('https://chat.fixture.invalid/api/chat', {
      method: 'POST',
      headers: { Origin: 'https://outside.fixture.invalid' },
      body: '{}',
    }),
  );
  assert.equal(foreign.status, 403);
  const sameOrigin = await chatPost(
    new Request('https://chat.fixture.invalid/api/chat', {
      method: 'POST',
      headers: { Origin: 'https://chat.fixture.invalid' },
      body: '{}',
    }),
  );
  assert.equal(sameOrigin.status, 401);
  for (const response of [unconfigured, unsigned, foreign, sameOrigin])
    assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('verified handler identity reaches the explicit missing-database failure without exposing internals', async (t) => {
  environment(t, {
    SUPABASE_URL: 'https://identity.fixture.invalid',
    SUPABASE_ANON_KEY: 'sb_publishable_fixture',
    NEXT_PUBLIC_SUPABASE_URL: undefined,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
    DATABASE_URL: undefined,
  });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    assert.equal(String(input), 'https://identity.fixture.invalid/auth/v1/user');
    calls++;
    return Response.json({
      id: crypto.randomUUID(),
      email: 'verified@fixture.invalid',
      email_confirmed_at: '2026-10-05T00:00:00Z',
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
      created_at: '2026-10-05T00:00:00Z',
    });
  });
  const response = await chatGet(
    new Request('https://chat.fixture.invalid/api/chat', {
      headers: { Authorization: `Bearer ${'x'.repeat(40)}` },
    }),
  );
  assert.equal(calls, 1);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'The chat database is not connected yet.' });
  const internal = apiError(new Error('internal-diagnostic-marker'));
  assert.equal(internal.status, 503);
  assert.equal(
    await internal.text(),
    '{"error":"Chat is temporarily unavailable. Please try again."}',
  );
  const quota = apiError(new ChatError('Retry later.', 429));
  assert.equal(quota.status, 429);
  assert.deepEqual(await quota.json(), { error: 'Retry later.' });
});

test('JSON body accepts exact byte limits and cancels an oversized stream before further reads', async () => {
  const exact = new Request('https://chat.fixture.invalid/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"x":"é"}',
  });
  const size = Buffer.byteLength('{"x":"é"}');
  assert.deepEqual(await readActionBody(exact, size), { x: 'é' });
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(size + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const streamed = new Request('https://chat.fixture.invalid/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: string });
  await assert.rejects(
    readActionBody(streamed, size),
    (error: unknown) => error instanceof ChatError && error.status === 413,
  );
  assert.equal(cancelled, true);
  await assert.rejects(
    readActionBody(
      new Request('https://chat.fixture.invalid/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
    (error: unknown) => error instanceof ChatError && error.status === 400,
  );
});

test('private attachment streams preserve byte headers, encode filenames and honor cancellation', async () => {
  const bytes = Buffer.alloc(130_000, 31);
  const response = attachmentResponse(
    { name: "reader's (copy).txt", type: 'text/plain', size: bytes.length, url: '' },
    bytes,
  );
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(response.headers.get('vary'), 'Authorization');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-disposition')!, /reader%27s%20%28copy%29\.txt/);
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(first.value?.byteLength, 64 * 1024);
  assert.deepEqual(Buffer.from(first.value!), bytes.subarray(0, 64 * 1024));
  await reader.cancel();
  assert.equal((await reader.read()).done, true);
});

test('proxy gives each request a fresh forwarded nonce and production CSP has no development privileges', (t) => {
  environment(t, {
    NODE_ENV: 'production',
    SUPABASE_URL: undefined,
    NEXT_PUBLIC_SUPABASE_URL: 'https://identity.fixture.invalid',
  });
  const first = proxy(new NextRequest('https://chat.fixture.invalid/'));
  const second = proxy(new NextRequest('https://chat.fixture.invalid/'));
  const firstNonce = first.headers.get('x-middleware-request-x-nonce');
  assert.ok(firstNonce);
  assert.notEqual(firstNonce, second.headers.get('x-middleware-request-x-nonce'));
  assert.match(first.headers.get('content-security-policy')!, new RegExp(`nonce-${firstNonce}`));
  assert.doesNotMatch(first.headers.get('content-security-policy')!, /unsafe-eval/);
  assert.equal(
    first.headers.get('x-middleware-request-content-security-policy'),
    first.headers.get('content-security-policy'),
  );
  const local = contentSecurityPolicy('fixture-nonce', undefined, true);
  assert.match(local, /'unsafe-eval'/);
  assert.match(local, /connect-src 'self' https: ws:/);
  assert.equal(
    contentSecurityPolicy('fixture-nonce', 'invalid')
      .split('; ')
      .find((rule) => rule.startsWith('connect-src')),
    "connect-src 'self'",
  );
});

test('database TLS rejects a malformed PEM certificate and a non-database URL without printing input', () => {
  for (const url of ['https://db.fixture.invalid', 'not-a-url'])
    assert.throws(
      () => databaseTls(url, { NODE_ENV: 'production' }),
      /connection settings are invalid/,
    );
  assert.throws(
    () =>
      databaseTls('postgres://db.fixture.invalid/example', {
        NODE_ENV: 'production',
        DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'The configured database CA must be valid PEM CA certificates.',
  );
});

test('media upload preconditions reject damaged drafts before posting any chunk', async () => {
  const base: Extract<ChatAction, { type: 'send' }> = {
    type: 'send',
    conversationId: crypto.randomUUID(),
    text: '',
    clientMessageId: crypto.randomUUID(),
    attachments: [
      { name: 'a.txt', type: 'text/plain', size: 1, url: 'data:text/plain;base64,YQ==' },
    ],
  };
  let chunks = 0;
  const post = async () => {
    chunks++;
  };
  const signal = new AbortController().signal;
  const noFiles = { ...base, attachments: [] };
  assert.equal(
    await uploadAttachments(noFiles, post, signal),
    noFiles,
    'a text-only send bypasses binary transport unchanged',
  );
  for (const action of [
    { ...base, clientMessageId: undefined },
    { ...base, attachments: Array(4).fill(base.attachments![0]) },
    { ...base, attachments: [{ ...base.attachments![0], size: 0 }] },
    {
      ...base,
      attachments: [{ ...base.attachments![0], url: 'https://outside.fixture.invalid/file' }],
    },
    { ...base, attachments: [{ ...base.attachments![0], url: 'data:text/plain;base64,!!!!' }] },
    { ...base, attachments: [{ ...base.attachments![0], size: 3 }] },
  ])
    await assert.rejects(uploadAttachments(action, post, signal));
  const aborted = new AbortController();
  aborted.abort(new Error('Fixture cancelled'));
  await assert.rejects(uploadAttachments(base, post, aborted.signal), /Fixture cancelled/);
  assert.equal(chunks, 0);
});

test('waveform decoder fails closed if the platform base64 decoder is unavailable', (t) => {
  t.mock.method(globalThis, 'atob', () => {
    throw new Error('Synthetic decoder failure');
  });
  assert.equal(audioDataUrlBytes('data:audio/wav;base64,YQ=='), null);
});
