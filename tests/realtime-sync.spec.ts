import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page, type WebSocketRoute } from './coverage-test';
import { localBaseUrl } from './browser-config';
import type { ChatState, Message, Person } from '../src/lib/types';

// The actual auth/realtime SDK and boot hook consume synthetic sessions and
// Phoenix v2 frames. This isolates client invalidation, not hosted delivery/RLS.
const appOrigin = new URL(localBaseUrl()).origin;
const provider = 'https://realtime-fixture.invalid';
const groupId = '00000000-0000-4000-8000-000000000030';
const people: Person[] = [
  {
    id: '00000000-0000-4000-8000-000000000011',
    name: 'Realtime One',
    email: 'one@example.invalid',
    color: '#1967d2',
  },
  {
    id: '00000000-0000-4000-8000-000000000022',
    name: 'Realtime Two',
    email: 'two@example.invalid',
    color: '#b06c49',
  },
];
type Frame = [string | null, string | null, string, string, Record<string, unknown>];
type Subscription = {
  socket: WebSocketRoute;
  join: Frame;
  filter: Record<string, unknown>;
  left: boolean;
};

function workspace() {
  const messages: Message[] = [];
  return {
    messages,
    append(author: Person, text: string, id = randomUUID()) {
      messages.push({
        id,
        conversationId: groupId,
        author,
        text,
        attachments: [],
        reactions: [],
        createdAt: new Date().toISOString(),
      });
      return id;
    },
    state(user: Person): ChatState {
      return structuredClone({
        user,
        messages,
        conversations: [
          {
            id: groupId,
            name: 'Realtime group',
            kind: 'space',
            members: people,
            unread: 0,
            updatedAt: new Date().toISOString(),
          },
        ],
      });
    },
  };
}

