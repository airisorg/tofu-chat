import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page, type Route } from './coverage-test';
import type { ChatAction, ChatState, Person } from '../src/lib/types';

// Deliberately fake auth and localhost route fixtures. This tests visible UI
// recovery, not a real provider, production receipts, SQL or hosted transport.
const baseURL = process.env.APP_URL || 'http://127.0.0.1:3000';
const origin = new URL(baseURL).origin;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname))
  throw new Error('Local fixtures only.');
const provider = 'https://network-ux.invalid';
const userId = '00000000-0000-4000-8000-000000000111';
const conversationId = '00000000-0000-4000-8000-000000000222';
const ownId = '00000000-0000-4000-8000-000000000444';
const peerId = '00000000-0000-4000-8000-000000000555';
const protectedConversationId = '00000000-0000-4000-8000-000000000666';
type WireAction = ChatAction & { clientActionId?: string; clientMessageId?: string };

class FaultFixture {
  user: Person = {
    id: userId,
    name: 'Network Test Person',
    email: 'network@example.invalid',
    color: '#1967d2',
    status: 'Active',
  };
  peer: Person = {
    id: '00000000-0000-4000-8000-000000000333',
    name: 'Network Test Peer',
    email: 'peer@example.invalid',
    color: '#b06c49',
  };
  state: ChatState = {
    user: this.user,
    conversations: [
      {
        id: conversationId,
        name: 'Network workspace',
        kind: 'space',
        members: [this.user, this.peer],
        unread: 0,
        updatedAt: new Date().toISOString(),
      },
    ],
    messages: [
      {
        id: ownId,
        conversationId,
        author: this.user,
        text: 'Original own message remains intact.',
        createdAt: new Date().toISOString(),
        attachments: [],
        reactions: [],
      },
      {
        id: peerId,
        conversationId,
        author: this.peer,
        text: 'Loaded messages stay available during outages.',
        createdAt: new Date().toISOString(),
        attachments: [],
        reactions: [],
      },
    ],
  };
  mode: 'ok' | 'reject' | 'hold' | 'lost' = 'ok';
  getOutage = false;
  authOutage = false;
  actions: WireAction[] = [];
  uploads = 0;
  getFailures = 0;
  release: (() => void) | null = null;
  completionMarker: string | null = null;
  completionMarkerExclusiveToPost = false;
  staged = new Map<string, { name: string; type: string; size: number; url: string }>();
  receipts = new Map<string, string | undefined>();
  publicState(includeCompletionMarker = true) {
    const state = structuredClone(this.state);
    if (!includeCompletionMarker && this.completionMarker)
      state.messages = state.messages.filter((message) => message.text !== this.completionMarker);
    for (const message of state.messages)
      message.attachments = message.attachments.map((file, index) => ({
        ...file,
        url: `/api/attachments?messageId=${message.id}&index=${index}`,
      }));
    return state;
  }
  async post(route: Route) {
    const action = route.request().postDataJSON() as WireAction;
    this.actions.push(structuredClone(action));
    if (this.mode === 'reject')
      return route.fulfill({
        status: 503,
        json: { error: 'Temporary service outage. Please try again.' },
      });
    if (this.mode === 'hold')
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    const receipt = action.clientMessageId || action.clientActionId;
    let id = receipt ? this.receipts.get(receipt) : undefined;
    const exists = receipt && this.receipts.has(receipt);
    if (!exists) {
      const message =
        'messageId' in action
          ? this.state.messages.find((message) => message.id === action.messageId)!
          : null;
      if (action.type === 'send') {
        id = action.clientMessageId || randomUUID();
        this.state.messages.push({
          id,
          conversationId: action.conversationId,
          author: this.user,
          text: action.text,
          parentId: action.parentId,
          createdAt: new Date().toISOString(),
          reactions: [],
          attachments: (action.attachments || []).map(
            (file, index) => this.staged.get(`${action.clientMessageId}:${index}`) || file,
          ),
        });
      } else if (action.type === 'star') message!.starred = !message!.starred;
      else if (action.type === 'react')
        message!.reactions = [{ emoji: action.emoji, userIds: [userId] }];
      else if (action.type === 'edit') message!.text = action.text;
      else if (action.type === 'delete') message!.deleted = true;
      else if (action.type === 'profile') this.state.user = { ...this.state.user, ...action };
      else if (action.type === 'conversation') Object.assign(this.state.conversations[0], action);
      else if (action.type === 'invite')
        this.state.conversations[0].members.push(
          ...action.emails.map((email) => ({ id: randomUUID(), email, name: email.split('@')[0] })),
        );
      else if (action.type === 'create') {
        id = randomUUID();
        this.state.conversations.push({
          id,
          name: action.name,
          kind: action.kind,
          members: [this.user],
          updatedAt: new Date().toISOString(),
          unread: 0,
        });
      } else if (action.type === 'leave')
        this.state.conversations = this.state.conversations.filter(
          (conversation) => conversation.id !== action.conversationId,
        );
      if (this.completionMarker)
        this.state.messages.push({
          id: randomUUID(),
          conversationId: protectedConversationId,
          author: this.peer,
          text: this.completionMarker,
          createdAt: new Date().toISOString(),
          reactions: [],
          attachments: [],
        });
      if (receipt) this.receipts.set(receipt, id);
    }
    if (this.mode === 'lost') {
      this.mode = 'ok';
      return route.abort('connectionreset');
    }
    return route.fulfill({ status: 200, json: { state: this.publicState(), id } });
  }
}
const activeFixtures = new WeakMap<Page, FaultFixture>();
test.afterEach(async ({ page }) => {
  activeFixtures.get(page)?.release?.();
});

