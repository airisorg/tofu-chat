import { expect, test, type Page, type BrowserContext } from './coverage-test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChatAction, ChatState, Person } from '../src/lib/types';

// Local engine checks use a disposable demo or fake SDK session and routed
// localhost APIs. They do not visit hosted apps, use real Google credentials,
// access a database, or establish physical-device/provider proof.
const main = (page: Page) => page.getByRole('main');
const panel = (page: Page, name = 'Design team') =>
  page.getByRole('region', { name: `Mini conversation: ${name}`, exact: true });
const miniInput = (page: Page, name?: string) =>
  panel(page, name).getByRole('textbox', { name: 'Message in pop-up', exact: true });
const mainInput = (page: Page) => main(page).getByRole('textbox', { name: 'Message', exact: true });
const mainMessage = (page: Page, text: string) =>
  main(page)
    .getByRole('article')
    .filter({ has: page.locator('.message-text').filter({ hasText: text }) });

async function conversation(page: Page, name: string) {
  await page.getByRole('complementary').getByRole('button', { name, exact: true }).click();
  await expect(main(page).getByRole('heading', { name, exact: true })).toBeVisible();
}

async function demo(page: Page) {
  await page.route('**/api/config', (route) =>
    route.fulfill({ json: { supabaseUrl: '', supabaseAnonKey: '', databaseConfigured: false } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore demo', exact: true }).click();
  await conversation(page, 'Design team');
}
async function open(page: Page, name = 'Design team') {
  await main(page).getByRole('button', { name: 'Open in a pop-up', exact: true }).click();
  await expect(panel(page, name)).toBeVisible();
  await expect(miniInput(page, name)).toBeVisible();
}
async function noOverflow(page: Page) {
  const sizes = await page.evaluate(() => ({
    width: innerWidth,
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(sizes.doc).toBeLessThanOrEqual(sizes.width + 1);
  expect(sizes.body).toBeLessThanOrEqual(sizes.width + 1);
}

test('pop-up minimizes, restores, sends and reopens without an acknowledged draft', async ({
  page,
}) => {
  await demo(page);
  await open(page);
  expect((await panel(page).boundingBox())!.width).toBe(420);
  expect((await panel(page).boundingBox())!.height).toBe(500);
  await miniInput(page).fill('A local pop-up message.');
  await panel(page).getByRole('button', { name: 'Minimize pop-up', exact: true }).click();
  expect((await panel(page).boundingBox())!.width).toBe(224);
  expect((await panel(page).boundingBox())!.height).toBe(44);
  await expect(miniInput(page)).toHaveCount(0);
  await panel(page).getByRole('button', { name: 'Restore pop-up', exact: true }).click();
  await expect(miniInput(page)).toHaveValue('A local pop-up message.');
  await panel(page).getByRole('button', { name: 'Send pop-up message', exact: true }).click();
  await expect(
    panel(page).getByRole('article').filter({ hasText: 'A local pop-up message.' }),
  ).toHaveCount(1);
  await expect(mainMessage(page, 'A local pop-up message.')).toHaveCount(1);
  await expect(miniInput(page)).toHaveValue('');
  await panel(page).getByRole('button', { name: 'Close pop-up', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await open(page);
  await expect(miniInput(page)).toHaveValue('');
});

test('main and pop-up drafts remain separate and expanding preserves both', async ({ page }) => {
  await demo(page);
  await mainInput(page).fill('Existing full conversation draft');
  await open(page);
  await expect(miniInput(page)).toHaveValue('');
  await miniInput(page).fill('Draft moving from the pop-up');
  await expect(mainInput(page)).toHaveValue('Existing full conversation draft');
  await panel(page).getByRole('button', { name: 'Expand conversation', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(mainInput(page)).toHaveValue('Draft moving from the pop-up');
  await open(page);
  await expect(miniInput(page)).toHaveValue('Existing full conversation draft');
  await panel(page).getByRole('button', { name: 'Close pop-up', exact: true }).click();
  await expect(mainInput(page)).toHaveValue('Draft moving from the pop-up');
});

test('one pop-up retains conversation drafts while the main navigation stays usable', async ({
  page,
}) => {
  await demo(page);
  await open(page);
  await miniInput(page).fill('Design pop-up draft');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(main(page).getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await expect(miniInput(page)).toHaveValue('Design pop-up draft');
  await main(page).getByRole('button', { name: 'Options for Maya Chen', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Open in a pop-up', exact: true })
    .click();
  await expect(page.getByRole('region', { name: /^Mini conversation:/ })).toHaveCount(1);
  await miniInput(page, 'Maya Chen').fill('Maya pop-up draft');
  await main(page).getByRole('button', { name: 'Options for Design team', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Open in a pop-up', exact: true })
    .click();
  await expect(miniInput(page)).toHaveValue('Design pop-up draft');
  await expect(page.getByRole('region', { name: /^Mini conversation:/ })).toHaveCount(1);
});

test('dark pop-up geometry keeps composer and controls inside its visible panel', async ({
  page,
  context,
}) => {
  await context.addInitScript(() => localStorage.setItem('relay-theme', 'dark'));
  await demo(page);
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const geometry = await panel(page).evaluate((element) => {
    const box = element.getBoundingClientRect();
    const input = element.querySelector('textarea')!.getBoundingClientRect();
    const buttons = Array.from(element.querySelectorAll('button'))
      .filter((button) => !button.closest('article') && button.getBoundingClientRect().width > 0)
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          name: button.getAttribute('aria-label'),
          x: rect.x,
          y: rect.y,
          right: rect.right,
          bottom: rect.bottom,
        };
      });
    return {
      x: box.x,
      y: box.y,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
      viewWidth: innerWidth,
      viewHeight: innerHeight,
      background: getComputedStyle(element).backgroundColor,
      inputBottom: input.bottom,
      buttons,
    };
  });
  expect(geometry.width).toBeGreaterThanOrEqual(320);
  expect(geometry.x).toBeGreaterThanOrEqual(0);
  expect(geometry.y).toBeGreaterThanOrEqual(64);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewWidth);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewHeight);
  expect(geometry.viewHeight - geometry.bottom).toBe(16);
  expect(geometry.inputBottom).toBeLessThanOrEqual(geometry.bottom);
  expect(geometry.background).not.toBe('rgb(255, 255, 255)');
  for (const button of geometry.buttons) {
    expect(button.x, `${button.name} left`).toBeGreaterThanOrEqual(geometry.x);
    expect(button.y, `${button.name} top`).toBeGreaterThanOrEqual(geometry.y);
    expect(button.right, `${button.name} right`).toBeLessThanOrEqual(geometry.right);
    expect(button.bottom, `${button.name} bottom`).toBeLessThanOrEqual(geometry.bottom);
  }
  await noOverflow(page);
});

test('desktop-to-phone resize transfers the unsent pop-up draft into full conversation', async ({
  page,
}) => {
  await demo(page);
  await open(page);
  await miniInput(page).fill('Pop-up draft survives phone resize');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel(page)).toHaveCount(0);
  await expect(mainInput(page)).toHaveValue('Pop-up draft survives phone resize');
  await expect(
    main(page).getByRole('button', { name: 'Open in a pop-up', exact: true }),
  ).toHaveCount(0);
  await noOverflow(page);
});

test('coarse phone menu opens a full conversation and never floats a pop-up', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  });
  try {
    const page = await context.newPage();
    await page.route('**/api/config', (route) =>
      route.fulfill({ json: { supabaseUrl: '', supabaseAnonKey: '', databaseConfigured: false } }),
    );
    await page.goto(baseURL!);
    await page.getByRole('button', { name: 'Explore demo', exact: true }).click();
    if (!(await mainInput(page).isVisible()))
      await main(page)
        .getByRole('button', { name: /Design team/ })
        .first()
        .click();
    await main(page).getByRole('button', { name: 'Conversation details', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Open in a pop-up', exact: true })
      .click();
    await expect(page.getByRole('region', { name: /^Mini conversation:/ })).toHaveCount(0);
    await expect(mainInput(page)).toBeVisible();
    await noOverflow(page);
  } finally {
    await context.close();
  }
});

test('leaving demo closes the pop-up and clears its identity-scoped draft', async ({ page }) => {
  await demo(page);
  await open(page);
  await miniInput(page).fill('Old identity private draft');
  await page.getByRole('button', { name: 'Your profile', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Leave demo', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Explore demo', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Explore demo', exact: true }).click();
  await conversation(page, 'Design team');
  await open(page);
  await expect(miniInput(page)).toHaveValue('');
});

test('small text and real audio files can be attached, previewed and sent from the pop-up', async ({
  page,
}) => {
  await demo(page);
  await open(page);
  const chooser = page.waitForEvent('filechooser');
  await panel(page).getByRole('button', { name: 'Attach files to pop-up', exact: true }).click();
  await (
    await chooser
  ).setFiles([
    {
      name: 'mini-local-note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Synthetic pop-up attachment content.'),
    },
    {
      name: 'mini-local-tone.m4a',
      mimeType: 'audio/mp4',
      buffer: readFileSync(resolve('tests/fixtures/picker-tone.m4a')),
    },
  ]);
  await expect(
    panel(page).getByRole('button', {
      name: 'Remove mini-local-note.txt from pop-up',
      exact: true,
    }),
  ).toBeVisible();
  const preview = panel(page).getByLabel('Pop-up voice note preview', { exact: true });
  await expect(preview).toBeVisible();
  await expect
    .poll(() => preview.evaluate((element: HTMLAudioElement) => element.readyState))
    .toBeGreaterThanOrEqual(1);
  await miniInput(page).fill('Pop-up synthetic attachments');
  await panel(page).getByRole('button', { name: 'Send pop-up message', exact: true }).click();
  await expect(miniInput(page)).toHaveValue('');
  const message = mainMessage(page, 'Pop-up synthetic attachments');
  await expect(message).toHaveCount(1);
  await expect(message.getByRole('link', { name: /mini-local-note.txt/ })).toBeVisible();
  const sentAudio = message.locator('audio');
  await expect(sentAudio).toHaveCount(1);
  await expect(
    message.getByRole('button', { name: 'Play voice message', exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => sentAudio.evaluate((element: HTMLAudioElement) => element.readyState))
    .toBeGreaterThanOrEqual(1);
  await expect(
    panel(page).getByRole('button', {
      name: 'Remove mini-local-note.txt from pop-up',
      exact: true,
    }),
  ).toHaveCount(0);
});

test('pop-up microphone denial is recoverable and cancel preserves the text draft', async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new DOMException('Synthetic local microphone denial', 'NotAllowedError');
        },
      },
    });
  });
  await demo(page);
  await open(page);
  await miniInput(page).fill('Keep this while microphone is denied');
  await panel(page)
    .getByRole('button', { name: 'Record voice note in pop-up', exact: true })
    .click();
  await panel(page).getByRole('button', { name: 'Start recording', exact: true }).click();
  await expect(panel(page).getByRole('alert')).toContainText('Microphone access was denied.');
  await panel(page)
    .getByRole('button', { name: 'Cancel pop-up voice recording', exact: true })
    .click();
  await expect(miniInput(page)).toHaveValue('Keep this while microphone is denied');
  await expect(
    panel(page).getByRole('button', { name: 'Send pop-up message', exact: true }),
  ).toBeEnabled();
  await noOverflow(page);
});

test('shared full emoji search inserts in the pop-up without changing the main draft', async ({
  page,
}) => {
  await demo(page);
  await mainInput(page).fill('Independent main draft');
  await open(page);
  await miniInput(page).fill('Pop-up says ');
  await panel(page).getByRole('button', { name: 'Add emoji to pop-up', exact: true }).click();
  const search = panel(page).getByRole('textbox', { name: 'Search emoji', exact: true });
  await expect(search).toBeVisible();
  await search.fill('melting');
  await panel(page).getByRole('button', { name: 'Insert 🫠', exact: true }).click();
  await expect(miniInput(page)).toHaveValue('Pop-up says 🫠');
  await expect(mainInput(page)).toHaveValue('Independent main draft');
  await expect(search).toHaveCount(0);
  await expect(miniInput(page)).toBeFocused();
});

test('twenty rapid open-close cycles retain one pop-up and its draft without duplicate sends', async ({
  page,
}) => {
  await demo(page);
  await mainInput(page).fill('Main draft through twenty cycles');
  await open(page);
  await miniInput(page).fill('Pop-up draft through twenty cycles');
  for (let index = 0; index < 20; index++) {
    await panel(page).getByRole('button', { name: 'Close pop-up', exact: true }).click();
    await open(page);
    await expect(page.getByRole('region', { name: /^Mini conversation:/ })).toHaveCount(1);
    await expect(miniInput(page)).toHaveValue('Pop-up draft through twenty cycles');
  }
  await expect(mainInput(page)).toHaveValue('Main draft through twenty cycles');
  await panel(page).getByRole('button', { name: 'Send pop-up message', exact: true }).click();
  await expect(miniInput(page)).toHaveValue('');
  await expect(mainMessage(page, 'Pop-up draft through twenty cycles')).toHaveCount(1);
  await noOverflow(page);
});

type Send = Extract<ChatAction, { type: 'send' }>;
class MiniApiFixture {
  sends: Send[] = [];
  failNext = false;
  holdNext = false;
  private releases: (() => void)[] = [];
  state: ChatState;
  constructor() {
    const user: Person = {
      id: '10000000-0000-4000-8000-000000000001',
      name: 'Mini Local User',
      email: 'mini-local@example.invalid',
      color: '#1967d2',
      status: 'Active',
    };
    const peer: Person = {
      id: '10000000-0000-4000-8000-000000000002',
      name: 'Mini Local Peer',
      email: 'mini-peer@example.invalid',
      color: '#c87749',
    };
    const id = '10000000-0000-4000-8000-000000000003';
    this.state = {
      user,
      conversations: [
        {
          id,
          name: 'Mini local workspace',
          kind: 'space',
          description: 'Isolated local test.',
          members: [user, peer],
          updatedAt: new Date().toISOString(),
          unread: 0,
        },
      ],
      messages: [],
    };
  }
  release() {
    this.releases.splice(0).forEach((resolve) => resolve());
  }
  waitForAcknowledgement() {
    return new Promise<void>((resolve) => this.releases.push(resolve));
  }
}
async function authenticated(page: Page, context: BrowserContext, baseURL: string) {
  const fixture = new MiniApiFixture();
  const origin = new URL(baseURL).origin;
  const provider = 'https://mini-test.invalid';
  const now = Math.floor(Date.now() / 1000);
  const token = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        sub: fixture.state.user.id,
        aud: 'authenticated',
        role: 'authenticated',
        exp: now + 3600,
      }),
    ).toString('base64url'),
    'LOCAL_INVALID_SIGNATURE',
  ].join('.');
  const user = {
    id: fixture.state.user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: fixture.state.user.email,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: fixture.state.user.name },
    created_at: new Date().toISOString(),
    email_confirmed_at: new Date().toISOString(),
  };
  await context.addInitScript(
    (session) => {
      localStorage.removeItem('relay-chat-demo-choice-v1');
      localStorage.setItem('relay-chat-auth-v1', JSON.stringify(session));
    },
    {
      access_token: token,
      refresh_token: 'LOCAL_NOT_A_REAL_REFRESH_TOKEN',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: now + 3600,
      user,
    },
  );
  await page.routeWebSocket('wss://mini-test.invalid/**', (socket) =>
    socket.close({ code: 1000, reason: 'Isolated localhost fixture.' }),
  );
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      if (url.origin === provider && url.pathname === '/auth/v1/user')
        return route.fulfill({ json: user });
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/config')
      return route.fulfill({
        json: {
          supabaseUrl: provider,
          supabaseAnonKey: 'sb_publishable_LOCAL_NOT_A_REAL_KEY',
          databaseConfigured: true,
          signInUrl: 'https://sign-in.example.test/start',
        },
      });
    if (url.pathname !== '/api/chat') return route.continue();
    if (request.headers().authorization !== `Bearer ${token}`)
      return route.fulfill({
        status: 401,
        json: { error: 'The fake local session was not restored.' },
      });
    if (request.method() === 'GET') return route.fulfill({ json: { state: fixture.state } });
    const action = request.postDataJSON() as ChatAction;
    if (action.type !== 'send') return route.fulfill({ json: { state: fixture.state } });
    fixture.sends.push(action);
    if (fixture.failNext) {
      fixture.failNext = false;
      return route.fulfill({ status: 503, json: { error: 'Temporary local mini send outage.' } });
    }
    const id = action.clientMessageId || randomUUID();
    if (!fixture.state.messages.some((message) => message.id === id))
      fixture.state.messages.push({
        id,
        conversationId: action.conversationId,
        author: fixture.state.user,
        text: action.text,
        createdAt: new Date().toISOString(),
        reactions: [],
        attachments: [],
      });
    if (fixture.holdNext) {
      fixture.holdNext = false;
      await fixture.waitForAcknowledgement();
    }
    try {
      return await route.fulfill({ json: { state: fixture.state, id } });
    } catch {
      /* A locally aborted pending request has no remote side effect. */
    }
  });
  await page.goto(baseURL);
  await conversation(page, 'Mini local workspace');
  return fixture;
}

