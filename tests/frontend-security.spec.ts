import { expect, test, type BrowserContext, type Page } from './coverage-test';
import type { ChatState } from '../src/lib/types';
import { localBaseUrl } from './browser-config';
import {
  LOGIN_NONCE_QUERY,
  LOGIN_REQUEST_KEY,
  LOGIN_REQUEST_TTL_MS,
} from '../src/lib/login-callback';
declare global {
  interface Window {
    securityReleases: Array<() => void>;
    securityPending: number;
    securitySentinel?: number;
  }
}
// Fake provider and loopback routes only. Never uses real tokens, accounts or hosted APIs.
const base = localBaseUrl(),
  origin = new URL(base).origin,
  provider = 'https://frontend-security.invalid';
const first = '00000000-0000-4000-8000-000000000111',
  second = '00000000-0000-4000-8000-000000000222';
const cid = '00000000-0000-4000-8000-000000000333',
  otherCid = '00000000-0000-4000-8000-000000000444';
const nonce = '00000000-0000-4000-8000-000000000666';
function session(id = first) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: [
      Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
      Buffer.from(
        JSON.stringify({
          sub: id,
          iat: now,
          exp: now + 3600,
          aud: 'authenticated',
          role: 'authenticated',
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
      app_metadata: { provider: 'google', providers: ['google'] },
      user_metadata: { full_name: id === first ? 'First person' : 'Second person' },
      created_at: new Date().toISOString(),
      email_confirmed_at: new Date().toISOString(),
    },
  };
}
const a = session(),
  b = session(second);
function state(s: ReturnType<typeof session>): ChatState {
  const user = {
    id: s.user.id,
    name: s.user.user_metadata.full_name,
    email: s.user.email,
    color: '#1967d2',
    status: 'Active',
  };
  return {
    user,
    conversations: [
      {
        id: cid,
        name: s.user.id === first ? 'First workspace' : 'Second workspace',
        kind: 'space',
        members: [user],
        unread: 0,
        updatedAt: new Date().toISOString(),
      },
      {
        id: otherCid,
        name: 'Other workspace',
        kind: 'space',
        members: [user],
        unread: 0,
        updatedAt: new Date().toISOString(),
      },
    ],
    messages: [
      {
        id: '00000000-0000-4000-8000-000000000555',
        conversationId: cid,
        author: user,
        text: 'Literal <img src=x onerror="window.securitySentinel=1"> stays text.',
        createdAt: new Date().toISOString(),
        attachments: [],
        reactions: [],
      },
    ],
  };
}
async function fixture(context: BrowserContext) {
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === provider && url.pathname === '/auth/v1/user')
      return route.fulfill({
        json: request.headers().authorization === `Bearer ${b.access_token}` ? b.user : a.user,
      });
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (url.pathname === '/api/config')
      return route.fulfill({
        json: {
          supabaseUrl: provider,
          supabaseAnonKey: 'sb_publishable_LOCAL_ONLY',
          databaseConfigured: true,
        },
      });
    if (url.pathname === '/api/chat')
      return route.fulfill({
        json: {
          state: state(request.headers().authorization === `Bearer ${b.access_token}` ? b : a),
        },
      });
    return route.continue();
  });
}
const fragment = (s = a) =>
  new URLSearchParams({
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_in: '3600',
    token_type: 'bearer',
  }).toString();