async function fixture(page: Page, context: BrowserContext, phone = false) {
  if (phone) await page.setViewportSize({ width: 390, height: 844 });
  const api = new FaultFixture();
  activeFixtures.set(page, api);
  const now = Math.floor(Date.now() / 1000);
  const token = [
    Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
    Buffer.from(
      JSON.stringify({
        sub: userId,
        role: 'authenticated',
        aud: 'authenticated',
        iat: now,
        exp: now + 3600,
      }),
    ).toString('base64url'),
    'LOCAL_TEST_INVALID_SIGNATURE',
  ].join('.');
  const user = {
    id: userId,
    aud: 'authenticated',
    role: 'authenticated',
    email: api.user.email,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: api.user.name },
    created_at: new Date().toISOString(),
    email_confirmed_at: new Date().toISOString(),
  };
  await context.addInitScript(
    ({ token, user, now }) => {
      localStorage.removeItem('relay-chat-demo-choice-v1');
      localStorage.setItem(
        'relay-chat-auth-v1',
        JSON.stringify({
          access_token: token,
          refresh_token: 'LOCAL_TEST_NOT_REAL',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: now + 3600,
          user,
        }),
      );
    },
    { token, user, now },
  );
  await page.routeWebSocket(`${provider.replace('https:', 'wss:')}/**`, (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      if (url.origin === provider && url.pathname === '/auth/v1/user')
        return route.fulfill({
          status: api.authOutage ? 503 : 200,
          json: api.authOutage ? { error: 'Temporary identity provider outage.' } : user,
        });
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/config')
      return route.fulfill({
        status: 200,
        json: {
          supabaseUrl: provider,
          supabaseAnonKey: 'sb_publishable_LOCAL_ONLY',
          databaseConfigured: true,
          signInUrl: 'https://sign-in.example.test/start',
        },
      });
    if (url.pathname === '/api/chat') {
      if (request.headers().authorization !== `Bearer ${token}`)
        return route.fulfill({
          status: 401,
          json: { error: 'Local fixture requires restored session.' },
        });
      if (request.method() === 'POST') return api.post(route);
      if (api.getOutage) {
        api.getFailures++;
        return route.fulfill({ status: 503, json: { error: 'Temporary refresh outage.' } });
      }
      const actionId = url.searchParams.get('clientActionId');
      return route.fulfill({
        status: 200,
        json: {
          state: api.publicState(!api.completionMarkerExclusiveToPost),
          ...(actionId && api.receipts.has(actionId)
            ? { actionId, id: api.receipts.get(actionId) }
            : {}),
        },
      });
    }
    if (url.pathname === '/api/uploads') {
      api.uploads++;
      const chunk = request.postDataJSON();
      api.staged.set(`${chunk.clientMessageId}:${chunk.attachmentIndex}`, {
        name: chunk.name,
        type: chunk.type,
        size: chunk.size,
        url: `data:${chunk.type};base64,${chunk.data}`,
      });
      return route.fulfill({ status: 200, json: { ok: true } });
    }
    if (url.pathname === '/api/attachments') {
      const file = api.state.messages.find(
        (message) => message.id === url.searchParams.get('messageId'),
      )?.attachments[Number(url.searchParams.get('index'))];
      if (!file) return route.fulfill({ status: 404, json: { error: 'Local file unavailable.' } });
      return route.fulfill({
        status: 200,
        contentType: file.type,
        body: Buffer.from(file.url.split(',')[1], 'base64'),
      });
    }
    return route.continue();
  });
  await page.goto(baseURL);
  await page
    .getByRole('button', { name: /Network workspace/ })
    .first()
    .click();
  await expect(
    page.getByRole('main').getByRole('heading', { name: 'Network workspace', exact: true }),
  ).toBeVisible();
  return api;
}

