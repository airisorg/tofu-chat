import { expect, test, type BrowserContext, type Page } from './coverage-test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { evidenceDirectory, localBaseUrl } from './browser-config';
import { LOGIN_NONCE_QUERY, LOGIN_REQUEST_KEY } from '../src/lib/login-callback';
import type { ChatAction, ChatState, Person } from '../src/lib/types';

// Invalid fixture credentials and loopback routes only. This exercises the
// actual SDK/controller/UI, not Google, real SQL receipts or hosted transport.
const base = localBaseUrl(),
  origin = new URL(base).origin,
  provider = 'https://profile-fixture.invalid';
const ownerA = '00000000-0000-4000-8000-000000000111',
  ownerB = '00000000-0000-4000-8000-000000000222';
function session(id: string) {
  const now = Math.floor(Date.now() / 1000),
    name = id === ownerA ? 'First profile person' : 'Second profile person';
  return {
    access_token: [
      Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
      Buffer.from(
        JSON.stringify({
          sub: id,
          aud: 'authenticated',
          role: 'authenticated',
          iat: now,
          exp: now + 3600,
        }),
      ).toString('base64url'),
      'LOCAL_INVALID_SIGNATURE',
    ].join('.'),
    refresh_token: 'LOCAL_NOT_REAL',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: now + 3600,
    user: {
      id,
      email: `${id === ownerA ? 'first' : 'second'}@example.invalid`,
      aud: 'authenticated',
      role: 'authenticated',
      app_metadata: { provider: 'google' },
      user_metadata: { full_name: name },
      created_at: new Date().toISOString(),
      email_confirmed_at: new Date().toISOString(),
    },
  };
}
const a = session(ownerA),
  b = session(ownerB);
type ProfileAction = Extract<ChatAction, { type: 'profile' }> & { clientActionId?: string };
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Your profile', exact: true });
const nameInput = (page: Page) =>
  dialog(page).getByRole('textbox', { name: 'Display name', exact: true });
const statusInput = (page: Page) =>
  dialog(page).getByRole('textbox', { name: 'Status', exact: true });