async function seeded(context: BrowserContext, s = a) {
  await context.addInitScript((value) => {
    if (!localStorage.getItem('relay-chat-auth-v1'))
      localStorage.setItem('relay-chat-auth-v1', JSON.stringify(value));
  }, s);
}
async function heading(page: Page, name = 'First workspace') {
  const conversation = page.getByRole('main').getByRole('heading', { name, exact: true });
  // Authenticated startup opens Home. Enter the seeded workspace explicitly;
  // the security assertions below must execute on its actual conversation.
  if (!(await conversation.isVisible()))
    await page.locator('.sidebar-conversation').filter({ hasText: name }).click();
  await expect(conversation).toBeVisible();
}
async function holdFile(page: Page) {
  await page.evaluate(() => {
    const Original = FileReader;
    window.securityReleases = [];
    window.securityPending = 0;
    window.FileReader = class extends Original {
      readAsDataURL(blob: Blob) {
        window.securityPending++;
        window.securityReleases.push(() => super.readAsDataURL(blob));
      }
      abort() {
        if (this.readyState === FileReader.EMPTY) {
          this.dispatchEvent(new ProgressEvent('abort'));
        } else super.abort();
      }
    };
  });
}
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const picked = (name: string) => ({ name, mimeType: 'image/png', buffer: png });

