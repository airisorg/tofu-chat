import { build } from 'esbuild';
import { resolve } from 'node:path';
import { expect, test, type Page } from './coverage-test';
import { componentCoveragePlugins } from './component-bundle';
import type { useChat } from '../src/lib/use-chat';
import type { ChatState } from '../src/lib/types';

declare global {
  interface Window {
    lifecycleChat: ReturnType<typeof useChat>;
    lifecycleAborts: string[];
  }
}

// Bundle the actual hook/SDK into a disposable React root. The config, provider
// and API responses use synthetic identities in isolated browser storage. These
// checks establish client cleanup, not real provider/database or device behavior.
let bundle: string;
test.beforeAll(async () => {
  const output = await build({
    plugins: componentCoveragePlugins(),
    stdin: {
      contents: `
        import React, {useEffect, useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {useChat} from './src/lib/use-chat';
        function Hook() {
          const chat = useChat();
          useEffect(() => { window.lifecycleChat = chat; });
          return <output>{JSON.stringify({name:chat.state?.conversations[0]?.name ?? null,
            loading:chat.loading,error:chat.error,authAvailable:chat.authAvailable})}</output>;
        }
        function Fixture() {
          const [mounted, setMounted] = useState(true);
          return <><button onClick={()=>setMounted(false)}>Unmount hook</button>
            <button onClick={()=>setMounted(true)}>Mount hook</button>{mounted && <Hook/>}</>;
        }
        createRoot(document.getElementById('root')).render(<Fixture/>);
      `,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.NEXT_PUBLIC_ENABLE_DEMO': '"false"',
    },
    tsconfig: resolve('tsconfig.json'),
  });
  bundle = output.outputFiles[0].text;
});

async function mount(page: Page) {
  await page.addInitScript(() => {
    window.lifecycleAborts = [];
    const native = window.fetch.bind(window);
    window.fetch = (input, init) => {
      init?.signal?.addEventListener('abort', () => window.lifecycleAborts.push(String(input)), {
        once: true,
      });
      return native(input, init);
    };
  });
  await page.route('**/hook-lifecycle-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><div id="root"></div></body></html>',
    }),
  );
  await page.goto('/hook-lifecycle-fixture');
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole('button', { name: 'Unmount hook', exact: true })).toBeVisible();
}

const view = async (page: Page) => JSON.parse((await page.locator('output').textContent())!);
const unavailable = { supabaseUrl: '', supabaseAnonKey: '', databaseConfigured: false };

test('guest hook refuses writes and unavailable sign-in without inventing a workspace', async ({
  page,
}) => {
  let writes = 0;
  await page.route('**/api/config', (route) => route.fulfill({ json: unavailable }));
  await page.route('**/api/chat', (route) => {
    writes++;
    return route.abort();
  });
  await mount(page);
  await expect.poll(async () => (await view(page)).loading).toBe(false);
  expect(
    await page.evaluate(async () => {
      try {
        await window.lifecycleChat.action({ type: 'profile', name: 'Guest write', status: '' });
      } catch (error) {
        return (error as Error).message;
      }
      return 'unexpected success';
    }),
  ).toBe('Sign in to continue.');
  await page.evaluate(() => window.lifecycleChat.signIn());
  await expect(page.locator('output')).toContainText('Google sign-in is unavailable.');
  await page.evaluate(() => {
    window.lifecycleChat.loadAttachment('missing', 0);
    window.lifecycleChat.retryAttachment('missing', 0);
    window.lifecycleChat.startDemo();
    window.lifecycleChat.clearError();
  });
  await expect
    .poll(() => view(page))
    .toEqual({ name: null, loading: false, error: null, authAvailable: false });
  expect(writes).toBe(0);
});

test('unmount aborts a pending bootstrap and remount recovers after cancellation', async ({
  page,
}) => {
  let release: (() => Promise<void>) | undefined;
  let requests = 0;
  await page.route('**/api/config', (route) => {
    requests++;
    if (requests === 1) {
      release = () => route.fulfill({ json: { error: 'stale bootstrap' } });
      return;
    }
    return route.fulfill({ json: unavailable });
  });
  await mount(page);
  await expect.poll(() => requests).toBe(1);
  await page.getByRole('button', { name: 'Unmount hook', exact: true }).click();
  await expect(page.locator('output')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.lifecycleAborts)).toEqual(['/api/config']);
  await page.getByRole('button', { name: 'Mount hook', exact: true }).click();
  await expect.poll(() => requests).toBe(2);
  await expect.poll(async () => (await view(page)).loading).toBe(false);
  await release!();
  await expect
    .poll(() => view(page))
    .toEqual({ name: null, loading: false, error: null, authAvailable: false });
});