async function connect(browser: Browser, person: Person, shared: ReturnType<typeof workspace>) {
  const context = await browser.newContext({
    baseURL: appOrigin,
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  await page.clock.install();
  const now = Math.floor(Date.now() / 1000);
  const user = {
    ...person,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: person.name },
    created_at: new Date().toISOString(),
    email_confirmed_at: new Date().toISOString(),
  };
  const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: person.id, exp: now + 3600, iat: now, aud: 'authenticated', role: 'authenticated' })).toString('base64url')}.INVALID_LOCAL_SIGNATURE`;
  await context.addInitScript(
    ({ user, token, now }) => {
      localStorage.setItem(
        'relay-chat-auth-v1',
        JSON.stringify({
          user,
          access_token: token,
          refresh_token: 'SYNTHETIC_NOT_REAL',
          expires_at: now + 3600,
          expires_in: 3600,
          token_type: 'bearer',
        }),
      );
    },
    { user, token, now },
  );
  const subscriptions: Subscription[] = [];
  let gets = 0;
  let holdNext = false;
  let held: (() => Promise<void>) | null = null;
  await page.routeWebSocket(`${provider.replace('https:', 'wss:')}/**`, (socket) => {
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      const [joinRef, ref, topic, event, payload] = frame;
      if (event === 'phx_join') {
        const config = payload.config as { postgres_changes: Record<string, unknown>[] };
        const filter = config.postgres_changes[0];
        subscriptions.push({ socket, join: frame, filter, left: false });
        socket.send(
          JSON.stringify([
            joinRef,
            ref,
            topic,
            'phx_reply',
            { status: 'ok', response: { postgres_changes: [{ ...filter, id: 1 }] } },
          ]),
        );
      } else if (event === 'phx_leave') {
        for (const subscription of subscriptions)
          if (subscription.socket === socket) subscription.left = true;
        socket.send(
          JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]),
        );
      } else if (event === 'heartbeat') {
        socket.send(
          JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]),
        );
      }
    });
  });
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === provider) {
      if (url.pathname === '/auth/v1/user') return route.fulfill({ json: user });
      if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204 });
      return route.abort('blockedbyclient');
    }
    if (url.origin !== appOrigin) return route.abort('blockedbyclient');
    if (url.pathname === '/api/config')
      return route.fulfill({
        json: {
          supabaseUrl: provider,
          supabaseAnonKey: 'sb_publishable_SYNTHETIC',
          databaseConfigured: true,
          signInUrl: 'https://sign-in.example.test/start',
        },
      });
    if (url.pathname !== '/api/chat') return route.continue();
    if (request.headers().authorization !== `Bearer ${token}`)
      return route.fulfill({ status: 401, json: { error: 'Synthetic identity required.' } });
    if (request.method() === 'GET') {
      gets++;
      const state = shared.state(person);
      if (holdNext) {
        holdNext = false;
        held = async () => {
          await route.fulfill({ json: { state } });
        };
        return;
      }
      return route.fulfill({ json: { state } });
    }
    const action = request.postDataJSON();
    const id =
      action.type === 'send'
        ? shared.append(person, action.text, action.clientMessageId)
        : undefined;
    return route.fulfill({ json: { state: shared.state(person), id } });
  });
  await page.goto('/');
  await page
    .getByRole('complementary', { name: 'Chat navigation' })
    .getByRole('button', { name: 'Realtime group', exact: true })
    .click();
  await expect(
    page.getByRole('main').getByRole('heading', { name: 'Realtime group', exact: true }),
  ).toBeVisible();
  await expect.poll(() => subscriptions.length).toBe(1);
  expect(subscriptions[0].filter).toEqual({
    event: 'INSERT',
    schema: 'relay',
    table: 'events',
    filter: `user_id=eq.${person.id}`,
  });
  // Freeze the three-second poll; subsequent refetches must come from socket events.
  // Derive the pause target from the browser clock. Instrumentation can make
  // setup slower than the host clock, so a host Date may already be in its past.
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
  return {
    page,
    context,
    subscriptions,
    get count() {
      return gets;
    },
    hold() {
      holdNext = true;
    },
    async release() {
      expect(held).not.toBeNull();
      const release = held!;
      held = null;
      await release();
    },
    notify() {
      const subscription = subscriptions.at(-1)!;
      const [joinRef, , topic] = subscription.join;
      subscription.socket.send(
        JSON.stringify([
          joinRef,
          null,
          topic,
          'postgres_changes',
          {
            ids: [1],
            data: {
              schema: 'relay',
              table: 'events',
              type: 'INSERT',
              commit_timestamp: new Date().toISOString(),
              columns: [{ name: 'user_id', type: 'uuid' }],
              record: { user_id: person.id },
              old_record: {},
              errors: [],
            },
          },
        ]),
      );
    },
  };
}

const composer = (page: Page) =>
  page.getByRole('main').getByRole('textbox', { name: 'Message', exact: true });

test('two independent accounts receive group invalidations with polling paused and retain local drafts', async ({
  browser,
}) => {
  const shared = workspace();
  const first = await connect(browser, people[0], shared);
  const second = await connect(browser, people[1], shared);
  try {
    await composer(second.page).fill('Private unsent draft');
    await composer(first.page).fill('Group delivery through the client subscription');
    await first.page
      .getByRole('main')
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      first.page
        .getByRole('article')
        .filter({ hasText: 'Group delivery through the client subscription' }),
    ).toBeVisible();
    const before = second.count;
    // A short driver-side observation cannot advance the paused browser poll.
    // Establish that the peer has not refreshed before its notification.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(second.count).toBe(before);
    await expect(
      second.page
        .getByRole('article')
        .filter({ hasText: 'Group delivery through the client subscription' }),
    ).toHaveCount(0);
    second.notify();
    await expect(
      second.page
        .getByRole('article')
        .filter({ hasText: 'Group delivery through the client subscription' }),
    ).toBeVisible();
    expect(second.count).toBe(before + 1);
    await expect(composer(second.page)).toHaveValue('Private unsent draft');
    expect(shared.messages).toHaveLength(1);
    expect(shared.messages[0].author.id).toBe(people[0].id);
    await second.page.getByRole('button', { name: 'Your profile', exact: true }).first().click();
    await second.page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(
      second.page.getByRole('button', { name: 'Continue with Google', exact: true }),
    ).toBeVisible();
    await expect.poll(() => second.subscriptions[0].left).toBe(true);
    await expect(second.page.getByText('Private unsent draft', { exact: true })).toHaveCount(0);
    await expect(
      first.page
        .getByRole('article')
        .filter({ hasText: 'Group delivery through the client subscription' }),
    ).toBeVisible();
  } finally {
    try {
      await first.context.close();
    } finally {
      await second.context.close();
    }
  }
});

test('an invalidation during a held refresh schedules a second refresh instead of dropping the peer update', async ({
  browser,
}) => {
  const shared = workspace();
  const client = await connect(browser, people[0], shared);
  try {
    await composer(client.page).fill('Draft survives both revisions');
    const before = client.count;
    shared.append(people[1], 'First peer revision');
    client.hold();
    client.notify();
    await expect.poll(() => client.count).toBe(before + 1);
    shared.append(people[1], 'Second peer revision');
    client.notify();
    await client.release();
    await expect(
      client.page.getByRole('article').filter({ hasText: 'Second peer revision' }),
    ).toBeVisible();
    await expect(
      client.page.getByRole('article').filter({ hasText: 'First peer revision' }),
    ).toBeVisible();
    expect(client.count).toBe(before + 2);
    await expect(composer(client.page)).toHaveValue('Draft survives both revisions');
  } finally {
    await client.context.close();
  }
});
