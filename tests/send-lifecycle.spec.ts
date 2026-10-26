import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page, type TestInfo } from './coverage-test';
import type { ChatAction, ChatState } from '../src/lib/types';
import type { UploadChunk } from '../src/lib/server';
import { evidenceDirectory, localBaseUrl } from './browser-config';

// Exercise the real authenticated hook and UI with invalid local credentials
// and an in-memory server. This is a lifecycle/ownership contract fixture, not
// proof of native app termination, production SQL, or a physical OS keyboard.
const base = localBaseUrl(),
  origin = new URL(base).origin;
const provider = 'https://reliability-test.invalid';
const owner = '00000000-0000-4000-8000-000000000111';
const peer = '00000000-0000-4000-8000-000000000222';
const cid = '00000000-0000-4000-8000-000000000333';
const draftsKey = `relay-drafts:${owner}`,
  idsKey = `relay-chat-send-ids-v1:${owner}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Send = Extract<ChatAction, { type: 'send' }>;

async function fixture(context: BrowserContext) {
  const now = Math.floor(Date.now() / 1000);
  const authUser = {
    id: owner,
    email: 'lifecycle-owner@example.invalid',
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { provider: 'google' },
    user_metadata: { full_name: 'Lifecycle Owner' },
    created_at: new Date().toISOString(),
    email_confirmed_at: new Date().toISOString(),
  };
  const token = [
    Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
    Buffer.from(
      JSON.stringify({
        sub: owner,
        role: 'authenticated',
        aud: 'authenticated',
        exp: now + 3600,
        iat: now,
      }),
    ).toString('base64url'),
    'LOCAL_INVALID_SIGNATURE',
  ].join('.');
  const user = { id: owner, email: authUser.email, name: 'Lifecycle Owner', color: '#1967d2' };
  const other = {
    id: peer,
    email: 'lifecycle-peer@example.invalid',
    name: 'Lifecycle Peer',
    color: '#b06c49',
  };
  const state: ChatState = {
    user,
    conversations: [
      {
        id: cid,
        name: 'Lifecycle Peer',
        kind: 'dm',
        members: [user, other],
        unread: 0,
        updatedAt: new Date().toISOString(),
      },
    ],
    messages: [],
  };
  const sends: Send[] = [],
    committed = new Map<string, string>();
  const uploaded = new Map<string, Buffer>();
  let hold: 'before-commit' | 'after-commit' | 'after-commit-ack' | null = null,
    release: (() => void) | undefined;
  await context.addInitScript(
    ({ session, draftsKey, cid }) => {
      if (!localStorage.getItem('relay-chat-auth-v1'))
        localStorage.setItem('relay-chat-auth-v1', JSON.stringify(session));
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        const control = window as unknown as {
          holdLifecycleDraftClear?: boolean;
          denyLifecycleDraftClear?: boolean;
          truncateLifecycleMediaDrafts?: boolean;
          interceptedLifecycleDraftClear?: number;
        };
        if (
          control.truncateLifecycleMediaDrafts &&
          key === draftsKey &&
          JSON.parse(value)[cid]?.attachments?.length
        )
          throw new DOMException('Local fixture media draft quota.', 'QuotaExceededError');
        if (
          (control.holdLifecycleDraftClear || control.denyLifecycleDraftClear) &&
          key === draftsKey
        ) {
          try {
            if (JSON.parse(value)[cid]?.text === '') {
              // Model termination between ACK handling and the durable draft-clear
              // write. Keep the old persisted draft; no controller ACK is faked.
              control.interceptedLifecycleDraftClear =
                (control.interceptedLifecycleDraftClear || 0) + 1;
              if (control.denyLifecycleDraftClear)
                throw new DOMException('Local fixture clear denied.', 'QuotaExceededError');
              return;
            }
          } catch (error) {
            if (error instanceof DOMException) throw error;
            // Other writes retain ordinary browser behavior.
          }
        }
        return set.call(this, key, value);
      };
    },
    {
      session: {
        access_token: token,
        refresh_token: 'LOCAL_NOT_REAL',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: now + 3600,
        user: authUser,
      },
      draftsKey,
      cid,
    },
  );
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === provider && url.pathname === '/auth/v1/user')
      return route.fulfill({ json: authUser });
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
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (request.headers().authorization !== `Bearer ${token}`)
      return route.fulfill({ status: 401, json: { error: 'Local session missing.' } });
    if (url.pathname === '/api/uploads') {
      const chunk = request.postDataJSON() as UploadChunk,
        bytes = Buffer.from(chunk.data, 'base64');
      if (
        chunk.conversationId !== cid ||
        !uuid.test(chunk.clientMessageId) ||
        chunk.chunkIndex !== 0 ||
        chunk.totalChunks !== 1 ||
        bytes.length !== chunk.size
      )
        return route.fulfill({
          status: 400,
          json: { error: 'This local fixture supports exactly one verified small-file chunk.' },
        });
      const key = `${chunk.clientMessageId}:${chunk.attachmentIndex}`,
        previous = uploaded.get(key);
      if (previous && !previous.equals(bytes))
        return route.fulfill({ status: 409, json: { error: 'Local upload identity conflicts.' } });
      uploaded.set(key, bytes);
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === '/api/attachments') {
      const id = url.searchParams.get('messageId'),
        index = Number(url.searchParams.get('index'));
      const file = state.messages.find((message) => message.id === id)?.attachments[index];
      const bytes = uploaded.get(`${id}:${index}`);
      return file && bytes
        ? route.fulfill({ body: bytes, contentType: file.type })
        : route.fulfill({ status: 404 });
    }
    if (url.pathname !== '/api/chat') return route.abort('blockedbyclient');
    const action = request.method() === 'POST' ? (request.postDataJSON() as ChatAction) : undefined;
    if (action?.type === 'send') {
      const send = structuredClone(action);
      sends.push(send);
      const firstHold = hold;
      hold = null;
      if (firstHold === 'before-commit') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        try {
          await route.abort('connectionreset');
        } catch {
          /* The page has closed. */
        }
        return;
      }
      const id = send.clientMessageId;
      if (!id || !uuid.test(id))
        return route.fulfill({ status: 400, json: { error: 'Missing local send identity.' } });
      const payload = JSON.stringify([
        send.conversationId,
        send.text,
        send.parentId || null,
        send.attachments || [],
      ]);
      if (
        (send.attachments || []).some(
          (file, index) =>
            file.url !== `upload:${id}:${index}` ||
            uploaded.get(`${id}:${index}`)?.length !== file.size,
        )
      )
        return route.fulfill({ status: 409, json: { error: 'Local media reservation missing.' } });
      if (committed.has(id) && committed.get(id) !== payload)
        return route.fulfill({ status: 409, json: { error: 'Local send identity conflicts.' } });
      if (!committed.has(id)) {
        committed.set(id, payload);
        state.messages.push({
          id,
          conversationId: cid,
          author: user,
          text: send.text,
          parentId: send.parentId,
          attachments: (send.attachments || []).map((file, index) => ({
            ...file,
            url: `/api/attachments?messageId=${id}&index=${index}`,
          })),
          reactions: [],
          createdAt: new Date().toISOString(),
        });
        state.conversations[0].lastMessage = send.text;
      }
      if (firstHold === 'after-commit' || firstHold === 'after-commit-ack') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (firstHold === 'after-commit') {
          try {
            await route.abort('connectionreset');
          } catch {
            /* The page has closed. */
          }
          return;
        }
      }
      return route.fulfill({ json: { state: structuredClone(state), id } });
    }
    return route.fulfill({ json: { state: structuredClone(state) } });
  });
  return {
    state,
    sends,
    setHold(value: typeof hold) {
      hold = value;
    },
    release() {
      release?.();
      release = undefined;
    },
  };
}

const input = (page: Page) =>
  page.getByRole('main').getByRole('textbox', { name: 'Message', exact: true });
const sendButton = (page: Page) =>
  page.getByRole('main').getByRole('button', { name: 'Send message', exact: true });
async function opened(context: BrowserContext) {
  const page = await context.newPage();
  await page.routeWebSocket(`${provider.replace('https:', 'wss:')}/**`, (socket) => socket.close());
  await page.goto(base);
  await page.locator('.home-view .conversation-row').filter({ hasText: 'Lifecycle Peer' }).click();
  await expect(input(page)).toBeVisible();
  return page;
}
async function closeHeld(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  await page.close();
  f.release();
}
async function storedDraft(page: Page) {
  return page.evaluate(({ key, cid }) => JSON.parse(localStorage.getItem(key) || '{}')[cid]?.text, {
    key: draftsKey,
    cid,
  });
}
async function captured(page: Page, info: TestInfo, name: string) {
  const dir = evidenceDirectory(info, info.project.name);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
  writeFileSync(
    `${dir}/${name}.json`,
    JSON.stringify(
      await page.evaluate(
        ({ draftsKey, idsKey }) => ({
          drafts: localStorage.getItem(draftsKey),
          retryLedger: localStorage.getItem(idsKey),
          status: document.querySelector('.composer-status')?.textContent || '',
        }),
        { draftsKey, idsKey },
      ),
      null,
      2,
    ),
  );
}

test('saved send closed before ACK reconciles the exact unchanged draft after reopening', async ({
  context,
}, info) => {
  const f = await fixture(context),
    page = await opened(context),
    text = `Saved before close ${randomUUID()}`;
  f.setHold('after-commit');
  await input(page).fill(text);
  await sendButton(page).click();
  await expect.poll(() => f.sends.length).toBe(1);
  await expect.poll(() => f.state.messages.length).toBe(1);
  await expect(page.locator('.composer-status')).toContainText('Waiting for confirmation');
  expect(await storedDraft(page)).toBe(text);
  await closeHeld(page, f);
  const reopened = await opened(context);
  await expect(reopened.getByRole('article').filter({ hasText: text })).toHaveCount(1);
  await captured(reopened, info, 'saved-before-ack-reopened');
  await expect(input(reopened)).toHaveValue('');
  await expect(sendButton(reopened)).toBeDisabled();
  expect(f.sends).toHaveLength(1);
  expect(f.state.messages).toHaveLength(1);
  expect(await storedDraft(reopened)).toBe('');
});

test('unconfirmed closed send restores honest guidance and manual retry retains its ID', async ({
  context,
}, info) => {
  const f = await fixture(context),
    page = await opened(context),
    text = `Not committed before close ${randomUUID()}`;
  f.setHold('before-commit');
  await input(page).fill(text);
  await sendButton(page).click();
  await expect.poll(() => f.sends.length).toBe(1);
  const id = f.sends[0].clientMessageId;
  expect(id).toMatch(uuid);
  await closeHeld(page, f);
  const reopened = await opened(context);
  await expect(input(reopened)).toHaveValue(text);
  expect(f.state.messages).toHaveLength(0);
  expect(f.sends).toHaveLength(1);
  await captured(reopened, info, 'unconfirmed-reopened');
  await expect(reopened.locator('.composer-status')).toContainText(
    /Send not confirmed.*Press Send to retry/s,
  );
  await reopened.setViewportSize({ width: 390, height: 460 });
  await expect
    .poll(async () => {
      const box = await reopened.locator('.composer-status').boundingBox();
      return box ? box.y + box.height : Infinity;
    })
    .toBeLessThanOrEqual(460);
  const status = await reopened.locator('.composer-status').boundingBox();
  expect(status).not.toBeNull();
  expect(status!.y).toBeGreaterThanOrEqual(0);
  expect(status!.y + status!.height).toBeLessThanOrEqual(460);
  expect(
    await sendButton(reopened).evaluate((button) => {
      const r = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }),
  ).toBe(true);
  await captured(reopened, info, 'unconfirmed-short-viewport');
  await sendButton(reopened).click();
  await expect(input(reopened)).toHaveValue('');
  expect(f.sends).toHaveLength(2);
  expect(f.sends[1].clientMessageId).toBe(id);
  expect(f.state.messages).toHaveLength(1);
});

test('ACK before durable draft clear cannot turn a restored saved message into a duplicate', async ({
  context,
}, info) => {
  const f = await fixture(context),
    page = await opened(context),
    text = `Acknowledged before draft clear ${randomUUID()}`;
  await input(page).fill(text);
  await page.evaluate(() => {
    (window as unknown as { holdLifecycleDraftClear: boolean }).holdLifecycleDraftClear = true;
  });
  await sendButton(page).click();
  await expect(input(page)).toHaveValue('');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { interceptedLifecycleDraftClear: number })
            .interceptedLifecycleDraftClear || 0,
      ),
    )
    .toBeGreaterThan(0);
  expect(await storedDraft(page)).toBe(text);
  await page.close();
  const reopened = await opened(context);
  await expect(reopened.getByRole('article').filter({ hasText: text })).toHaveCount(1);
  await captured(reopened, info, 'ack-before-durable-clear-reopened');
  await expect(input(reopened)).toHaveValue('');
  await expect(sendButton(reopened)).toBeDisabled();
  expect(f.sends).toHaveLength(1);
  expect(f.state.messages).toHaveLength(1);
});

test('a newer draft survives reopening after an older saved send', async ({ context }) => {
  const f = await fixture(context),
    page = await opened(context),
    sent = `Older send ${randomUUID()}`,
    changed = `${sent} — newer draft`;
  f.setHold('after-commit');
  await input(page).fill(sent);
  await sendButton(page).click();
  await expect.poll(() => f.sends.length).toBe(1);
  await input(page).fill(changed);
  await expect.poll(() => storedDraft(page)).toBe(changed);
  await closeHeld(page, f);
  const reopened = await opened(context);
  await expect(input(reopened)).toHaveValue(changed);
  await expect(reopened.getByRole('article').filter({ hasText: sent })).toHaveCount(1);
  await sendButton(reopened).click();
  await expect(input(reopened)).toHaveValue('');
  expect(f.sends).toHaveLength(2);
  expect(f.sends[1].clientMessageId).not.toBe(f.sends[0].clientMessageId);
  expect(f.state.messages.map((m) => m.text)).toEqual([sent, changed]);
});

test('storage denial after ACK retains its receipt until the old durable draft is safely cleared', async ({
  context,
}) => {
  const f = await fixture(context),
    page = await opened(context),
    text = `Stored before denied clear ${randomUUID()}`;
  await input(page).fill(text);
  await expect.poll(() => storedDraft(page)).toBe(text);
  await page.evaluate(() => {
    (window as unknown as { denyLifecycleDraftClear: boolean }).denyLifecycleDraftClear = true;
  });
  await sendButton(page).click();
  await expect(input(page)).toHaveValue('');
  const id = f.sends[0].clientMessageId;
  expect(await storedDraft(page)).toBe(text);
  expect(await page.evaluate((key) => localStorage.getItem(key), idsKey)).toContain(id!);
  await page.close();
  const reopened = await opened(context);
  await expect(input(reopened)).toHaveValue('');
  await expect(reopened.getByRole('article').filter({ hasText: text })).toHaveCount(1);
  expect(f.sends).toHaveLength(1);
  expect(f.state.messages).toHaveLength(1);
  await expect.poll(() => storedDraft(reopened)).toBe('');
});

test('ACK consumes the prepared receipt before a delayed new digest can erase an edited-back replacement', async ({
  context,
}) => {
  const f = await fixture(context),
    page = await opened(context),
    text = `Edited back after send ${randomUUID()}`;
  f.setHold('after-commit-ack');
  await input(page).fill(text);
  await sendButton(page).click();
  await expect.poll(() => f.sends.length).toBe(1);
  await input(page).fill(`${text} changed`);
  await expect.poll(() => storedDraft(page)).toBe(`${text} changed`);
  await input(page).fill(text);
  await expect.poll(() => storedDraft(page)).toBe(text);
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args: Parameters<SubtleCrypto['digest']>) => {
      await new Promise<void>(() => {}); // Simulate browser exit before another asynchronous hash completes.
      return digest(...args);
    };
  });
  f.release();
  await expect(page.getByRole('article').filter({ hasText: text })).toHaveCount(1);
  await expect(input(page)).toHaveValue(text);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), idsKey)).toBeNull();
  await expect(sendButton(page)).toBeEnabled();
  await page.close();
  const reopened = await opened(context);
  await expect(input(reopened)).toHaveValue(text);
  await sendButton(reopened).click();
  await expect(input(reopened)).toHaveValue('');
  expect(f.sends).toHaveLength(2);
  expect(f.sends[1].clientMessageId).not.toBe(f.sends[0].clientMessageId);
  expect(f.state.messages.map((message) => message.text)).toEqual([text, text]);
});

test('a normally acknowledged identical message is a new intentional send after reopen', async ({
  context,
}) => {
  const f = await fixture(context),
    page = await opened(context),
    text = `Intentionally repeated ${randomUUID()}`;
  await input(page).fill(text);
  await sendButton(page).click();
  await expect(input(page)).toHaveValue('');
  await expect.poll(() => storedDraft(page)).toBe('');
  await page.close();
  const reopened = await opened(context);
  await expect(input(reopened)).toHaveValue('');
  await input(reopened).fill(text);
  await sendButton(reopened).click();
  await expect(input(reopened)).toHaveValue('');
  expect(f.sends).toHaveLength(2);
  expect(f.sends[1].clientMessageId).not.toBe(f.sends[0].clientMessageId);
  expect(f.state.messages).toHaveLength(2);
});

test('text-only quota restore retains a committed media ID for an explicit identical-file retry', async ({
  context,
}, info) => {
  const f = await fixture(context),
    page = await opened(context),
    text = `Media quota restore ${randomUUID()}`;
  const file = {
    name: 'quota.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ncAAAAASUVORK5CYII=',
      'base64',
    ),
  };
  await input(page).fill(text);
  await page.evaluate(() => {
    (window as unknown as { truncateLifecycleMediaDrafts: boolean }).truncateLifecycleMediaDrafts =
      true;
  });
  await page.locator('input[type=file]').first().setInputFiles(file);
  await expect(page.locator('.draft-attachment-name')).toHaveText(file.name);
  await expect(page.locator('.composer-status')).toContainText(
    'check the conversation before adding files and sending again',
  );
  await page.setViewportSize({ width: 390, height: 460 });
  await expect
    .poll(async () => {
      const box = await page.locator('.composer-status').boundingBox();
      return box ? box.y + box.height : Infinity;
    })
    .toBeLessThanOrEqual(460);
  const guidance = await page.locator('.composer-status').boundingBox();
  expect(guidance).not.toBeNull();
  expect(guidance!.y + guidance!.height).toBeLessThanOrEqual(460);
  expect(
    await sendButton(page).evaluate((button) => {
      const r = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }),
  ).toBe(true);
  await captured(page, info, 'media-quota-guidance-short-viewport');
  expect(
    await page.evaluate(({ key, cid }) => JSON.parse(localStorage.getItem(key)!)[cid].attachments, {
      key: draftsKey,
      cid,
    }),
  ).toEqual([]);
  f.setHold('after-commit');
  await sendButton(page).click();
  await expect.poll(() => f.state.messages.length).toBe(1);
  const id = f.sends[0].clientMessageId;
  expect(id).toMatch(uuid);
  expect(f.sends[0].attachments).toHaveLength(1);
  await closeHeld(page, f);
  const reopened = await opened(context);
  await expect(input(reopened)).toHaveValue(text);
  await expect(reopened.getByRole('article').filter({ hasText: text })).toHaveCount(1);
  // Different partial payload cannot be automatically confirmed or cleared.
  // Keeping the original receipt allows an exact reconstruction to retry it.
  expect(await reopened.evaluate((key) => localStorage.getItem(key), idsKey)).toContain(id!);
  await reopened.locator('input[type=file]').first().setInputFiles(file);
  await expect(reopened.locator('.draft-attachment-name')).toHaveText(file.name);
  await sendButton(reopened).click();
  await expect(input(reopened)).toHaveValue('');
  expect(f.sends).toHaveLength(2);
  expect(f.sends[1].clientMessageId).toBe(id);
  expect(f.state.messages).toHaveLength(1);
  await expect(reopened.getByRole('article').filter({ hasText: text })).toHaveCount(1);
  await expect
    .poll(() =>
      reopened
        .getByRole('article')
        .filter({ hasText: text })
        .getByRole('img', { name: file.name })
        .evaluate(
          (image) =>
            (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
        ),
    )
    .toBe(true);
  await captured(reopened, info, 'media-quota-same-id-retry');
});

test('an empty media-only quota restore keeps the omitted-file marker and original retry ID', async ({
  context,
}, info) => {
  const f = await fixture(context),
    page = await opened(context);
  const file = {
    name: 'media-only-quota.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ncAAAAASUVORK5CYII=',
      'base64',
    ),
  };
  await page.evaluate(() => {
    (window as unknown as { truncateLifecycleMediaDrafts: boolean }).truncateLifecycleMediaDrafts =
      true;
  });
  await page.locator('input[type=file]').first().setInputFiles(file);
  await expect(page.locator('.draft-attachment-name')).toHaveText(file.name);
  const copy = await page.evaluate(({ key, cid }) => JSON.parse(localStorage.getItem(key)!)[cid], {
    key: draftsKey,
    cid,
  });
  expect(copy).toEqual({ text: '', attachments: [], omittedAttachments: true });
  f.setHold('after-commit');
  await sendButton(page).click();
  await expect.poll(() => f.state.messages.length).toBe(1);
  const id = f.sends[0].clientMessageId;
  expect(id).toMatch(uuid);
  expect(f.sends[0].text).toBe('');
  expect(f.sends[0].attachments).toHaveLength(1);
  await closeHeld(page, f);
  const reopened = await opened(context);
  await expect(input(reopened)).toHaveValue('');
  await expect(sendButton(reopened)).toBeDisabled();
  await expect(reopened.locator('.composer-status')).toContainText(
    'Some attachments weren’t saved. Check the conversation',
  );
  expect(await reopened.evaluate((key) => localStorage.getItem(key), idsKey)).toContain(id!);
  expect(
    await reopened.evaluate(({ key, cid }) => JSON.parse(localStorage.getItem(key)!)[cid], {
      key: draftsKey,
      cid,
    }),
  ).toEqual(copy);
  await captured(reopened, info, 'media-only-quota-reopened');
  await reopened.locator('input[type=file]').first().setInputFiles(file);
  await expect(reopened.locator('.draft-attachment-name')).toHaveText(file.name);
  await expect(reopened.locator('.composer-status')).toHaveCount(0);
  await sendButton(reopened).click();
  await expect(sendButton(reopened)).toBeDisabled();
  await expect(reopened.locator('.draft-attachment-name')).toHaveCount(0);
  expect(f.sends).toHaveLength(2);
  expect(f.sends[1].clientMessageId).toBe(id);
  expect(f.state.messages).toHaveLength(1);
  await expect(reopened.getByRole('article')).toHaveCount(1);
  await expect
    .poll(() =>
      reopened
        .getByRole('article')
        .getByRole('img', { name: file.name })
        .evaluate(
          (image) =>
            (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
        ),
    )
    .toBe(true);
});

test.describe('desktop Home preview send ownership', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });
  test('closing a preview during a held ACK preserves a newer draft without duplicating the saved message', async ({
    context,
  }) => {
    const f = await fixture(context),
      page = await context.newPage();
    await page.routeWebSocket(`${provider.replace('https:', 'wss:')}/**`, (socket) =>
      socket.close(),
    );
    await page.goto(base);
    await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: 'Home', exact: true }).click();
    await page
      .locator('.home-view .conversation-row')
      .filter({ hasText: 'Lifecycle Peer' })
      .click();
    await expect(page.getByRole('button', { name: 'Close conversation preview' })).toBeVisible();
    f.setHold('after-commit-ack');
    await input(page).fill('Saved from the preview');
    await sendButton(page).click();
    await expect.poll(() => f.sends.length).toBe(1);
    await page.getByRole('button', { name: 'Close conversation preview' }).click();
    await page
      .locator('.home-view .conversation-row')
      .filter({ hasText: 'Lifecycle Peer' })
      .click();
    await input(page).fill('A newer unsent preview draft');
    f.release();
    await expect(sendButton(page)).not.toHaveAttribute('aria-busy', 'true');
    await expect(input(page)).toHaveValue('A newer unsent preview draft');
    await expect(
      page.getByRole('article').filter({ hasText: 'Saved from the preview' }),
    ).toHaveCount(1);
    await page.getByRole('button', { name: 'Expand conversation', exact: true }).click();
    await expect(input(page)).toHaveValue('A newer unsent preview draft');
    expect(f.state.messages).toHaveLength(1);
    expect(f.sends).toHaveLength(1);
  });
});