test('unsolicited implicit fragment cannot sign a guest into another account', async ({
  page,
  context,
}) => {
  await fixture(context);
  await page.goto(`${base}/?probe=unsolicited#${fragment()}`);
  await expect(
    page.getByRole('button', { name: 'Continue with Google', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('main').getByRole('heading', { name: 'First workspace', exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        stored: !!localStorage.getItem('relay-chat-auth-v1'),
        hash: location.hash,
      })),
    )
    .toEqual({ stored: false, hash: '' });
  await expect(page.getByRole('alert').filter({ hasText: 'could not be verified' })).toBeVisible();
});
test('rejected token query preserves the already signed-in identity', async ({ page, context }) => {
  await fixture(context);
  await seeded(context, b);
  await page.goto(
    `${base}/?access_token=${encodeURIComponent(a.access_token)}&refresh_token=LOCAL_FAKE&expires_in=3600&token_type=bearer`,
  );
  await heading(page, 'Second workspace');
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('relay-chat-auth-v1')!).user.id),
  ).toBe(second);
  expect(new URL(page.url()).searchParams.has('access_token')).toBe(false);
});
test('same-tab challenged callback signs in, consumes the challenge and preserves invitation', async ({
  page,
  context,
}) => {
  await fixture(context);
  await context.addInitScript(
    ({ key, nonce }) =>
      sessionStorage.setItem(key, JSON.stringify({ nonce, createdAt: Date.now() })),
    { key: LOGIN_REQUEST_KEY, nonce },
  );
  await page.goto(`${base}/?join=${cid}&${LOGIN_NONCE_QUERY}=${nonce}#${fragment()}`);
  await heading(page);
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), LOGIN_REQUEST_KEY))
    .toBeNull();
  expect(new URL(page.url()).searchParams.get('join')).toBe(cid);
  expect(new URL(page.url()).searchParams.has(LOGIN_NONCE_QUERY)).toBe(false);
  expect(new URL(page.url()).hash).toBe('');
});
test('expired callback is refused and normal JSX escapes active-looking message text', async ({
  page,
  context,
}) => {
  await fixture(context);
  await context.addInitScript(
    ({ key, nonce, ttl }) =>
      sessionStorage.setItem(key, JSON.stringify({ nonce, createdAt: Date.now() - ttl - 1000 })),
    { key: LOGIN_REQUEST_KEY, nonce, ttl: LOGIN_REQUEST_TTL_MS },
  );
  await page.goto(`${base}/?${LOGIN_NONCE_QUERY}=${nonce}#${fragment()}`);
  await expect(
    page.getByRole('button', { name: 'Continue with Google', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('relay-chat-auth-v1'))).toBeNull();
  await page.evaluate(
    (value) => localStorage.setItem('relay-chat-auth-v1', JSON.stringify(value)),
    a,
  );
  await page.goto(`${base}/?probe=escaped`);
  await heading(page);
  await expect(page.locator('.message-text')).toHaveText(
    'Literal <img src=x onerror="window.securitySentinel=1"> stays text.',
  );
  expect(await page.locator('.message-text img').count()).toBe(0);
  expect(await page.evaluate(() => window.securitySentinel)).toBeUndefined();
});
test('a held file read is cancelled on conversation change and cannot contaminate either draft', async ({
  page,
  context,
}) => {
  await fixture(context);
  await seeded(context);
  await page.goto(base);
  await heading(page);
  await holdFile(page);
  await page.locator('input[type=file]').setInputFiles(picked('private-original.png'));
  await expect.poll(() => page.evaluate(() => window.securityPending)).toBe(1);
  await page.locator('.sidebar-conversation').filter({ hasText: 'Other workspace' }).click();
  await heading(page, 'Other workspace');
  await page.evaluate(() =>
    window.securityReleases.splice(0).forEach((release: () => void) => release()),
  );
  await expect(
    page.getByRole('button', { name: 'Remove private-original.png', exact: true }),
  ).toHaveCount(0);
  await page.locator('.sidebar-conversation').filter({ hasText: 'First workspace' }).click();
  await heading(page);
  await expect(
    page.getByRole('button', { name: 'Remove private-original.png', exact: true }),
  ).toHaveCount(0);
});
test('read failures are reported and simultaneous selections never exceed three attachments', async ({
  page,
  context,
}) => {
  await fixture(context);
  await seeded(context);
  await page.goto(base);
  await heading(page);
  await page.evaluate(() => {
    const Original = FileReader;
    window.FileReader = class extends Original {
      readAsDataURL(blob: Blob) {
        if ((blob as File).name === 'broken.png')
          setTimeout(() => this.dispatchEvent(new ProgressEvent('error')), 0);
        else super.readAsDataURL(blob);
      }
    };
  });
  await page.locator('input[type=file]').setInputFiles(picked('broken.png'));
  await expect(page.locator('.toast')).toContainText('couldn’t be read');
  await holdFile(page);
  await page.locator('input[type=file]').setInputFiles([picked('one.png'), picked('two.png')]);
  await page.locator('input[type=file]').setInputFiles([picked('three.png'), picked('four.png')]);
  for (let count = 1; count <= 3; count++) {
    await expect.poll(() => page.evaluate(() => window.securityPending)).toBe(count);
    await page.evaluate(() => window.securityReleases.shift()?.());
  }
  await expect(page.locator('.draft-attachments>span')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Remove four.png', exact: true })).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('up to 3 files');
});
test('Continue with Google creates the callback challenge before the broker navigation', async ({
  page,
  context,
}) => {
  await fixture(context);
  let returned = '';
  await context.route('https://oauth.trytofu.ai/start?**', async (route) => {
    returned = new URL(route.request().url()).searchParams.get('return') || '';
    await route.fulfill({ contentType: 'text/html', body: '<p>Local broker fixture</p>' });
  });
  await page.goto(base);
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  await expect.poll(() => returned).not.toBe('');
  const callback = new URL(returned);
  expect(callback.origin).toBe(origin);
  expect(callback.pathname).toBe('/');
  expect(callback.searchParams.get(LOGIN_NONCE_QUERY)).toMatch(/^[0-9a-f-]{36}$/i);
  await page.goto(`${returned}#${fragment()}`);
  await heading(page);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), LOGIN_REQUEST_KEY)).toBeNull();
});
// An aborted navigation leaves this page on screen, as it is while the broker is still answering.
// (Playwright does not read a page that has a held navigation pending.)
async function stoppedBroker(context: BrowserContext) {
  const starts: string[] = [];
  await context.route('https://oauth.trytofu.ai/start?**', (route) => {
    starts.push(route.request().url());
    return route.abort('aborted');
  });
  return starts;
}
test('Continue with Google shows a pending state and starts the broker once', async ({
  page,
  context,
}) => {
  await fixture(context);
  const starts = await stoppedBroker(context);
  await page.goto(base);
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  const pending = page.getByRole('button', { name: 'Opening Google…', exact: true });
  await expect(pending).toBeDisabled();
  await expect(pending).toHaveAttribute('aria-busy', 'true');
  const stored = () => page.evaluate((key) => sessionStorage.getItem(key), LOGIN_REQUEST_KEY);
  const request = await stored();
  expect(request).not.toBeNull();
  // A second press while the broker is answering must not restart the sign-in.
  await pending.click({ force: true });
  expect(await stored()).toBe(request);
  await expect.poll(() => starts.length).toBe(1);
});
test('a page restored from the back/forward cache offers Continue with Google again', async ({
  page,
  context,
}) => {
  await fixture(context);
  await stoppedBroker(context);
  await page.goto(base);
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Opening Google…', exact: true })).toBeDisabled();
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  const again = page.getByRole('button', { name: 'Continue with Google', exact: true });
  await expect(again).toBeEnabled();
  await expect(again).not.toHaveAttribute('aria-busy');
});
test('a stopped broker navigation lets the visitor try Continue with Google again', async ({
  page,
  context,
}) => {
  await fixture(context);
  await stoppedBroker(context);
  await page.clock.install();
  await page.goto(base);
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  const pending = page.getByRole('button', { name: 'Opening Google…', exact: true });
  await expect(pending).toBeDisabled();
  await page.clock.fastForward(14_000);
  await expect(pending).toBeDisabled();
  await page.clock.fastForward(1_100);
  await expect(
    page.getByRole('button', { name: 'Continue with Google', exact: true }),
  ).toBeEnabled();
});
test('an account change during a held read never attaches the earlier account’s selected file', async ({
  page,
  context,
}) => {
  await fixture(context);
  await seeded(context);
  await page.goto(base);
  await heading(page);
  await holdFile(page);
  await page.locator('input[type=file]').setInputFiles(picked('first-account-private.png'));
  await expect.poll(() => page.evaluate(() => window.securityPending)).toBe(1);
  const secondTab = await context.newPage();
  await secondTab.addInitScript(
    ({ key, nonce }) =>
      sessionStorage.setItem(key, JSON.stringify({ nonce, createdAt: Date.now() })),
    { key: LOGIN_REQUEST_KEY, nonce },
  );
  await secondTab.goto(`${base}/?${LOGIN_NONCE_QUERY}=${nonce}#${fragment(b)}`);
  await heading(secondTab, 'Second workspace');
  await heading(page, 'Second workspace');
  await page.evaluate(() =>
    window.securityReleases.splice(0).forEach((release: () => void) => release()),
  );
  await expect(
    page.getByRole('button', { name: 'Remove first-account-private.png', exact: true }),
  ).toHaveCount(0);
  expect(await page.evaluate((id) => localStorage.getItem(`relay-drafts:${id}`), first)).toBeNull();
  await secondTab.close();
});

test('image CSP permits Google avatar hosts and blocks an arbitrary external image even when inserted by trusted code', async ({
  page,
  context,
}) => {
  await fixture(context);
  let allowed = 0,
    blocked = 0;
  await context.route('https://lh3.googleusercontent.com/security-test.png', async (route) => {
    allowed++;
    await route.fulfill({ contentType: 'image/png', body: png });
  });
  await context.route('https://tracker.example/security-test.png', async (route) => {
    blocked++;
    await route.fulfill({ contentType: 'image/png', body: png });
  });
  await page.goto(base);
  await expect(
    page.getByRole('button', { name: 'Continue with Google', exact: true }),
  ).toBeVisible();
  const outcomes = await page.evaluate(async () => {
    const load = (src: string) =>
      new Promise<boolean>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = src;
        document.body.append(img);
      });
    return await Promise.all([
      load('https://lh3.googleusercontent.com/security-test.png'),
      load('https://tracker.example/security-test.png'),
    ]);
  });
  expect(outcomes).toEqual([true, false]);
  expect(allowed).toBe(1);
  expect(blocked).toBe(0);
});
