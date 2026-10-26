import { expect, test, type Locator, type Page } from './coverage-test';
import { createDemoState, DEMO_STORAGE_KEY } from '../src/lib/demo';
import type { ChatAction, ChatState, Message, Person } from '../src/lib/types';
import { localBaseUrl } from './browser-config';

// Local synthetic workspace only. These assertions check filter and navigation
// contracts; they do not certify Google screenshots, provider auth or peer sync.
const allNames = ['Design team', 'Jordan Lee', 'Maya Chen', 'Product launch', 'Weekend plans'];
const allRoots = [
  'Design root Alpha',
  'Design root Beta',
  'Direct root Maya',
  'Group root Weekend',
];
const home = (page: Page) => page.locator('.home-view');
const optionsButton = (page: Page) =>
  home(page).getByRole('button', { name: 'More Home actions', exact: true });
const optionsDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'More Home actions', exact: true });
const unreadSwitch = (page: Page) =>
  home(page).getByRole('switch', { name: 'Unread', exact: true });
const threadsCheckbox = (page: Page) =>
  home(page).getByRole('checkbox', { name: 'Threads', exact: true });
const conversationRow = (page: Page, name: string) =>
  home(page)
    .locator('.conversation-row')
    .filter({
      has: page.locator('.conversation-row-content > strong', { hasText: name }),
    });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

function populatedState(): ChatState {
  const state = createDemoState();
  const self = state.user;
  const maya = state.conversations
    .find((c) => c.id === 'demo-maya-dm')!
    .members.find((p) => p.id !== self.id)!;
  const jordan = state.conversations
    .find((c) => c.id === 'demo-jordan-dm')!
    .members.find((p) => p.id !== self.id)!;
  const unread: Record<string, number> = {
    'demo-design': 2,
    'demo-maya-dm': 1,
    'demo-launch': 0,
    'demo-jordan-dm': 2,
    'demo-weekend': 0,
  };
  for (const conversation of state.conversations) {
    conversation.unread = unread[conversation.id];
    conversation.pinned = ['demo-design', 'demo-jordan-dm', 'demo-weekend'].includes(
      conversation.id,
    );
  }
  const message = (
    id: string,
    conversationId: string,
    text: string,
    parentId?: string,
    deleted = false,
  ): Message => ({
    id,
    conversationId,
    author: parentId ? self : maya,
    text,
    createdAt: '2026-10-05T11:00:00.000Z',
    parentId,
    deleted,
    reactions: [],
    attachments: [],
  });
  state.messages.push(
    message('context-design-a', 'demo-design', 'Design root Alpha'),
    message('context-design-a-reply', 'demo-design', 'Only Alpha reply', 'context-design-a'),
    { ...message('context-design-b', 'demo-design', 'Design root Beta'), author: jordan },
    message('context-design-b-reply', 'demo-design', 'Only Beta reply', 'context-design-b'),
    message('context-maya', 'demo-maya-dm', 'Direct root Maya'),
    message('context-maya-reply', 'demo-maya-dm', 'Only direct reply', 'context-maya'),
    message('context-weekend', 'demo-weekend', 'Group root Weekend'),
    message('context-weekend-reply', 'demo-weekend', 'Only group reply', 'context-weekend'),
    message('context-deleted-reply', 'demo-launch', 'Root with no live reply'),
    message('context-deleted-child', 'demo-launch', '', 'context-deleted-reply', true),
    message('context-deleted-root', 'demo-launch', '', undefined, true),
    message('context-live-child', 'demo-launch', 'Reply to deleted root', 'context-deleted-root'),
    {
      ...message(
        'context-ordinary-search',
        'demo-jordan-dm',
        'Ordinary search result outside Home threads',
      ),
      author: jordan,
    },
  );
  return state;
}

