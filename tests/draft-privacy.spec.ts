import { expect, test, type BrowserContext, type Page } from './coverage-test';
import type { ChatState } from '../src/lib/types';
import { draftSavingKey, savedDraftsKey } from '../src/lib/draft-preference';
import { LOGIN_NONCE_QUERY, LOGIN_REQUEST_KEY } from '../src/lib/login-callback';
import { localBaseUrl } from './browser-config';

// Local routed provider and deliberately invalid credentials only.
const base = localBaseUrl(),
  origin = new URL(base).origin,
  provider = 'https://draft-privacy.invalid';
const first = '00000000-0000-4000-8000-000000000111',
  second = '00000000-0000-4000-8000-000000000222';
const cid = '00000000-0000-4000-8000-000000000333',
  side = '00000000-0000-4000-8000-000000000444';
function session(id: string) {
  const now = Math.floor(Date.now() / 1000);
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
      email: `${id === first ? 'first' : 'second'}@example.invalid`,
      aud: 'authenticated',
      role: 'authenticated',
      app_metadata: { provider: 'google' },
      user_metadata: { full_name: id === first ? 'First person' : 'Second person' },
      created_at: new Date().toISOString(),
      email_confirmed_at: new Date().toISOString(),
    },
  };
}
const a = session(first),
  b = session(second);
function state(s: typeof a): ChatState {
  const user = {
    id: s.user.id,
    name: s.user.user_metadata.full_name,
    email: s.user.email,
    status: 'Active',
  };
  return {
    user,
    conversations: [cid, side].map((id, i) => ({
      id,
      name: i ? 'Side workspace' : s.user.id === first ? 'First workspace' : 'Second workspace',
      kind: 'space',
      members: [user],
      unread: 0,
      updatedAt: new Date().toISOString(),
    })),
    messages: [],
  };
}
async function fixture(context: BrowserContext) {
  const control = { failSend: false };
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const s = request.headers().authorization === `Bearer ${b.access_token}` ? b : a;
    if (url.origin === provider && url.pathname === '/auth/v1/user')
      return route.fulfill({ json: s.user });
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
        control.failSend &&
        request.method() === 'POST' &&
        request.postDataJSON()?.type === 'send'
      )
        return route.abort('failed');
      return route.fulfill({ json: { state: state(s) } });
    }
    if (url.pathname === '/api/uploads')
      return control.failSend ? route.abort('failed') : route.fulfill({ json: { ok: true } });
    if (url.pathname.startsWith('/api/')) return route.abort('blockedbyclient');
    return route.continue();
  });
  await context.addInitScript((value) => {
    if (!localStorage.getItem('relay-chat-auth-v1'))
      localStorage.setItem('relay-chat-auth-v1', JSON.stringify(value));
  }, a);
  return control;
}
const main = (page: Page) => page.getByRole('main');
const input = (page: Page) => main(page).getByRole('textbox', { name: 'Message', exact: true });
async function workspace(page: Page, name = 'First workspace') {
  // Account changes and reloads open Home. Enter this fixture's conversation
  // explicitly before exercising its draft privacy and storage assertions.
  await page.getByRole('complementary').getByRole('button', { name, exact: true }).click();
  await expect(main(page).getByRole('heading', { name, exact: true })).toBeVisible();
}
async function opened(page: Page, name = 'First workspace') {
  await page.goto(base);
  await workspace(page, name);
}
async function settings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return page
    .getByRole('dialog', { name: 'Settings', exact: true })
    .getByRole('switch', { name: 'Save drafts on this device', exact: true });
}
async function stored(page: Page, key: string) {
  return page.evaluate((key) => localStorage.getItem(key), key);
}
async function switchAccount(context: BrowserContext, s: typeof a) {
  const tab = await context.newPage(),
    nonce = '00000000-0000-4000-8000-000000000666';
  await tab.addInitScript(
    ({ key, nonce }) =>
      sessionStorage.setItem(key, JSON.stringify({ nonce, createdAt: Date.now() })),
    { key: LOGIN_REQUEST_KEY, nonce },
  );
  const hash = new URLSearchParams({
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_in: '3600',
    token_type: 'bearer',
  });
  await tab.goto(`${base}/?${LOGIN_NONCE_QUERY}=${nonce}#${hash}`);
  await workspace(tab, s.user.id === first ? 'First workspace' : 'Second workspace');
  return tab;
}