const save = (page: Page) => dialog(page).getByRole('button', { name: 'Save', exact: true });
async function open(page: Page) {
  await page
    .locator('.app-topbar')
    .getByRole('button', { name: 'Your profile', exact: true })
    .click();
  await expect(dialog(page)).toBeVisible();
}
class ProfileFixture {
  users = new Map<string, Person>(
    [a, b].map((s) => [
      s.user.id,
      {
        id: s.user.id,
        name: s.user.user_metadata.full_name,
        email: s.user.email,
        status: 'Active',
        color: '#1967d2',
      },
    ]),
  );
  actions: { owner: string; action: ProfileAction }[] = [];
  receipts = new Set<string>();
  mode: 'ok' | 'reject' | 'lost-uncommitted' | 'hold' = 'ok';
  getOutage = false;
  release: (() => void) | null = null;
  holdReads = false;
  genericActions: {
    owner: string;
    action: Extract<ChatAction, { type: 'read' }> & { clientActionId?: string };
  }[] = [];
  genericSettled = 0;
  unreadByOwner = new Map<string, number>();
  state(owner: string): ChatState {
    const user = structuredClone(this.users.get(owner)!);
    return {
      user,
      conversations: [
        {
          id: '00000000-0000-4000-8000-000000000333',
          kind: 'space',
          name: owner === ownerA ? 'First profile workspace' : 'Second profile workspace',
          members: [user],
          unread: this.unreadByOwner.get(owner) || 0,
          updatedAt: '2026-10-06T00:00:00Z',
        },
      ],
      messages: [],
    };
  }
}
const activeFixtures = new WeakMap<Page, ProfileFixture>();
test.afterEach(async ({ page }) => {
  activeFixtures.get(page)?.release?.();
});
async function fixture(page: Page, context: BrowserContext) {
  const api = new ProfileFixture();
  activeFixtures.set(page, api);
  await context.addInitScript((value) => {
    if (!localStorage.getItem('relay-chat-auth-v1'))
      localStorage.setItem('relay-chat-auth-v1', JSON.stringify(value));
  }, a);
  await page.routeWebSocket(`${provider.replace('https:', 'wss:')}/**`, (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const identity = request.headers().authorization === `Bearer ${b.access_token}` ? b : a;
    if (url.origin === provider && url.pathname === '/auth/v1/user')
      return route.fulfill({ json: identity.user });
    if (url.origin === provider && url.pathname === '/auth/v1/logout')
      return route.fulfill({ json: {} });
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
    if (url.pathname === '/api/chat') {
      if (
        ![a.access_token, b.access_token].some(
          (token) => request.headers().authorization === `Bearer ${token}`,
        )
      )
        return route.fulfill({
          status: 401,
          json: { error: 'Local profile fixture requires its synthetic session.' },
        });
      const owner = identity.user.id;
      if (request.method() !== 'POST') {
        if (api.getOutage)
          return route.fulfill({
            status: 503,
            json: { error: 'Synthetic receipt lookup outage.' },
          });
        const actionId = url.searchParams.get('clientActionId');
        return route.fulfill({
          json: {
            state: api.state(owner),
            ...(actionId && api.receipts.has(`${owner}:${actionId}`) ? { actionId } : {}),
          },
        });
      }
      const action = request.postDataJSON() as ChatAction & { clientActionId?: string };
      if (action.type === 'read' && api.holdReads) {
        api.genericActions.push({ owner, action: structuredClone(action) });
        await new Promise<void>((resolve) => {
          api.release = resolve;
        });
        api.unreadByOwner.set(owner, action.unread ? 1 : 0);
        if (action.clientActionId) api.receipts.add(`${owner}:${action.clientActionId}`);
        try {
          return await route.fulfill({ json: { state: api.state(owner) } });
        } catch {
          return;
        } finally {
          api.genericSettled += 1;
        }
      }
      if (action.type !== 'profile') return route.fulfill({ json: { state: api.state(owner) } });
      api.actions.push({ owner, action: structuredClone(action) });
      if (api.mode === 'reject')
        return route.fulfill({
          status: 400,
          json: { error: 'Synthetic profile rejection. Your edits are not saved.' },
        });
      if (api.mode === 'lost-uncommitted') return route.abort('connectionreset');
      if (api.mode === 'hold')
        await new Promise<void>((resolve) => {
          api.release = resolve;
        });
      const key = `${owner}:${action.clientActionId}`;
      if (!api.receipts.has(key)) {
        const user = api.users.get(owner)!;
        if (action.name !== undefined) user.name = action.name;
        if (action.status !== undefined) user.status = action.status;
        api.receipts.add(key);
      }
      // Identity transitions can abort the client while a server transaction
      // still commits. The old owner's result remains owner-scoped here.
      try {
        return await route.fulfill({ json: { state: api.state(owner) } });
      } catch {
        return;
      }
    }
    if (url.pathname.startsWith('/api/')) return route.abort('blockedbyclient');
    return route.continue();
  });
  await page.goto(base);
  await expect(page.locator('.app-shell')).toBeVisible();
  await open(page);
  await expect(nameInput(page)).toHaveValue('First profile person');
  return api;
}
async function switchAccount(context: BrowserContext, target = b) {
  const tab = await context.newPage(),
    nonce = '00000000-0000-4000-8000-000000000666';
  await tab.routeWebSocket(`${provider.replace('https:', 'wss:')}/**`, (socket) => socket.close());
  await tab.addInitScript(
    ({ nonce, key }) =>
      sessionStorage.setItem(key, JSON.stringify({ nonce, createdAt: Date.now() })),
    { nonce, key: LOGIN_REQUEST_KEY },
  );
  const hash = new URLSearchParams({
    access_token: target.access_token,
    refresh_token: target.refresh_token,
    expires_in: '3600',
    token_type: 'bearer',
  });
  await tab.goto(`${base}/?${LOGIN_NONCE_QUERY}=${nonce}#${hash}`);
  await expect(tab.locator('.app-shell')).toBeVisible();
  return tab;
}