async function fixture(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: width < 800 ? 844 : 960 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(
    ({ key, state }) => {
      localStorage.setItem(key, JSON.stringify(state));
      localStorage.setItem('relay-theme', 'system');
    },
    { key: DEMO_STORAGE_KEY, state: populatedState() },
  );
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: {
        supabaseUrl: '',
        supabaseAnonKey: '',
        databaseConfigured: false,
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore demo', exact: true }).click();
  const navigation =
    width < 800
      ? page.getByRole('navigation', { name: 'Main navigation', exact: true })
      : page.getByRole('complementary', { name: 'Chat navigation', exact: true });
  await navigation.getByRole('button', { name: 'Home', exact: true }).click();
  await expectHome(page);
  await expectRows(page, allNames);
}

async function expectHome(page: Page) {
  await expect(home(page)).toHaveCount(1);
  await expect(home(page).getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await expect(optionsButton(page)).toBeVisible();
  await expect(unreadSwitch(page)).toBeVisible();
  await expect(threadsCheckbox(page)).toBeVisible();
}

async function expectRows(page: Page, names: string[]) {
  await expect
    .poll(async () =>
      (await home(page).locator('.conversation-row-content > strong').allTextContents())
        .map((name) => name.trim())
        .sort(),
    )
    .toEqual([...names].sort());
  await expect(home(page).locator('.search-result')).toHaveCount(0);
}

async function expectRoots(page: Page, texts: string[]) {
  await expect
    .poll(async () =>
      (await home(page).locator('.search-result strong').allTextContents())
        .map((text) => text.trim())
        .sort(),
    )
    .toEqual([...texts].sort());
  await expect(home(page).locator('.conversation-row')).toHaveCount(0);
}

async function openOptions(page: Page) {
  if (!(await optionsDialog(page).isVisible())) await optionsButton(page).click();
  await expect(optionsDialog(page)).toBeVisible();
  return optionsDialog(page).getByRole('menu', { name: 'More Home actions', exact: true });
}

async function dismissOptions(page: Page) {
  if (await optionsDialog(page).isVisible()) {
    await optionsDialog(page).press('Escape');
    await expect(optionsDialog(page)).toHaveCount(0);
  }
}

async function choose(
  page: Page,
  role: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox',
  name: string,
) {
  const menu = await openOptions(page);
  await menu.getByRole(role, { name, exact: true }).click();
  await dismissOptions(page);
  await expectHome(page);
}

async function checked(control: Locator, value: boolean) {
  if ((await control.getAttribute('aria-checked')) !== String(value)) await control.click();
  await expect(control).toHaveAttribute('aria-checked', String(value));
}

async function filters(
  page: Page,
  values: { type?: 'direct' | 'space'; unread?: boolean; pinned?: boolean; threads?: boolean },
) {
  await choose(page, 'menuitem', 'All conversations');
  if (values.type)
    await choose(page, 'menuitemradio', values.type === 'direct' ? 'Direct messages' : 'Spaces');
  if (values.pinned) await choose(page, 'menuitemcheckbox', 'Pinned');
  await checked(unreadSwitch(page), Boolean(values.unread));
  await checked(threadsCheckbox(page), Boolean(values.threads));
}

for (const width of [1440, 390])
  test.describe(`Home filter context ${width}`, () => {
    test.use({
      viewport: { width, height: width < 800 ? 844 : 960 },
      hasTouch: width < 800,
      isMobile: width < 800,
    });
    test('type choices keep Home visible and remain available in the checked keyboard menu', async ({
      page,
    }) => {
      await fixture(page, width);
      const menu = await openOptions(page);
      await expect(
        menu.getByRole('menuitemradio', { name: 'Direct messages', exact: true }),
      ).toHaveAttribute('aria-checked', 'false');
      await expect(
        menu.getByRole('menuitemradio', { name: 'Spaces', exact: true }),
      ).toHaveAttribute('aria-checked', 'false');
      await expect(
        menu.getByRole('menuitemcheckbox', { name: 'Split pane mode', exact: true }),
      ).toHaveCount(0);
      const directSplit = home(page).getByRole('button', { name: 'Split pane', exact: true });
      await expect(directSplit).toHaveCount(width >= 1200 ? 1 : 0);
      if (width >= 1200) await expect(directSplit).toHaveAttribute('aria-pressed', 'true');
      const all = menu.getByRole('menuitem', { name: 'All conversations', exact: true });
      await expect(all).toBeFocused();
      await all.press('ArrowDown');
      const direct = menu.getByRole('menuitemradio', { name: 'Direct messages', exact: true });
      await expect(direct).toBeFocused();
      await direct.press('Enter');
      await dismissOptions(page);
      await expectHome(page);
      await expectRows(page, ['Maya Chen', 'Jordan Lee', 'Weekend plans']);
      const directMenu = await openOptions(page);
      await expect(
        directMenu.getByRole('menuitemradio', { name: 'Direct messages', exact: true }),
      ).toHaveAttribute('aria-checked', 'true');
      await expect(
        directMenu.getByRole('menuitemradio', { name: 'Spaces', exact: true }),
      ).toHaveAttribute('aria-checked', 'false');
      await directMenu.press('Escape');
      await expect(optionsDialog(page)).toHaveCount(0);
      await expect(optionsButton(page)).toBeFocused();
      await expectRows(page, ['Maya Chen', 'Jordan Lee', 'Weekend plans']);
      await choose(page, 'menuitemradio', 'Spaces');
      await expectRows(page, ['Design team', 'Product launch']);
      const spaceMenu = await openOptions(page);
      await expect(
        spaceMenu.getByRole('menuitemradio', { name: 'Spaces', exact: true }),
      ).toHaveAttribute('aria-checked', 'true');
      await expect(
        spaceMenu.getByRole('menuitemradio', { name: 'Direct messages', exact: true }),
      ).toHaveAttribute('aria-checked', 'false');
      await dismissOptions(page);
      await home(page).getByRole('button', { name: 'Clear filters', exact: true }).click();
      await expectRows(page, allNames);
      await expectHome(page);
      // A type filter is distinct from the ordinary sidebar/mobile navigation.
      const navigation =
        width < 800
          ? page.getByRole('navigation', { name: 'Main navigation', exact: true })
          : page.getByRole('complementary', { name: 'Chat navigation', exact: true });
      if (width < 800) {
        await navigation.getByRole('button', { name: 'Direct messages', exact: true }).click();
        await expect(
          page
            .locator('.home-header')
            .getByRole('heading', { name: 'Direct messages', exact: true }),
        ).toBeVisible();
      } else {
        // Desktop group headings collapse their group; its entries open chats.
        await navigation.getByRole('button', { name: 'Maya Chen', exact: true }).click();
        await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toBeVisible();
        await expect(page.getByPlaceholder('Message Maya Chen', { exact: true })).toHaveCount(1);
      }
      await navigation.getByRole('button', { name: 'Home', exact: true }).click();
      await expectHome(page);
      await expectRows(page, allNames);
    });
  });

test('conversation filters intersect instead of navigating or silently resetting each other', async ({
  page,
}) => {
  await fixture(page);
  const cases = [
    { values: { unread: true }, names: ['Design team', 'Maya Chen', 'Jordan Lee'] },
    { values: { pinned: true }, names: ['Design team', 'Jordan Lee', 'Weekend plans'] },
    { values: { type: 'direct' as const, unread: true }, names: ['Maya Chen', 'Jordan Lee'] },
    { values: { type: 'direct' as const, pinned: true }, names: ['Jordan Lee', 'Weekend plans'] },
    { values: { type: 'direct' as const, pinned: true, unread: true }, names: ['Jordan Lee'] },
    { values: { type: 'space' as const, unread: true }, names: ['Design team'] },
    { values: { type: 'space' as const, pinned: true, unread: true }, names: ['Design team'] },
  ];
  for (const scenario of cases) {
    await filters(page, scenario.values);
    await expectRows(page, scenario.names);
    const menu = await openOptions(page);
    await expect(
      menu.getByRole('menuitemcheckbox', { name: 'Pinned', exact: true }),
    ).toHaveAttribute('aria-checked', String(Boolean(scenario.values.pinned)));
    await dismissOptions(page);
  }
  await choose(page, 'menuitem', 'All conversations');
  await expectRows(page, allNames);
  await expect(unreadSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await expect(threadsCheckbox(page)).toHaveAttribute('aria-checked', 'false');
  await expect(home(page).getByRole('button', { name: 'Clear filters', exact: true })).toHaveCount(
    0,
  );
});

test('populated thread roots honor type, unread and pinned intersections, including a genuine empty set', async ({
  page,
}) => {
  await fixture(page);
  const cases = [
    { values: { threads: true }, roots: allRoots },
    {
      values: { threads: true, type: 'direct' as const },
      roots: ['Direct root Maya', 'Group root Weekend'],
    },
    {
      values: { threads: true, type: 'space' as const },
      roots: ['Design root Alpha', 'Design root Beta'],
    },
    {
      values: { threads: true, unread: true },
      roots: ['Design root Alpha', 'Design root Beta', 'Direct root Maya'],
    },
    {
      values: { threads: true, pinned: true },
      roots: ['Design root Alpha', 'Design root Beta', 'Group root Weekend'],
    },
    {
      values: { threads: true, type: 'direct' as const, unread: true },
      roots: ['Direct root Maya'],
    },
    { values: { threads: true, type: 'direct' as const, pinned: true, unread: true }, roots: [] },
  ];
  for (const scenario of cases) {
    await filters(page, scenario.values);
    await expectRoots(page, scenario.roots);
    if (!scenario.roots.length) {
      await expect(
        home(page).getByRole('heading', { name: 'No matching threads', exact: true }),
      ).toBeVisible();
      await expect(
        home(page).getByText('Change or clear your Home filters to see more threads.', {
          exact: true,
        }),
      ).toBeVisible();
    }
  }
  await choose(page, 'menuitem', 'All conversations');
  await expectRows(page, allNames);
  await expect(unreadSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await expect(threadsCheckbox(page)).toHaveAttribute('aria-checked', 'false');
  const menu = await openOptions(page);
  await expect(
    menu.getByRole('menuitemradio', { name: 'Direct messages', exact: true }),
  ).toHaveAttribute('aria-checked', 'false');
  await expect(menu.getByRole('menuitemradio', { name: 'Spaces', exact: true })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Pinned', exact: true })).toHaveAttribute(
    'aria-checked',
    'false',
  );
});

test('choosing a populated thread opens its exact parent and replies, not another root in that space', async ({
  page,
}) => {
  await fixture(page);
  await filters(page, { threads: true, type: 'space' });
  await expectRoots(page, ['Design root Alpha', 'Design root Beta']);
  await home(page)
    .getByRole('button', {
      name: 'Message from Jordan Lee in Design team: Design root Beta',
      exact: true,
    })
    .click();
  const thread = page.locator('.thread-panel');
  await expect(thread.getByRole('heading', { name: 'Thread', exact: true })).toBeVisible();
  await expect(thread.locator('article')).toHaveCount(2);
  await expect(thread.locator('#message-context-design-b')).toContainText('Design root Beta');
  await expect(thread.locator('#message-context-design-b-reply')).toContainText('Only Beta reply');
  await expect(thread.getByText('Design root Alpha', { exact: true })).toHaveCount(0);
  await expect(thread.getByText('Only Alpha reply', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Reply in thread', exact: true })).toBeVisible();
});

test('searching from filtered Home opens an ordinary result without inheriting the Home Threads panel', async ({
  page,
}) => {
  await fixture(page);
  await filters(page, { threads: true });
  await expectRoots(page, allRoots);
  const text = 'Ordinary search result outside Home threads';
  await page
    .locator('.app-topbar')
    .getByRole('textbox', { name: 'Search in chat', exact: true })
    .fill(text);
  await expect(page.getByRole('heading', { name: 'Search results', exact: true })).toBeVisible();
  const result = page.getByRole('button', {
    name: `Message from Jordan Lee in Jordan Lee: ${text}`,
    exact: true,
  });
  await expect(result).toHaveCount(1);
  await result.click();
  const conversation = page.getByRole('region', { name: 'Conversation', exact: true });
  await expect(conversation).toBeVisible();
  await expect(
    conversation.getByRole('heading', { name: 'Jordan Lee', exact: true }),
  ).toBeVisible();
  await expect(conversation.locator('#message-context-ordinary-search')).toContainText(text);
  await expect(conversation.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await expect(page.locator('.thread-panel')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Reply in thread', exact: true })).toHaveCount(0);
});

test('mark all read reaches unread conversations hidden by type and pinned filters', async ({
  page,
}) => {
  await fixture(page);
  await filters(page, { type: 'direct', pinned: true, unread: true });
  await expectRows(page, ['Jordan Lee']);
  await choose(page, 'menuitem', 'Mark all conversations read');
  await expectRows(page, []);
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const saved = JSON.parse(localStorage.getItem(key)!) as ChatState;
        return saved.conversations
          .map((c) => ({ id: c.id, unread: c.unread }))
          .sort((a, b) => a.id.localeCompare(b.id));
      }, DEMO_STORAGE_KEY),
    )
    .toEqual([
      { id: 'demo-design', unread: 0 },
      { id: 'demo-jordan-dm', unread: 0 },
      { id: 'demo-launch', unread: 0 },
      { id: 'demo-maya-dm', unread: 0 },
      { id: 'demo-weekend', unread: 0 },
    ]);
  await choose(page, 'menuitem', 'All conversations');
  await expectRows(page, allNames);
  await checked(unreadSwitch(page), true);
  await expectRows(page, []);
  await checked(unreadSwitch(page), false);
  await expectRows(page, allNames);
});

test('partial mark-all failure keeps confirmed reads and retries only the unread conversation with its original identity', async ({
  page,
  context,
}) => {
  // This route model exercises the actual SDK/controller/UI on loopback. It
  // does not replace the separate SQL receipt tests or contact a provider.
  const base = localBaseUrl(),
    origin = new URL(base).origin,
    provider = 'https://home-read-fixture.invalid';
  const owner: Person = {
    id: '00000000-0000-4000-8000-000000000811',
    name: 'Read fixture owner',
    email: 'read-owner@example.invalid',
    color: '#1967d2',
  };
  const ids = [
    '00000000-0000-4000-8000-000000000812',
    '00000000-0000-4000-8000-000000000813',
    '00000000-0000-4000-8000-000000000814',
  ];
  const names = ['First confirmed read', 'Second failed read', 'Third queued read'];
  const state: ChatState = {
    user: owner,
    conversations: ids.map((id, index) => ({
      id,
      name: names[index],
      kind: 'space',
      members: [owner],
      unread: 2,
      updatedAt: '2026-10-06T00:00:00Z',
    })),
    messages: [],
  };
  const now = Math.floor(Date.now() / 1000);
  const token = [
    Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
    Buffer.from(
      JSON.stringify({
        sub: owner.id,
        aud: 'authenticated',
        role: 'authenticated',
        iat: now,
        exp: now + 3600,
      }),
    ).toString('base64url'),
    'LOCAL_INVALID_SIGNATURE',
  ].join('.');
  const user = {
    id: owner.id,
    email: owner.email,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { provider: 'google' },
    user_metadata: { full_name: owner.name },
    created_at: new Date().toISOString(),
    email_confirmed_at: new Date().toISOString(),
  };
  type ReadAction = Extract<ChatAction, { type: 'read' }> & { clientActionId: string };
  const attempts: ReadAction[] = [],
    receipts = new Map<string, string>(),
    commits = new Map<string, number>();
  const failureText = 'The second conversation could not be marked read. Please try again.';
  let failedOnce = false,
    releaseThird: (() => void) | undefined;
  await context.addInitScript(
    (session) => localStorage.setItem('relay-chat-auth-v1', JSON.stringify(session)),
    {
      access_token: token,
      refresh_token: 'LOCAL_NOT_REAL',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: now + 3600,
      user,
    },
  );
  await page.routeWebSocket(`${provider.replace('https:', 'wss:')}/**`, (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === provider && url.pathname === '/auth/v1/user')
      return route.fulfill({ json: user });
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (url.pathname === '/api/config')
      return route.fulfill({
        json: {
          supabaseUrl: provider,
          supabaseAnonKey: 'sb_publishable_LOCAL_ONLY',
          databaseConfigured: true,
          signInUrl: 'https://sign-in.example.test/start',
        },
      });
    if (url.pathname !== '/api/chat') {
      if (url.pathname.startsWith('/api/')) return route.abort('blockedbyclient');
      return route.continue();
    }
    if (request.headers().authorization !== `Bearer ${token}`)
      return route.fulfill({
        status: 401,
        json: { error: 'The local read fixture requires its synthetic session.' },
      });
    if (request.method() !== 'POST') {
      const actionId = url.searchParams.get('clientActionId');
      return route.fulfill({
        json: {
          state: structuredClone(state),
          ...(actionId && receipts.has(actionId) ? { actionId } : {}),
        },
      });
    }
    const action = request.postDataJSON() as ReadAction;
    expect(action.type).toBe('read');
    expect(action.unread).not.toBe(true);
    expect(action.clientActionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    attempts.push(structuredClone(action));
    if (action.conversationId === ids[1] && !failedOnce) {
      failedOnce = true;
      return route.fulfill({ status: 503, json: { error: failureText } });
    }
    if (action.conversationId === ids[2] && !receipts.has(action.clientActionId))
      await new Promise<void>((resolve) => {
        releaseThird = resolve;
      });
    const prior = receipts.get(action.clientActionId);
    if (prior) expect(prior).toBe(action.conversationId);
    else {
      const conversation = state.conversations.find(
        (conversation) => conversation.id === action.conversationId,
      )!;
      expect(conversation).toBeDefined();
      conversation.unread = 0;
      receipts.set(action.clientActionId, action.conversationId);
      commits.set(action.conversationId, (commits.get(action.conversationId) || 0) + 1);
    }
    return route.fulfill({ json: { state: structuredClone(state) } });
  });
  try {
    await page.goto(base);
    await expectHome(page);
    await checked(unreadSwitch(page), true);
    await expectRows(page, names);
    await choose(page, 'menuitem', 'Mark all conversations read');
    await expect.poll(() => attempts.map((action) => action.conversationId)).toEqual(ids);
    await expect(page.locator('.toast')).toHaveText(failureText);
    await expect(page.getByText('All conversations marked as read', { exact: true })).toHaveCount(
      0,
    );
    await expectRows(page, names.slice(1));
    expect(state.conversations.map((conversation) => conversation.unread)).toEqual([0, 2, 2]);
    expect([...commits.entries()]).toEqual([[ids[0], 1]]);
    expect(receipts.has(attempts[0].clientActionId)).toBe(true);
    expect(receipts.has(attempts[1].clientActionId)).toBe(false);

    releaseThird!();
    releaseThird = undefined;
    await expectRows(page, [names[1]]);
    expect(state.conversations.map((conversation) => conversation.unread)).toEqual([0, 2, 0]);
    expect([...commits.entries()]).toEqual([
      [ids[0], 1],
      [ids[2], 1],
    ]);
    await choose(page, 'menuitem', 'Mark all conversations read');
    await expect.poll(() => attempts.length).toBe(4);
    expect(attempts[3].conversationId).toBe(ids[1]);
    expect(attempts[3].clientActionId).toBe(attempts[1].clientActionId);
    await expectRows(page, []);
    await expect(page.locator('.toast')).toHaveText('All conversations marked as read');
    expect(state.conversations.every((conversation) => conversation.unread === 0)).toBe(true);
    expect(ids.map((id) => commits.get(id))).toEqual([1, 1, 1]);
    expect(receipts.size).toBe(3);
    expect(attempts.filter((action) => action.conversationId === ids[0])).toHaveLength(1);
    expect(attempts.filter((action) => action.conversationId === ids[2])).toHaveLength(1);
  } finally {
    releaseThird?.();
  }
});

test('a read-removed preview opener keeps its draft and closes to a connected Home control', async ({
  page,
}) => {
  await fixture(page);
  await filters(page, { type: 'direct', unread: true });
  await expectRows(page, ['Maya Chen', 'Jordan Lee']);
  const opener = await conversationRow(page, 'Maya Chen').elementHandle();
  expect(opener).not.toBeNull();
  await conversationRow(page, 'Maya Chen').click();
  await expect(
    page.getByRole('region', { name: 'Conversation preview', exact: true }),
  ).toBeVisible();
  await expectRows(page, ['Jordan Lee']);
  expect(await opener!.evaluate((element) => element.isConnected)).toBe(false);
  await composer(page).fill('Maya draft while its Home row is hidden');
  await page.getByRole('button', { name: 'Close conversation preview', exact: true }).click();
  await expect(composer(page)).toHaveCount(0);
  await expectHome(page);
  await expect(optionsButton(page)).toBeFocused();
  await choose(page, 'menuitemradio', 'Spaces');
  await expectRows(page, ['Design team']);
  await home(page).getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expectRows(page, allNames);
  await conversationRow(page, 'Jordan Lee').click();
  await expect(composer(page)).toHaveValue('');
  await page.getByRole('button', { name: 'Close conversation preview', exact: true }).click();
  await conversationRow(page, 'Maya Chen').click();
  await expect(composer(page)).toHaveValue('Maya draft while its Home row is hidden');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(composer(page)).toHaveValue('');
  await expect(
    page
      .getByRole('region', { name: 'Conversation preview', exact: true })
      .getByText('Maya draft while its Home row is hidden', { exact: true }),
  ).toHaveCount(1);
});