test('opting out keeps current text/files and retry identity, removes saved copies and does not restore after reload', async ({
  page,
  context,
}) => {
  const control = await fixture(context);
  await opened(page);
  await input(page).fill('Private draft remains in this visit');
  await page.locator('input[type=file]').setInputFiles({
    name: 'private-notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Private local notes'),
  });
  await expect(
    main(page).getByRole('button', { name: 'Remove private-notes.txt', exact: true }),
  ).toBeVisible();
  await expect.poll(() => stored(page, savedDraftsKey(first))).not.toBeNull();
  control.failSend = true;
  await main(page).getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(main(page).locator('.composer-status')).toContainText('Send not confirmed');
  const retryKey = `relay-chat-send-ids-v1:${first}`,
    retry = await stored(page, retryKey);
  expect(retry).not.toBeNull();
  const toggle = await settings(page);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(await stored(page, savedDraftsKey(first))).toBeNull();
  expect(await stored(page, retryKey)).toBe(retry);
  await page.keyboard.press('Escape');
  await expect(input(page)).toHaveValue('Private draft remains in this visit');
  await expect(
    main(page).getByRole('button', { name: 'Remove private-notes.txt', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('complementary')
    .getByRole('button', { name: 'Side workspace', exact: true })
    .click();
  await page
    .getByRole('complementary')
    .getByRole('button', { name: 'First workspace', exact: true })
    .click();
  await expect(input(page)).toHaveValue('Private draft remains in this visit');
  expect(await stored(page, savedDraftsKey(first))).toBeNull();
  await page.reload();
  await workspace(page);
  await expect(input(page)).toHaveValue('');
  await expect(main(page).locator('.draft-attachments')).toHaveCount(0);
  expect(await stored(page, retryKey)).toBe(retry);
  await expect(await settings(page)).toHaveAttribute('aria-checked', 'false');
});

test('opting back in saves the current draft, while stale saved copies are never restored under an opt-out', async ({
  page,
  context,
}) => {
  await fixture(context);
  await page.addInitScript(
    ({ pref, drafts, cid }) => {
      if (sessionStorage.getItem('privacy-seeded')) return;
      sessionStorage.setItem('privacy-seeded', 'yes');
      localStorage.setItem(pref, 'off');
      localStorage.setItem(
        drafts,
        JSON.stringify({ [cid]: { text: 'Old private copy must not restore', attachments: [] } }),
      );
    },
    { pref: draftSavingKey(first), drafts: savedDraftsKey(first), cid },
  );
  await opened(page);
  await expect(input(page)).toHaveValue('');
  expect(await stored(page, savedDraftsKey(first))).toBeNull();
  await input(page).fill('New draft explicitly chosen for saving');
  const toggle = await settings(page);
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.press('Space');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect
    .poll(async () => JSON.parse((await stored(page, savedDraftsKey(first))) || '{}')[cid]?.text)
    .toBe('New draft explicitly chosen for saving');
  await page.reload();
  await workspace(page);
  await expect(input(page)).toHaveValue('New draft explicitly chosen for saving');
});

test('another tab’s opt-out preserves each live draft and prevents either tab writing a saved copy', async ({
  page,
  context,
}) => {
  await fixture(context);
  await opened(page);
  const other = await context.newPage();
  await opened(other);
  await input(page).fill('First tab private text');
  await input(other).fill('Other tab private text');
  await (await settings(page)).click();
  const otherToggle = await settings(other);
  await expect(otherToggle).toHaveAttribute('aria-checked', 'false');
  await other.keyboard.press('Escape');
  await expect(input(other)).toHaveValue('Other tab private text');
  await input(other).fill('Other tab edited after opt-out');
  await expect(input(other)).toHaveValue('Other tab edited after opt-out');
  expect(await stored(other, savedDraftsKey(first))).toBeNull();
  await page.keyboard.press('Escape');
  await expect(input(page)).toHaveValue('First tab private text');
  expect(await stored(page, savedDraftsKey(first))).toBeNull();
});

test('draft-saving choices stay account-scoped across actual SDK identity transitions', async ({
  page,
  context,
}) => {
  await fixture(context);
  await opened(page);
  await (await settings(page)).click();
  await page.keyboard.press('Escape');
  await input(page).fill('First account private unsaved text');
  const secondTab = await switchAccount(context, b);
  await workspace(page, 'Second workspace');
  await expect(await settings(page)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(input(page)).toHaveValue('');
  await input(page).fill('Second account’s own saved draft');
  await expect
    .poll(async () => JSON.parse((await stored(page, savedDraftsKey(second))) || '{}')[cid]?.text)
    .toBe('Second account’s own saved draft');
  const returnTab = await switchAccount(context, a);
  await workspace(page);
  await expect(await settings(page)).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(input(page)).toHaveValue('');
  expect(await stored(page, savedDraftsKey(first))).toBeNull();
  await returnTab.close();
  await secondTab.close();
});

test('failed saved-copy removal is disclosed without clearing the active draft or falsely claiming privacy', async ({
  page,
  context,
}) => {
  await fixture(context);
  await opened(page);
  await input(page).fill('Private draft kept while clearing fails');
  await expect.poll(() => stored(page, savedDraftsKey(first))).not.toBeNull();
  await page.evaluate((key) => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (name) {
      if (name === key) throw new Error('Synthetic removal failure');
      return remove.call(this, name);
    };
  }, savedDraftsKey(first));
  const toggle = await settings(page);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.toast')).toContainText('saved copies could not be cleared');
  expect(await stored(page, savedDraftsKey(first))).not.toBeNull();
  await page.keyboard.press('Escape');
  await expect(input(page)).toHaveValue('Private draft kept while clearing fails');
  await page.reload();
  await workspace(page);
  await expect(input(page)).toHaveValue('');
  await expect(await settings(page)).toHaveAttribute('aria-checked', 'false');
});

test.describe('phone privacy controls', () => {
  test.use({
    viewport: { width: 390, height: 460 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  });
  test('the dark short-phone draft switch has a reachable touch target and bounded privacy text', async ({
    page,
    context,
  }, info) => {
    await fixture(context);
    await page.goto(base);
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'More', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'More in Chat', exact: true })
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    const toggle = dialog.getByRole('switch', { name: 'Save drafts on this device', exact: true });
    await toggle.scrollIntoViewIfNeeded();
    const box = await toggle.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(460);
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(dialog).toContainText('They won’t be restored after a reload.');
    expect(await stored(page, draftSavingKey(first))).toBe('off');
    await page.screenshot({ path: info.outputPath('dark-phone-draft-privacy.png') });
  });
});