const provider = 'https://hook-lifecycle.invalid';
const userId = '00000000-0000-4000-8000-000000000311';
const conversationId = '00000000-0000-4000-8000-000000000322';
function identity() {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: userId, iat: now, exp: now + 3600, aud: 'authenticated', role: 'authenticated' })).toString('base64url')}.SYNTHETIC_INVALID_SIGNATURE`,
    refresh_token: 'SYNTHETIC_NOT_REAL',
    expires_at: now + 3600,
    expires_in: 3600,
    token_type: 'bearer',
    user: {
      id: userId,
      email: 'lifecycle@example.invalid',
      aud: 'authenticated',
      role: 'authenticated',
      app_metadata: { provider: 'google', providers: ['google'] },
      user_metadata: { full_name: 'Lifecycle user' },
      created_at: new Date().toISOString(),
      email_confirmed_at: new Date().toISOString(),
    },
  };
}
function state(name: string): ChatState {
  const user = {
    id: userId,
    name: 'Lifecycle user',
    email: 'lifecycle@example.invalid',
    color: '#1967d2',
  };
  return {
    user,
    messages: [],
    conversations: [
      {
        id: conversationId,
        name,
        kind: 'space',
        members: [user],
        unread: 0,
        updatedAt: new Date().toISOString(),
      },
    ],
  };
}

async function authenticated(page: Page) {
  const session = identity();
  await page.addInitScript(
    (session) => localStorage.setItem('relay-chat-auth-v1', JSON.stringify(session)),
    session,
  );
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: {
        supabaseUrl: provider,
        supabaseAnonKey: 'sb_publishable_LOCAL_ONLY',
        databaseConfigured: true,
        signInUrl: 'https://sign-in.example.test/start',
      },
    }),
  );
  await page.route(`${provider}/**`, (route) => {
    if (new URL(route.request().url()).pathname === '/auth/v1/user')
      return route.fulfill({ json: session.user });
    return route.fulfill({
      status: 400,
      json: {
        error: 'invalid_grant',
        error_code: 'refresh_token_not_found',
        msg: 'Synthetic refresh token revoked',
      },
    });
  });
  let joins = 0,
    leaves = 0;
  await page.routeWebSocket(`${provider.replace('https:', 'wss:')}/**`, (socket) => {
    socket.onMessage((raw) => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(String(raw));
      if (event === 'phx_join') {
        joins++;
        socket.send(
          JSON.stringify([
            joinRef,
            ref,
            topic,
            'phx_reply',
            {
              status: 'ok',
              response: { postgres_changes: [{ ...payload.config.postgres_changes[0], id: 1 }] },
            },
          ]),
        );
      } else if (event === 'phx_leave') {
        leaves++;
        socket.send(
          JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]),
        );
      } else if (event === 'heartbeat')
        socket.send(
          JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]),
        );
    });
  });
  return {
    get joins() {
      return joins;
    },
    get leaves() {
      return leaves;
    },
  };
}

test('unmount aborts snapshot work, leaves realtime and removes polling and visibility listeners', async ({
  page,
}) => {
  await page.clock.install();
  const channels = await authenticated(page);
  let gets = 0;
  let hold = false;
  let release: (() => Promise<void>) | undefined;
  let currentName = 'Initial mount';
  await page.route('**/api/chat', (route) => {
    gets++;
    const snapshot = state(currentName);
    if (hold) {
      hold = false;
      release = () => route.fulfill({ json: { state: snapshot } });
      return;
    }
    return route.fulfill({ json: { state: snapshot } });
  });
  await mount(page);
  await expect.poll(async () => (await view(page)).name).toBe('Initial mount');
  await expect.poll(() => channels.joins).toBe(1);
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
  const before = gets;
  hold = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => gets).toBe(before + 1);
  await page.getByRole('button', { name: 'Unmount hook', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.lifecycleAborts.filter((path) => path === '/api/chat').length),
    )
    .toBe(1);
  await expect.poll(() => channels.leaves).toBe(1);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(10000);
  expect(gets).toBe(before + 1);
  expect(channels.joins).toBe(1);
  currentName = 'Fresh mount';
  await page.getByRole('button', { name: 'Mount hook', exact: true }).click();
  await expect.poll(async () => (await view(page)).name).toBe('Fresh mount');
  await expect.poll(() => channels.joins).toBe(2);
  await release!();
  expect((await view(page)).name).toBe('Fresh mount');
});

test('revoked refresh session clears private state and remains a guest on later connectivity', async ({
  page,
}) => {
  await page.clock.install();
  await authenticated(page);
  let reject = false,
    gets = 0;
  await page.route('**/api/chat', (route) => {
    gets++;
    return reject
      ? route.fulfill({ status: 401, json: { error: 'Session revoked' } })
      : route.fulfill({ json: { state: state('Private workspace') } });
  });
  await mount(page);
  await expect.poll(async () => (await view(page)).name).toBe('Private workspace');
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
  reject = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await view(page)).name).toBeNull();
  await expect(page.locator('output')).toContainText('Your session expired.');
  expect(await page.evaluate(() => window.lifecycleChat.state)).toBeNull();
  const before = gets;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  // Observe beyond several poll periods; an immediate count can miss an async
  // request incorrectly scheduled by the connectivity callback.
  await page.clock.runFor(10000);
  await expect.poll(() => view(page)).toMatchObject({ name: null, loading: false });
  expect(await page.evaluate(() => window.lifecycleChat.state)).toBeNull();
  expect(gets).toBe(before);
});