const own = (page: Page) =>
  page
    .getByRole('main')
    .getByRole('article')
    .filter({ hasText: 'Original own message remains intact.' });
async function clearNotices(page: Page) {
  for (const label of ['Dismiss error', 'Dismiss notification']) {
    const control = page.getByRole('button', { name: label, exact: true });
    if (await control.isVisible()) await control.click();
  }
}
async function failure(page: Page, api: FaultFixture, type: ChatAction['type']) {
  await expect
    .poll(() => api.actions.filter((action) => action.type === type).length)
    .toBeGreaterThan(0);
  if (type === 'profile') {
    await expect(
      page.getByRole('dialog', { name: 'Your profile', exact: true }).getByRole('alert'),
    ).toHaveText('Temporary service outage. Please try again.');
    await expect(
      page.locator('.toast').filter({ hasText: 'Temporary service outage.' }),
    ).toHaveCount(0);
  } else {
    await expect(page.locator('.toast')).toContainText('Temporary service outage.');
    await expect(page.locator('.toast > svg')).toHaveClass(/lucide-info/);
  }
  await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toHaveCount(
    0,
  );
}

test('held acknowledgement exposes busy confirmation and preserves text entered during send', async ({
  page,
  context,
}, info) => {
  const api = await fixture(page, context);
  api.mode = 'hold';
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('First payload is waiting for confirmation.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => !!api.release).toBe(true);
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await expect(send).toBeDisabled();
  await expect(send).toHaveAttribute('aria-busy', 'true');
  await expect(send.locator('.send-spinner')).toBeVisible();
  await expect(page.locator('.composer-status')).toHaveText('Sending… Waiting for confirmation.');
  await expect(
    page.getByRole('article').filter({ hasText: 'First payload is waiting for confirmation.' }),
  ).toHaveCount(0);
  await input.fill('A newer draft must survive the older acknowledgement.');
  if (info.project.name === 'Chrome') {
    await page.screenshot({ path: info.outputPath('desktop-send-confirmation-browser-test.png') });
  }
  api.release!();
  await expect(send).toBeEnabled();
  await expect(
    page.getByRole('article').filter({ hasText: 'First payload is waiting for confirmation.' }),
  ).toHaveCount(1);
  await expect(input).toHaveValue('A newer draft must survive the older acknowledgement.');
  await expect(page.locator('.composer-status')).toHaveCount(0);
});

test('failed image send keeps the payload, gives an honest storage warning and retries the same identity', async ({
  page,
  context,
}, info) => {
  const api = await fixture(page, context, true);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        key.startsWith('relay-drafts:') &&
        Object.values(JSON.parse(value)).some(
          (draft) =>
            typeof draft === 'object' &&
            draft !== null &&
            'attachments' in draft &&
            Array.isArray(draft.attachments) &&
            draft.attachments.length > 0,
        )
      )
        throw new DOMException('Local quota simulation', 'QuotaExceededError');
      return original.call(this, key, value);
    };
    document.documentElement.dataset.theme = 'dark';
  });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'retained-image.png', mimeType: 'image/png', buffer: png });
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('Keep my image and text until confirmed.');
  await expect(page.locator('.composer-status')).toContainText(
    'After reloading, check the conversation before adding files and sending again.',
  );
  api.mode = 'reject';
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.composer-status')).toContainText(
    'Send not confirmed. Your draft is kept here. Press Send to retry.',
  );
  await expect(input).toHaveValue('Keep my image and text until confirmed.');
  await expect(page.getByRole('button', { name: 'Remove retained-image.png' })).toBeVisible();
  await expect(
    page.getByRole('article').filter({ hasText: 'Keep my image and text until confirmed.' }),
  ).toHaveCount(0);
  await failure(page, api, 'send');
  const status = await page.locator('.composer-status').boundingBox();
  expect(status!.x).toBeGreaterThanOrEqual(0);
  expect(status!.x + status!.width).toBeLessThanOrEqual(390);
  expect(status!.y + status!.height).toBeLessThanOrEqual(844);
  const contrast = await page.locator('.composer-status').evaluate((node) => {
    const luminance = (color: string) =>
      color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const foreground = luminance(getComputedStyle(node).color);
    const background = luminance(getComputedStyle(node.closest('.composer-wrap')!).backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  if (info.project.name === 'Chrome')
    await page.screenshot({
      path: info.outputPath('iphone-dark-send-not-confirmed-browser-test.png'),
    });
  await clearNotices(page);
  api.mode = 'ok';
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toBeEmpty();
  await expect(
    page.getByRole('article').filter({ hasText: 'Keep my image and text until confirmed.' }),
  ).toHaveCount(1);
  await expect
    .poll(() =>
      page
        .getByRole('img', { name: 'retained-image.png', exact: true })
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  const sends = api.actions.filter((action) => action.type === 'send');
  expect(sends).toHaveLength(2);
  expect(sends[1].clientMessageId).toBe(sends[0].clientMessageId);
  expect(api.state.messages.at(-1)?.attachments[0].url).toBe(
    `data:image/png;base64,${png.toString('base64')}`,
  );
  await expect(page.locator('.composer-status')).toHaveCount(0);
});

test('offline hint permits explicit attempts and an actual failure keeps the draft until retry', async ({
  page,
  context,
}) => {
  const api = await fixture(page, context, true);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('A connection hint cannot prohibit this deliberate attempt.');
  await expect(page.locator('.composer-status')).toContainText('You may be offline.');
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await expect(send).toBeEnabled();
  api.mode = 'reject';
  await send.click();
  await expect(page.locator('.composer-status')).toContainText('Send not confirmed.');
  expect(api.actions.filter((action) => action.type === 'send')).toHaveLength(1);
  await expect(input).toHaveValue('A connection hint cannot prohibit this deliberate attempt.');
  api.mode = 'ok';
  await clearNotices(page);
  await send.click();
  await expect(input).toBeEmpty();
  await expect(
    page
      .getByRole('article')
      .filter({ hasText: 'A connection hint cannot prohibit this deliberate attempt.' }),
  ).toHaveCount(1);
  // navigator still reports false: the successful response, not its hint,
  // establishes that this user-requested action was acknowledged.
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
});

test('reaction and star failures keep existing state and permit an intentional retry', async ({
  page,
  context,
}) => {
  const api = await fixture(page, context);
  api.mode = 'reject';
  await own(page).hover();
  await own(page).getByRole('button', { name: 'React 👍', exact: true }).click();
  await failure(page, api, 'react');
  await expect(
    own(page).getByRole('button', { name: /reaction.*Toggle your reaction/ }),
  ).toHaveCount(0);
  await clearNotices(page);
  await own(page).hover();
  await own(page).getByRole('button', { name: 'Star message', exact: true }).click();
  await failure(page, api, 'star');
  await expect(own(page).getByRole('button', { name: 'Star message', exact: true })).toBeVisible();
  await expect(own(page).getByRole('button', { name: 'Unstar message', exact: true })).toHaveCount(
    0,
  );
  await clearNotices(page);
  api.mode = 'ok';
  await own(page).hover();
  await own(page).getByRole('button', { name: 'Star message', exact: true }).click();
  await expect(
    own(page).getByRole('button', { name: 'Unstar message', exact: true }),
  ).toBeVisible();
  const stars = api.actions.filter((action) => action.type === 'star');
  expect(stars).toHaveLength(2);
  expect(stars[1].clientActionId).toBe(stars[0].clientActionId);
});

test('edit and delete failures preserve original content and the reviewable form', async ({
  page,
  context,
}) => {
  const api = await fixture(page, context);
  api.mode = 'reject';
  await own(page).hover();
  await own(page).getByRole('button', { name: 'Edit message', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Edit message', exact: true });
  await dialog
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('A rejected edit must stay in this form.');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await failure(page, api, 'edit');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'A rejected edit must stay in this form.',
  );
  await expect(own(page)).toBeVisible();
  await clearNotices(page);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await own(page).hover();
  await own(page).getByRole('button', { name: 'More actions', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete message', exact: true })
    .click();
  dialog = page.getByRole('dialog', { name: 'Delete this message?', exact: true });
  await dialog.getByRole('button', { name: 'Delete message', exact: true }).click();
  await failure(page, api, 'delete');
  await expect(dialog).toBeVisible();
  await expect(own(page)).toBeVisible();
  expect(api.state.messages.find((message) => message.id === ownId)?.deleted).toBeFalsy();
});

test('a lost star acknowledgement is confirmed by its receipt without replaying the toggle', async ({
  page,
  context,
}) => {
  const api = await fixture(page, context);
  api.mode = 'lost';
  await own(page).hover();
  await own(page).getByRole('button', { name: 'Star message', exact: true }).click();
  await expect(
    own(page).getByRole('button', { name: 'Unstar message', exact: true }),
  ).toBeVisible();
  expect(api.actions.filter((action) => action.type === 'star')).toHaveLength(1);
  await expect(page.locator('.toast')).toHaveCount(0);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await own(page).getByRole('button', { name: 'Unstar message', exact: true }).click();
  await expect(own(page).getByRole('button', { name: 'Star message', exact: true })).toBeVisible();
  const stars = api.actions.filter((action) => action.type === 'star');
  expect(stars).toHaveLength(2);
  expect(stars[1].clientActionId).not.toBe(stars[0].clientActionId);
});

test('create, invite and profile failures retain entered intent and never claim success', async ({
  page,
  context,
}) => {
  const api = await fixture(page, context);
  api.mode = 'reject';
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog
    .getByRole('combobox', { name: 'To', exact: true })
    .fill('new-person@example.invalid');
  await dialog.getByRole('button', { name: 'Start chat', exact: true }).click();
  await failure(page, api, 'create');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'To', exact: true })).toHaveValue(
    'new-person@example.invalid',
  );
  expect(api.state.conversations).toHaveLength(1);
  await clearNotices(page);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Conversation details', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add people', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Add people', exact: true });
  await dialog.getByRole('textbox', { name: 'Email addresses' }).fill('invited@example.invalid');
  await dialog.getByRole('button', { name: 'Add people', exact: true }).click();
  await failure(page, api, 'invite');
  await expect(dialog.getByRole('textbox', { name: 'Email addresses' })).toHaveValue(
    'invited@example.invalid',
  );
  expect(api.state.conversations[0].members).toHaveLength(2);
  await clearNotices(page);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Your profile', exact: true }).first().click();
  dialog = page.getByRole('dialog', { name: 'Your profile', exact: true });
  await dialog.getByRole('textbox', { name: 'Display name' }).fill('Unconfirmed profile name');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await failure(page, api, 'profile');
  await expect(dialog.getByRole('textbox', { name: 'Display name' })).toHaveValue(
    'Unconfirmed profile name',
  );
  expect(api.state.user.name).toBe('Network Test Person');
  await expect(page.getByText('Conversation started', { exact: true })).toHaveCount(0);
  await expect(page.getByText('People added', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Profile updated', { exact: true })).toHaveCount(0);
  await clearNotices(page);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Conversation details', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Edit details and section' }).click();
  dialog = page.getByRole('dialog', { name: 'Conversation settings', exact: true });
  await dialog
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('Unconfirmed conversation name');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await failure(page, api, 'conversation');
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
    'Unconfirmed conversation name',
  );
  expect(api.state.conversations[0].name).toBe('Network workspace');
  await clearNotices(page);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Conversation details', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Leave conversation', exact: true })
    .click();
  dialog = page.getByRole('dialog', { name: 'Leave this conversation?', exact: true });
  await dialog.getByRole('button', { name: 'Leave conversation', exact: true }).click();
  await failure(page, api, 'leave');
  await expect(dialog).toBeVisible();
  expect(api.state.conversations).toHaveLength(1);
  await expect(
    page.getByRole('main').getByRole('heading', { name: 'Network workspace', exact: true }),
  ).toBeVisible();
});