test('failed authenticated pop-up send retains draft and retry reuses the send identity', async ({
  page,
  context,
  baseURL,
}) => {
  const fixture = await authenticated(page, context, baseURL!);
  await open(page, 'Mini local workspace');
  fixture.failNext = true;
  await miniInput(page, 'Mini local workspace').fill('Retry a failed local pop-up send');
  await panel(page, 'Mini local workspace')
    .getByRole('button', { name: 'Send pop-up message', exact: true })
    .click();
  await expect(panel(page, 'Mini local workspace').getByRole('alert')).toContainText(
    'Temporary local mini send outage.',
  );
  await expect(miniInput(page, 'Mini local workspace')).toHaveValue(
    'Retry a failed local pop-up send',
  );
  await panel(page, 'Mini local workspace')
    .getByRole('button', { name: 'Send pop-up message', exact: true })
    .click();
  await expect(miniInput(page, 'Mini local workspace')).toHaveValue('');
  expect(fixture.sends).toHaveLength(2);
  expect(fixture.sends[0].clientMessageId).toBeTruthy();
  expect(fixture.sends[1].clientMessageId).toBe(fixture.sends[0].clientMessageId);
  expect(fixture.state.messages).toHaveLength(1);
});

test('closing and reopening a pending pop-up keeps it locked until acknowledgement', async ({
  page,
  context,
  baseURL,
}) => {
  const fixture = await authenticated(page, context, baseURL!);
  try {
    await open(page, 'Mini local workspace');
    fixture.holdNext = true;
    await miniInput(page, 'Mini local workspace').fill('Pending local pop-up message');
    await panel(page, 'Mini local workspace')
      .getByRole('button', { name: 'Send pop-up message', exact: true })
      .click();
    await expect.poll(() => fixture.sends.length).toBe(1);
    await expect(miniInput(page, 'Mini local workspace')).toBeDisabled();
    await panel(page, 'Mini local workspace')
      .getByRole('button', { name: 'Close pop-up', exact: true })
      .click();
    await open(page, 'Mini local workspace');
    await expect(miniInput(page, 'Mini local workspace')).toBeDisabled();
    await expect(miniInput(page, 'Mini local workspace')).toHaveValue(
      'Pending local pop-up message',
    );
    fixture.release();
    await expect(miniInput(page, 'Mini local workspace')).toBeEnabled();
    await expect(miniInput(page, 'Mini local workspace')).toHaveValue('');
    expect(fixture.state.messages).toHaveLength(1);
  } finally {
    fixture.release();
  }
});