test('profile presets preserve unsaved name and only Save commits both fields', async ({
  page,
}, info) => {
  await page.route('**/api/config', (route) =>
    route.fulfill({ json: { supabaseUrl: '', supabaseAnonKey: '', databaseConfigured: false } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore demo', exact: true }).click();
  await page
    .locator('.app-topbar')
    .getByRole('button', { name: 'Your profile', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Your profile', exact: true });
  await dialog
    .getByRole('textbox', { name: 'Display name', exact: true })
    .fill('Unsaved profile name');
  await dialog.getByRole('button', { name: 'Away', exact: true }).click();
  const dir = evidenceDirectory(info);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${info.project.name}-preset.png`) });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Display name', exact: true })).toHaveValue(
    'Unsaved profile name',
  );
  await expect(dialog.getByRole('textbox', { name: 'Status', exact: true })).toHaveValue('Away');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page
    .locator('.app-topbar')
    .getByRole('button', { name: 'Your profile', exact: true })
    .click();
  await expect(dialog.getByRole('textbox', { name: 'Display name', exact: true })).toHaveValue(
    'Unsaved profile name',
  );
  await expect(dialog.getByRole('textbox', { name: 'Status', exact: true })).toHaveValue('Away');
});

test('profile local presets and Escape, Close or Cancel never POST unsaved edits', async ({
  page,
  context,
}) => {
  const api = await fixture(page, context);
  for (const close of ['Escape', 'Close', 'Cancel'] as const) {
    await nameInput(page).fill(`Cancelled ${close}`);
    await statusInput(page).fill('Unsaved custom status');
    await dialog(page).getByRole('button', { name: 'Away', exact: true }).click();
    await expect(nameInput(page)).toHaveValue(`Cancelled ${close}`);
    await expect(statusInput(page)).toHaveValue('Away');
    expect(api.actions).toHaveLength(0);
    if (close === 'Escape') await page.keyboard.press('Escape');
    else
      await dialog(page)
        .getByRole('button', { name: close === 'Close' ? 'Close dialog' : 'Cancel', exact: true })
        .click();
    await expect(dialog(page)).toHaveCount(0);
    await open(page);
    await expect(nameInput(page)).toHaveValue('First profile person');
    await expect(statusInput(page)).toHaveValue('Active');
  }
  expect(api.actions).toHaveLength(0);
});

for (const mode of ['reject', 'lost-uncommitted'] as const)
  test(`profile ${mode} preserves both edits and correctly scopes retry identity`, async ({
    page,
    context,
  }) => {
    const api = await fixture(page, context);
    api.mode = mode;
    api.getOutage = mode === 'lost-uncommitted';
    await nameInput(page).fill('Retained profile name');
    await statusInput(page).fill('Retained profile status');
    await save(page).click();
    await expect.poll(() => api.actions.length).toBe(1);
    await expect(save(page)).toBeEnabled();
    await expect(dialog(page)).toBeVisible();
    await expect(nameInput(page)).toHaveValue('Retained profile name');
    await expect(statusInput(page)).toHaveValue('Retained profile status');
    expect(api.users.get(ownerA)!.name).toBe('First profile person');
    api.mode = 'ok';
    api.getOutage = false;
    await save(page).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(api.actions).toHaveLength(2);
    expect(api.actions[0].action.clientActionId).toMatch(/^[0-9a-f-]{36}$/);
    if (mode === 'lost-uncommitted')
      expect(api.actions[1].action.clientActionId).toBe(api.actions[0].action.clientActionId);
    else
      expect(api.actions[1].action.clientActionId).not.toBe(api.actions[0].action.clientActionId);
    expect(api.users.get(ownerA)!.name).toBe('Retained profile name');
    expect(api.users.get(ownerA)!.status).toBe('Retained profile status');
  });

test('profile pending Save submits once and locks fields and presets', async ({
  page,
  context,
}) => {
  const api = await fixture(page, context);
  api.mode = 'hold';
  await nameInput(page).fill('Submitted profile name');
  await statusInput(page).fill('Submitted profile status');
  await save(page).focus();
  await save(page).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => !!api.release).toBe(true);
  await expect(save(page)).toBeDisabled();
  expect(api.actions).toHaveLength(1);
  expect(api.actions[0].action).toMatchObject({
    type: 'profile',
    name: 'Submitted profile name',
    status: 'Submitted profile status',
  });
  await expect(nameInput(page)).toBeDisabled();
  await expect(statusInput(page)).toBeDisabled();
  await expect(dialog(page).getByRole('button', { name: 'Away', exact: true })).toBeDisabled();
  await expect
    .poll(() =>
      dialog(page).evaluate(
        (node) =>
          node.contains(document.activeElement) && !document.activeElement?.matches(':disabled'),
      ),
    )
    .toBe(true);
  const focused = new Set<string>();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    const active = await dialog(page).evaluate((node) => ({
      inside: node.contains(document.activeElement),
      disabled: document.activeElement?.matches(':disabled'),
      label:
        document.activeElement?.getAttribute('aria-label') ||
        document.activeElement?.textContent?.trim(),
    }));
    expect(active.inside, JSON.stringify(active)).toBe(true);
    expect(active.disabled).toBe(false);
    focused.add(active.label || '');
  }
  expect(focused.has('Close dialog')).toBe(true);
  expect(focused.has('Cancel')).toBe(true);
  await dialog(page)
    .locator('form')
    .evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
      form.requestSubmit();
    });
  expect(api.actions).toHaveLength(1);
  api.release!();
  await expect(dialog(page)).toHaveCount(0);
  expect(api.users.get(ownerA)!.name).toBe('Submitted profile name');
  expect(api.users.get(ownerA)!.status).toBe('Submitted profile status');
});

for (const next of ['profile', 'settings'] as const)
  test(`an older profile acknowledgement cannot close a newer ${next} dialog`, async ({
    page,
    context,
  }) => {
    const api = await fixture(page, context);
    api.mode = 'hold';
    await nameInput(page).fill('Older request profile');
    await statusInput(page).fill('Older request status');
    await save(page).click();
    await expect.poll(() => !!api.release).toBe(true);
    await dialog(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    if (next === 'profile') {
      await open(page);
      await expect(nameInput(page)).toBeDisabled();
      await expect(statusInput(page)).toBeDisabled();
      await expect(save(page)).toBeDisabled();
      await expect(nameInput(page)).toHaveValue('First profile person');
      await expect(statusInput(page)).toHaveValue('Active');
    } else await page.getByRole('button', { name: 'Settings', exact: true }).click();
    api.release!();
    await expect.poll(() => api.users.get(ownerA)!.name).toBe('Older request profile');
    await expect(
      page.getByRole('dialog', {
        name: next === 'profile' ? 'Your profile' : 'Settings',
        exact: true,
      }),
    ).toBeVisible();
    if (next === 'profile') {
      await expect(nameInput(page)).toBeEnabled();
      await expect(statusInput(page)).toBeEnabled();
      await expect(nameInput(page)).toHaveValue('Older request profile');
      await expect(statusInput(page)).toHaveValue('Older request status');
      await nameInput(page).fill('Newer dialog draft');
      await statusInput(page).fill('Newer dialog status');
      await expect(nameInput(page)).toHaveValue('Newer dialog draft');
      await expect(statusInput(page)).toHaveValue('Newer dialog status');
      api.users.get(ownerA)!.name = 'Server profile refresh';
      api.users.get(ownerA)!.status = 'Server status refresh';
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect(dialog(page).locator('strong')).toHaveText('Server profile refresh');
      await expect(nameInput(page)).toHaveValue('Newer dialog draft');
      await expect(statusInput(page)).toHaveValue('Newer dialog status');
    }
  });

test('a held profile response cannot change or close another SDK identity profile', async ({
  page,
  context,
}) => {
  const api = await fixture(page, context);
  api.mode = 'hold';
  await nameInput(page).fill('First owner submitted name');
  await save(page).click();
  await expect.poll(() => !!api.release).toBe(true);
  const secondTab = await switchAccount(context);
  try {
    await expect(dialog(page)).toHaveCount(0);
    await open(page);
    await expect(nameInput(page)).toHaveValue('Second profile person');
    await nameInput(page).fill('Second owner unsaved draft');
    await statusInput(page).fill('Second owner unsaved status');
    api.release!();
    await expect.poll(() => api.users.get(ownerA)!.name).toBe('First owner submitted name');
    await expect(dialog(page)).toBeVisible();
    await expect(nameInput(page)).toHaveValue('Second owner unsaved draft');
    await expect(statusInput(page)).toHaveValue('Second owner unsaved status');
    expect(api.users.get(ownerB)!.name).toBe('Second profile person');
    await expect(page.locator('.toast').filter({ hasText: 'Profile updated' })).toHaveCount(0);
  } finally {
    api.release?.();
    await secondTab.close();
  }
});

test('an older availability acknowledgement cannot close or toast over a newer profile draft', async ({
  page,
  context,
}) => {
  const api = await fixture(page, context);
  api.mode = 'hold';
  await dialog(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.locator('.app-topbar .status-button').click();
  await page
    .getByRole('dialog', { name: 'Availability', exact: true })
    .getByRole('button', { name: 'Away', exact: true })
    .click();
  await expect.poll(() => !!api.release).toBe(true);
  await open(page);
  await nameInput(page).fill('New profile after availability');
  await statusInput(page).fill('Unsaved newer profile status');
  api.release!();
  await expect.poll(() => api.users.get(ownerA)!.status).toBe('Away');
  await expect(dialog(page)).toBeVisible();
  await expect(nameInput(page)).toHaveValue('New profile after availability');
  await expect(statusInput(page)).toHaveValue('Unsaved newer profile status');
  await expect(page.locator('.toast').filter({ hasText: 'Status set to Away' })).toHaveCount(0);
  expect(api.actions).toHaveLength(1);
});

for (const flow of ['open-unread', 'mark-all', 'open-unread-return-to-owner'] as const) {
  test(`generic ${flow} completion cannot toast into a later SDK account generation`, async ({
    page,
    context,
  }) => {
    const api = await fixture(page, context);
    api.holdReads = true;
    api.unreadByOwner.set(ownerA, 1);
    await page.reload();
    await expect(
      page
        .getByRole('navigation')
        .getByRole('button', { name: 'Home', exact: true })
        .locator('.nav-count'),
    ).toHaveText('1');
    if (flow === 'mark-all') {
      await page.getByRole('button', { name: 'More Home actions', exact: true }).click();
      await page
        .getByRole('menuitem', { name: 'Mark all conversations read', exact: true })
        .click();
    } else {
      await page
        .getByRole('complementary', { name: 'Chat navigation', exact: true })
        .getByRole('button', { name: 'First profile workspace', exact: true })
        .click();
    }
    await expect.poll(() => api.genericActions.length).toBe(1);
    await expect.poll(() => !!api.release).toBe(true);
    await page.evaluate(() => {
      const record = window as unknown as { genericToastHistory: string[] };
      record.genericToastHistory = [];
      new MutationObserver(() => {
        const text = document.querySelector('.toast')?.textContent;
        if (text) record.genericToastHistory.push(text);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    const tabs = [await switchAccount(context)];
    try {
      await open(page);
      await expect(nameInput(page)).toHaveValue('Second profile person');
      if (flow === 'open-unread-return-to-owner') {
        tabs.push(await switchAccount(context, a));
        await open(page);
        await expect(nameInput(page)).toHaveValue('First profile person');
      }
      await nameInput(page).fill('Current generation draft remains editable');
      await statusInput(page).fill('Current generation custom status');
      api.release!();
      await expect.poll(() => api.genericSettled).toBe(1);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(dialog(page)).toBeVisible();
      await expect(nameInput(page)).toHaveValue('Current generation draft remains editable');
      await expect(statusInput(page)).toHaveValue('Current generation custom status');
      const history = await page.evaluate(
        () => (window as unknown as { genericToastHistory: string[] }).genericToastHistory,
      );
      expect(
        history.filter((text) =>
          /Your account changed|All conversations marked as read|Unable to complete/.test(text),
        ),
      ).toEqual([]);
      await expect(page.locator('.toast')).toHaveCount(0);
      expect(api.genericActions).toHaveLength(1);
      expect(api.genericActions[0].owner).toBe(ownerA);
      expect(api.genericActions[0].action.type).toBe('read');
    } finally {
      api.release?.();
      for (const tab of tabs) await tab.close();
    }
  });
}

test('failed avatar images fall back to initials and retry when the URL changes', async ({
  page,
  context,
}) => {
  const api = await fixture(page, context);
  const prefix = 'https://lh3.googleusercontent.com/profile-fallback-local';
  const requested: string[] = [];
  await page.route(`${prefix}*`, (route) => {
    const url = route.request().url();
    requested.push(url);
    return url.endsWith('-valid.png')
      ? route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=',
            'base64',
          ),
        })
      : route.fulfill({
          status: 404,
          contentType: 'text/plain',
          body: 'Missing local fixture image',
        });
  });
  const avatar = page
    .locator('.app-topbar')
    .getByRole('button', { name: 'Your profile', exact: true })
    .locator(':scope > .avatar');
  const profileAvatar = dialog(page).locator('.avatar.large');
  const refreshAvatar = async (url: string) => {
    api.users.get(ownerA)!.avatar = url;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => requested.includes(url)).toBe(true);
  };
  const initialBox = await avatar.boundingBox();
  await refreshAvatar(`${prefix}-missing.png`);
  await expect(avatar.locator('img')).toHaveCount(0);
  await expect(avatar).toHaveText('FP');
  await expect(profileAvatar).toHaveText('FP');
  const failedBox = await avatar.boundingBox();
  expect(failedBox!.width).toBe(initialBox!.width);
  expect(failedBox!.height).toBe(initialBox!.height);
  await refreshAvatar(`${prefix}-valid.png`);
  await expect(avatar.locator('img')).toHaveJSProperty('naturalWidth', 1);
  await expect(profileAvatar.locator('img')).toHaveJSProperty('naturalWidth', 1);
  api.users.get(ownerA)!.avatar = `${prefix}-missing-again.png`;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => requested.includes(`${prefix}-missing-again.png`)).toBe(true);
  await expect(avatar).toHaveText('FP');
  await expect(avatar.locator('img')).toHaveCount(0);
  await expect(nameInput(page)).toHaveValue('First profile person');
});