test('refresh outage keeps navigation, search and local appearance available', async ({
  page,
  context,
}) => {
  const api = await fixture(page, context);
  api.getOutage = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => api.getFailures).toBeGreaterThan(0);
  await expect(page.locator('.error-banner')).toContainText('Temporary refresh outage.');
  await expect(own(page)).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog').getByRole('combobox', { name: 'Appearance' }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(
    page.getByRole('main').getByRole('heading', { name: 'Home', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Search in chat', exact: true })
    .fill('Loaded messages stay available');
  await expect(
    page.getByRole('main').getByRole('heading', { name: 'Search results', exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('main')
      .getByRole('button', { name: /^Message from/ })
      .filter({ hasText: 'Loaded messages stay available during outages.' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toHaveCount(
    0,
  );
  api.getOutage = false;
  api.state.messages.push({
    ...api.state.messages[1],
    id: randomUUID(),
    text: 'Recovered data appears without replacing the workspace.',
  });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page
    .getByRole('main')
    .getByRole('button', { name: /^Network workspace / })
    .click();
  await expect(
    page
      .getByRole('article')
      .filter({ hasText: 'Recovered data appears without replacing the workspace.' }),
  ).toBeVisible();
});

for (const type of ['create', 'conversation', 'invite', 'edit', 'leave', 'delete'] as const) {
  test(`held ${type} completion preserves a newer profile and separate conversation draft`, async ({
    page,
    context,
  }) => {
    const api = await fixture(page, context);
    api.state.conversations.push({
      id: protectedConversationId,
      name: 'Protected workspace',
      kind: 'space',
      members: [api.user, api.peer],
      unread: 0,
      updatedAt: new Date().toISOString(),
    });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(
      page.getByRole('button', { name: 'Protected workspace', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Original conversation draft remains owned by its conversation.');
    api.completionMarker = `Authoritative response for held ${type} is rendered.`;
    api.completionMarkerExclusiveToPost = true;
    api.mode = 'hold';
    if (type === 'create') {
      await page.getByRole('button', { name: 'New chat', exact: true }).click();
      const form = page.getByRole('dialog', { name: 'Start a conversation', exact: true });
      await form
        .getByRole('combobox', { name: 'To', exact: true })
        .fill('late-create@example.invalid');
      await form.getByRole('button', { name: 'Start chat', exact: true }).click();
    } else if (type === 'edit' || type === 'delete') {
      await own(page).hover();
      if (type === 'edit') {
        await own(page).getByRole('button', { name: 'Edit message', exact: true }).click();
        const form = page.getByRole('dialog', { name: 'Edit message', exact: true });
        await form
          .getByRole('textbox', { name: 'Message', exact: true })
          .fill('Acknowledged old edit.');
        await form.getByRole('button', { name: 'Save', exact: true }).click();
      } else {
        await own(page).getByRole('button', { name: 'More actions', exact: true }).click();
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Delete message', exact: true })
          .click();
        await page
          .getByRole('dialog', { name: 'Delete this message?', exact: true })
          .getByRole('button', { name: 'Delete message', exact: true })
          .click();
      }
    } else {
      await page.getByRole('button', { name: 'Conversation details', exact: true }).click();
      if (type === 'conversation') {
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Edit details and section' })
          .click();
        const form = page.getByRole('dialog', { name: 'Conversation settings', exact: true });
        await form
          .getByRole('textbox', { name: 'Name', exact: true })
          .fill('Acknowledged old conversation rename');
        await form.getByRole('button', { name: 'Save', exact: true }).click();
      } else if (type === 'invite') {
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Add people', exact: true })
          .click();
        const form = page.getByRole('dialog', { name: 'Add people', exact: true });
        await form
          .getByRole('textbox', { name: 'Email addresses' })
          .fill('late-invite@example.invalid');
        await form.getByRole('button', { name: 'Add people', exact: true }).click();
      } else {
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Leave conversation', exact: true })
          .click();
        await page
          .getByRole('dialog', { name: 'Leave this conversation?', exact: true })
          .getByRole('button', { name: 'Leave conversation', exact: true })
          .click();
      }
    }
    try {
      await expect.poll(() => api.actions.filter((action) => action.type === type).length).toBe(1);
      await expect.poll(() => !!api.release).toBe(true);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Protected workspace', exact: true }).click();
      await expect(
        page.getByRole('main').getByRole('heading', { name: 'Protected workspace', exact: true }),
      ).toBeVisible();
      await page
        .getByRole('textbox', { name: 'Message', exact: true })
        .fill('A separate newer draft must remain intact.');
      await page.getByRole('button', { name: 'Your profile', exact: true }).first().click();
      const profile = page.getByRole('dialog', { name: 'Your profile', exact: true });
      await profile
        .getByRole('textbox', { name: 'Display name', exact: true })
        .fill('New profile while old action waits');
      await profile.getByRole('textbox', { name: 'Status', exact: true }).fill('New local status');
      api.mode = 'ok';
      api.release!();
      const receipt = api.actions.find((action) => action.type === type)!.clientActionId;
      await expect.poll(() => !!receipt && api.receipts.has(receipt)).toBe(true);
      const committed = () =>
        type === 'create'
          ? api.state.conversations.length === 3
          : type === 'conversation'
            ? api.state.conversations.find((c) => c.id === conversationId)?.name ===
              'Acknowledged old conversation rename'
            : type === 'invite'
              ? api.state.conversations
                  .find((c) => c.id === conversationId)
                  ?.members.some((p) => p.email === 'late-invite@example.invalid')
              : type === 'edit'
                ? api.state.messages.find((m) => m.id === ownId)?.text === 'Acknowledged old edit.'
                : type === 'delete'
                  ? api.state.messages.find((m) => m.id === ownId)?.deleted
                  : !api.state.conversations.some((c) => c.id === conversationId);
      await expect.poll(committed).toBe(true);
      // A peer-message marker exists only in the committed response. Requiring
      // the real UI row prevents a pre-ACK snapshot or intervening GET from
      // satisfying the guard before the old POST is processed by the controller.
      await expect(
        page.getByRole('article').filter({ hasText: api.completionMarker }),
      ).toBeVisible();
      api.completionMarkerExclusiveToPost = false;
      await expect(profile).toBeVisible();
      await expect(profile.getByRole('textbox', { name: 'Display name', exact: true })).toHaveValue(
        'New profile while old action waits',
      );
      await expect(profile.getByRole('textbox', { name: 'Status', exact: true })).toHaveValue(
        'New local status',
      );
      await expect(
        page.locator('.toast').filter({
          hasText:
            /Conversation started|Conversation updated|People added|Message updated|Message deleted|You left the conversation/,
        }),
      ).toHaveCount(0);
      await profile.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(
        page.getByRole('main').getByRole('heading', { name: 'Protected workspace', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
        'A separate newer draft must remain intact.',
      );
      expect(api.actions.filter((action) => action.type === type)).toHaveLength(1);
    } finally {
      api.mode = 'ok';
      api.release?.();
    }
  });
}