test('pending send acknowledgement clears the unchanged draft transferred on phone resize', async ({
  page,
  context,
  baseURL,
}) => {
  const fixture = await authenticated(page, context, baseURL!);
  try {
    await open(page, 'Mini local workspace');
    fixture.holdNext = true;
    await miniInput(page, 'Mini local workspace').fill('Pending message moves to phone');
    await panel(page, 'Mini local workspace')
      .getByRole('button', { name: 'Send pop-up message', exact: true })
      .click();
    await expect.poll(() => fixture.sends.length).toBe(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel(page, 'Mini local workspace')).toHaveCount(0);
    await expect(mainInput(page)).toHaveValue('Pending message moves to phone');
    fixture.release();
    await expect(mainInput(page)).toHaveValue('');
    await expect(mainMessage(page, 'Pending message moves to phone')).toHaveCount(1);
    expect(fixture.sends).toHaveLength(1);
    await noOverflow(page);
  } finally {
    fixture.release();
  }
});

test('rapid double-submit commits one authenticated message and keeps one send identity', async ({
  page,
  context,
  baseURL,
}) => {
  const fixture = await authenticated(page, context, baseURL!);
  try {
    await open(page, 'Mini local workspace');
    fixture.holdNext = true;
    await miniInput(page, 'Mini local workspace').fill('One message from a rapid double click');
    await panel(page, 'Mini local workspace')
      .getByRole('button', { name: 'Send pop-up message', exact: true })
      .dblclick();
    await expect(miniInput(page, 'Mini local workspace')).toBeDisabled();
    await expect.poll(() => fixture.sends.length).toBe(1);
    expect(fixture.sends[0].clientMessageId).toBeTruthy();
    fixture.release();
    await expect(miniInput(page, 'Mini local workspace')).toHaveValue('');
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.state.messages).toHaveLength(1);
    await expect(mainMessage(page, 'One message from a rapid double click')).toHaveCount(1);
  } finally {
    fixture.release();
  }
});

test('pop-up rejects an over-limit emoji without splitting a surrogate or changing the draft', async ({
  page,
}) => {
  await demo(page);
  await open(page);
  const original = 'a'.repeat(5999);
  await miniInput(page).fill(original);
  await panel(page).getByRole('button', { name: 'Add emoji to pop-up', exact: true }).click();
  await panel(page).getByRole('textbox', { name: 'Search emoji', exact: true }).fill('melting');
  await panel(page).getByRole('button', { name: 'Insert 🫠', exact: true }).click();
  await expect(miniInput(page)).toHaveValue(original);
  await expect(panel(page).getByRole('alert')).toContainText(/6,?000|too long|limit/i);
  const value = await miniInput(page).inputValue();
  expect(value).toBe(original);
  expect(value.charCodeAt(value.length - 1)).toBeLessThan(0xd800);
  await expect(mainInput(page)).toHaveValue('');
});

test('pop-up emoji insertion replaces the actual selected text and restores its caret', async ({
  page,
}) => {
  await demo(page);
  await open(page);
  await miniInput(page).fill('left selected right');
  await miniInput(page).focus();
  await miniInput(page).evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(5, 13),
  );
  await panel(page).getByRole('button', { name: 'Add emoji to pop-up', exact: true }).click();
  await panel(page).getByRole('textbox', { name: 'Search emoji', exact: true }).fill('melting');
  await panel(page).getByRole('button', { name: 'Insert 🫠', exact: true }).click();
  await expect(miniInput(page)).toHaveValue('left 🫠 right');
  await expect(miniInput(page)).toBeFocused();
  expect(
    await miniInput(page).evaluate((element: HTMLTextAreaElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([7, 7]);
  await expect(mainInput(page)).toHaveValue('');
});

test('transferred pending pop-up acknowledgement preserves a main draft edited away and back', async ({
  page,
  context,
  baseURL,
}) => {
  const fixture = await authenticated(page, context, baseURL!);
  const original = 'Pending pop-up draft edited back after transfer';
  try {
    await open(page, 'Mini local workspace');
    fixture.holdNext = true;
    await miniInput(page, 'Mini local workspace').fill(original);
    await panel(page, 'Mini local workspace')
      .getByRole('button', { name: 'Send pop-up message', exact: true })
      .click();
    await expect.poll(() => fixture.sends.length).toBe(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel(page, 'Mini local workspace')).toHaveCount(0);
    await expect(mainInput(page)).toHaveValue(original);
    await mainInput(page).fill('A deliberately changed transferred draft');
    await mainInput(page).fill(original);
    fixture.release();
    await expect(mainMessage(page, original)).toHaveCount(1);
    await expect(mainInput(page)).toHaveValue(original);
    await expect(
      main(page).getByRole('button', { name: 'Send message', exact: true }),
    ).toBeEnabled();
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.state.messages).toHaveLength(1);
  } finally {
    fixture.release();
  }
});

test('false connectivity hint permits a reachable explicit pop-up send', async ({
  page,
  context,
  baseURL,
}) => {
  const fixture = await authenticated(page, context, baseURL!);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  await open(page, 'Mini local workspace');
  await miniInput(page, 'Mini local workspace').fill(
    'Reachable pop-up send despite false connectivity hint',
  );
  await expect(
    panel(page, 'Mini local workspace').getByRole('button', {
      name: 'Send pop-up message',
      exact: true,
    }),
  ).toBeEnabled();
  await panel(page, 'Mini local workspace')
    .getByRole('button', { name: 'Send pop-up message', exact: true })
    .click();
  await expect(miniInput(page, 'Mini local workspace')).toHaveValue('');
  await expect(
    mainMessage(page, 'Reachable pop-up send despite false connectivity hint'),
  ).toHaveCount(1);
  expect(fixture.sends).toHaveLength(1);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
});

test('keyboard pop-up minimize, restore, close and expand keep a meaningful focus destination', async ({
  page,
}) => {
  await demo(page);
  const opener = main(page).getByRole('button', { name: 'Open in a pop-up', exact: true });
  await opener.focus();
  await opener.press('Enter');
  await expect(miniInput(page)).toBeFocused();
  await miniInput(page).fill('Keyboard-only retained pop-up draft');
  const minimize = panel(page).getByRole('button', { name: 'Minimize pop-up', exact: true });
  await minimize.focus();
  await minimize.press('Enter');
  const restore = panel(page).getByRole('button', { name: 'Restore pop-up', exact: true });
  await expect(restore).toBeFocused();
  await restore.press('Enter');
  await expect(miniInput(page)).toBeFocused();
  const close = panel(page).getByRole('button', { name: 'Close pop-up', exact: true });
  await close.focus();
  await close.press('Enter');
  await expect(panel(page)).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.press('Enter');
  await expect(miniInput(page)).toHaveValue('Keyboard-only retained pop-up draft');
  const expand = panel(page).getByRole('button', { name: 'Expand conversation', exact: true });
  await expand.focus();
  await expand.press('Enter');
  await expect(panel(page)).toHaveCount(0);
  await expect(mainInput(page)).toBeFocused();
  await expect(mainInput(page)).toHaveValue('Keyboard-only retained pop-up draft');
});

test('keyboard close uses the persistent Home control when its original opener was removed', async ({
  page,
}) => {
  await demo(page);
  const opener = main(page).getByRole('button', { name: 'Open in a pop-up', exact: true });
  await opener.focus();
  await opener.press('Enter');
  await expect(miniInput(page)).toBeFocused();
  await miniInput(page).fill('Draft survives navigation before close');
  await page.getByRole('navigation').getByRole('button', { name: 'Home', exact: true }).click();
  await expect(opener).toHaveCount(0);
  const close = panel(page).getByRole('button', { name: 'Close pop-up', exact: true });
  await close.focus();
  await close.press('Enter');
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More Home actions', exact: true })).toBeFocused();
});
