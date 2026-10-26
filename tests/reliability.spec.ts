import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page, type Route } from './coverage-test';
import type { ChatAction, ChatState, Message, Person } from '../src/lib/types';
import type { UploadChunk } from '../src/lib/server';

// These browser regressions exercise the authenticated hook through fake SDK
// session storage and routed localhost APIs. No real account, credential,
// hosted endpoint, database, or realtime provider is used. The mock server's
// dedupe/assembly model tests the client's request contract, not production
// SQL ownership, reservation limits, expiry or atomic chunk consumption.
const baseURL = process.env.APP_URL || 'http://127.0.0.1:3000';
const appOrigin = new URL(baseURL).origin;
if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname)) {
  throw new Error('The reliability fixture suite accepts only a localhost APP_URL.');
}

const fakeSupabaseOrigin = 'https://reliability-test.invalid';
const authStorageKey = 'relay-chat-auth-v1';
const userId = '00000000-0000-4000-8000-000000000111';
const conversationId = '00000000-0000-4000-8000-000000000222';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Send = Extract<ChatAction, { type: 'send' }> & { clientMessageId?: string };

function fixtureState(): ChatState {
  const user: Person = {
    id: userId,
    name: 'Local Test Person',
    email: 'local-test@example.invalid',
    status: 'Active',
    color: '#1967d2',
  };
  const peer: Person = {
    id: '00000000-0000-4000-8000-000000000333',
    name: 'Local Test Peer',
    email: 'local-peer@example.invalid',
    color: '#b06c49',
  };
  const now = new Date().toISOString();
  return {
    user,
    conversations: [
      {
        id: conversationId,
        name: 'Reliability workspace',
        kind: 'space',
        description: 'Local route fixture only.',
        members: [user, peer],
        updatedAt: now,
        unread: 0,
      },
    ],
    messages: [
      {
        id: randomUUID(),
        conversationId,
        author: peer,
        text: 'Initial workspace content stays available.',
        createdAt: now,
        reactions: [],
        attachments: [],
      },
    ],
  };
}

class ChatApiFixture {
  state = fixtureState();
  getMode: 'ok' | 'outage' | 'hold-next' = 'ok';
  getCount = 0;
  failedStatusGets = 0;
  successfulGets = 0;
  heldGets = 0;
  releasedGets = 0;
  failedGetRequests: string[] = [];
  sends: Send[] = [];
  uploads: UploadChunk[] = [];
  transportRequests: { path: string; bytes: number }[] = [];
  unauthenticatedUploadRequests = 0;
  failChunkOnce: number | null = null;
  holdNextUploadResponse = false;
  holdUploadChunk: number | null = null;
  mediaRequests = 0;
  unauthenticatedMediaRequests = 0;
  mediaMode: 'ok' | 'outage' | 'hold-next' = 'ok';
  loseNextSendResponse = false;
  holdNextSendResponse = false;
  actions: ChatAction[] = [];
  loseNextMutationResponse = false;
  failNextMutationBeforeCommit = false;
  failNextReceiptGet = false;
  failedReceiptGets = 0;
  rejectInitialToken = false;
  authRefreshMode: 'ok' | 'outage' | 'revoked' = 'ok';
  authRefreshCount = 0;
  unauthorizedRequests = 0;
  apiAttempts: { method: string; body: string | null; token: 'initial' | 'refreshed' | 'other' }[] =
    [];
  networkReachable = true;
  rejectedTransports: { path: string; clientMessageId?: string }[] = [];
  private held: (() => void)[] = [];
  private heldMedia: (() => void)[] = [];
  private heldSend: (() => void)[] = [];
  private heldUpload: (() => void)[] = [];
  private sendsById = new Map<string, { payload: string; id: string }>();
  private actionReceipts = new Map<string, { payload: string; id?: string }>();
  private staged = new Map<string, { descriptor: string; chunks: Map<number, Buffer> }>();

  addPeerMessage(text: string) {
    const message: Message = {
      id: randomUUID(),
      conversationId,
      author: this.state.conversations[0].members[1],
      text,
      createdAt: new Date().toISOString(),
      reactions: [],
      attachments: [],
    };
    this.state.messages.push(message);
    this.state.conversations[0].lastMessage = text;
    return message.id;
  }

  releaseHeld() {
    this.held.splice(0).forEach((release) => release());
  }

  addPeerFile(name: string, bytes: Buffer, type = 'image/png') {
    const id = this.addPeerMessage('A private attachment is available.');
    this.state.messages.find((message) => message.id === id)!.attachments = [
      { name, type, size: bytes.length, url: `data:${type};base64,${bytes.toString('base64')}` },
    ];
    return id;
  }

  private publicState() {
    const state = structuredClone(this.state);
    for (const message of state.messages)
      message.attachments = message.attachments.map((file, index) => ({
        ...file,
        url: `/api/attachments?messageId=${message.id}&index=${index}`,
      }));
    return state;
  }

  releaseMedia() {
    this.heldMedia.splice(0).forEach((release) => release());
  }
  releaseSend() {
    this.heldSend.splice(0).forEach((release) => release());
  }
  releaseUpload() {
    this.heldUpload.splice(0).forEach((release) => release());
  }

  private transportSize(route: Route) {
    const bytes = route.request().postDataBuffer()?.length || 0;
    this.transportRequests.push({ path: new URL(route.request().url()).pathname, bytes });
    return bytes <= 2 * 1024 * 1024;
  }

  async upload(route: Route) {
    if (!this.transportSize(route))
      return route.fulfill({
        status: 413,
        json: { error: 'Local fixture transport body exceeded 2 MiB.' },
      });
    const chunk = route.request().postDataJSON() as UploadChunk;
    this.uploads.push(structuredClone(chunk));
    if (
      !uuid.test(chunk.clientMessageId) ||
      chunk.conversationId !== conversationId ||
      !Number.isInteger(chunk.attachmentIndex) ||
      chunk.attachmentIndex < 0
    ) {
      return route.fulfill({ status: 400, json: { error: 'Local upload identity is invalid.' } });
    }
    if (this.failChunkOnce === chunk.chunkIndex) {
      this.failChunkOnce = null;
      return route.fulfill({
        status: 503,
        json: { error: 'Temporary local chunk outage. Retry your message.' },
      });
    }
    const bytes = Buffer.from(chunk.data, 'base64');
    const chunkBytes = 1024 * 1024;
    const expectedBytes = Math.min(chunkBytes, chunk.size - chunk.chunkIndex * chunkBytes);
    if (
      bytes.toString('base64') !== chunk.data ||
      bytes.length !== expectedBytes ||
      expectedBytes < 1 ||
      chunk.totalChunks !== Math.ceil(chunk.size / chunkBytes)
    ) {
      return route.fulfill({
        status: 400,
        json: { error: 'Local upload chunk shape is invalid.' },
      });
    }
    const key = `${userId}:${chunk.clientMessageId}:${chunk.attachmentIndex}`;
    const descriptor = JSON.stringify({
      conversationId: chunk.conversationId,
      name: chunk.name,
      type: chunk.type,
      size: chunk.size,
      totalChunks: chunk.totalChunks,
    });
    const staged = this.staged.get(key) || { descriptor, chunks: new Map<number, Buffer>() };
    const previous = staged.chunks.get(chunk.chunkIndex);
    if (staged.descriptor !== descriptor || (previous && !previous.equals(bytes))) {
      return route.fulfill({
        status: 409,
        json: { error: 'Local upload reservation cannot be mutated.' },
      });
    }
    staged.chunks.set(chunk.chunkIndex, bytes);
    this.staged.set(key, staged);
    if (this.holdNextUploadResponse || this.holdUploadChunk === chunk.chunkIndex) {
      this.holdNextUploadResponse = false;
      this.holdUploadChunk = null;
      await new Promise<void>((resolve) => this.heldUpload.push(resolve));
    }
    try {
      return await route.fulfill({ status: 200, json: { ok: true } });
    } catch {
      /* One shared send deadline may cancel an already-staged chunk. */
    }
  }

  async media(route: Route) {
    this.mediaRequests++;
    if (this.mediaMode === 'outage')
      return route.fulfill({ status: 503, json: { error: 'Local media fixture outage.' } });
    if (this.mediaMode === 'hold-next') {
      this.mediaMode = 'ok';
      await new Promise<void>((resolve) => this.heldMedia.push(resolve));
    }
    const query = new URL(route.request().url()).searchParams;
    const file = this.state.messages.find((message) => message.id === query.get('messageId'))
      ?.attachments[Number(query.get('index'))];
    if (!file) return route.fulfill({ status: 404, json: { error: 'File unavailable.' } });
    const bytes = Buffer.from(file.url.slice(file.url.indexOf(',') + 1), 'base64');
    try {
      return await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': file.type,
          'Content-Length': String(bytes.length),
          'Cache-Control': 'private, no-store',
        },
        body: bytes,
      });
    } catch {
      /* A cancelled browser download has already been aborted. */
    }
  }

  async get(route: Route) {
    this.getCount++;
    const queriedActionId = new URL(route.request().url()).searchParams.get('clientActionId');
    if (queriedActionId && this.failNextReceiptGet) {
      this.failNextReceiptGet = false;
      this.failedReceiptGets++;
      return route.fulfill({
        status: 503,
        json: { error: 'Synthetic committed receipt confirmation was unavailable.' },
      });
    }
    if (this.getMode === 'outage') {
      this.failedStatusGets++;
      return route.fulfill({ status: 503, json: { error: 'Temporary local test chat outage.' } });
    }
    if (this.getMode === 'hold-next') {
      this.getMode = 'ok';
      const snapshot = this.publicState();
      this.heldGets++;
      await new Promise<void>((resolve) => this.held.push(resolve));
      try {
        await route.fulfill({ status: 200, json: { state: snapshot } });
        this.releasedGets++;
      } catch {
        /* A timed-out browser request is already aborted. */
      }
      return;
    }
    this.successfulGets++;
    const actionId = new URL(route.request().url()).searchParams.get('clientActionId');
    const receipt = actionId ? this.actionReceipts.get(actionId) : undefined;
    return route.fulfill({
      status: 200,
      json: { state: this.publicState(), ...(receipt ? { actionId, id: receipt.id } : {}) },
    });
  }

  async post(route: Route) {
    if (!this.transportSize(route))
      return route.fulfill({
        status: 413,
        json: { error: 'Local fixture transport body exceeded 2 MiB.' },
      });
    const action = route.request().postDataJSON() as ChatAction & { clientActionId?: string };
    this.actions.push(structuredClone(action));
    if (action.type !== 'send') {
      if (this.failNextMutationBeforeCommit) {
        this.failNextMutationBeforeCommit = false;
        return route.fulfill({
          status: 503,
          json: { error: 'Synthetic action did not commit. Explicit retry is available.' },
        });
      }
      const payload = JSON.stringify({ ...action, clientActionId: undefined });
      const receipt = action.clientActionId
        ? this.actionReceipts.get(action.clientActionId)
        : undefined;
      if (receipt) {
        if (receipt.payload !== payload)
          return route.fulfill({
            status: 409,
            json: { error: 'The fixture action identity conflicts with another intent.' },
          });
        return route.fulfill({
          status: 200,
          json: { state: this.publicState(), actionId: action.clientActionId, id: receipt.id },
        });
      }
      if (action.type === 'star') {
        const message = this.state.messages.find((message) => message.id === action.messageId);
        if (message)
          message.starred = typeof action.starred === 'boolean' ? action.starred : !message.starred;
      }
      if (action.clientActionId) this.actionReceipts.set(action.clientActionId, { payload });
      if (this.loseNextMutationResponse) {
        this.loseNextMutationResponse = false;
        return route.abort('connectionreset');
      }
      return route.fulfill({
        status: 200,
        json: { state: this.publicState(), actionId: action.clientActionId },
      });
    }
    const send = structuredClone(action) as Send;
    this.sends.push(send);
    const attachments: NonNullable<Send['attachments']> = [];
    for (const [index, file] of (send.attachments || []).entries()) {
      const key = `${userId}:${send.clientMessageId}:${index}`;
      const staged = this.staged.get(key);
      const chunks = Math.ceil(file.size / (1024 * 1024));
      const descriptor = JSON.stringify({
        conversationId: send.conversationId,
        name: file.name,
        type: file.type,
        size: file.size,
        totalChunks: chunks,
      });
      if (
        file.url !== `upload:${send.clientMessageId}:${index}` ||
        !staged ||
        staged.chunks.size !== chunks ||
        staged.descriptor !== descriptor
      ) {
        return route.fulfill({
          status: 409,
          json: { error: 'Local upload is incomplete or owned by another send.' },
        });
      }
      const bytes = Buffer.concat(
        Array.from({ length: chunks }, (_, chunk) => staged.chunks.get(chunk)!),
      );
      if (bytes.length !== file.size)
        return route.fulfill({ status: 409, json: { error: 'Local upload size did not match.' } });
      attachments.push({ ...file, url: `data:${file.type};base64,${bytes.toString('base64')}` });
    }
    const logicalPayload = JSON.stringify({
      conversationId: send.conversationId,
      text: send.text.trim(),
      parentId: send.parentId || null,
      attachments: send.attachments || [],
    });
    const previous = send.clientMessageId ? this.sendsById.get(send.clientMessageId) : undefined;
    if (previous && previous.payload !== logicalPayload) {
      return route.fulfill({ status: 409, json: { error: 'Local fixture idempotency conflict.' } });
    }
    const id = previous?.id || send.clientMessageId || randomUUID();
    if (!previous) {
      this.state.messages.push({
        id,
        conversationId: send.conversationId,
        author: this.state.user,
        text: send.text.trim(),
        parentId: send.parentId,
        attachments,
        createdAt: new Date().toISOString(),
        reactions: [],
      });
      if (send.clientMessageId)
        this.sendsById.set(send.clientMessageId, { payload: logicalPayload, id });
      this.state.conversations[0].lastMessage = send.text.trim();
    }
    (send.attachments || []).forEach((_, index) =>
      this.staged.delete(`${userId}:${send.clientMessageId}:${index}`),
    );
    if (this.loseNextSendResponse) {
      this.loseNextSendResponse = false;
      // The fixture has committed above, but the browser receives no response.
      return route.abort('connectionreset');
    }
    if (this.holdNextSendResponse) {
      this.holdNextSendResponse = false;
      await new Promise<void>((resolve) => this.heldSend.push(resolve));
    }
    try {
      return await route.fulfill({ status: 200, json: { state: this.publicState(), id } });
    } catch {
      /* A deadline may have aborted this already-committed request. */
    }
  }
}

async function authenticatedFixture(
  page: Page,
  context: BrowserContext,
  configure?: (fixture: ChatApiFixture) => void,
) {
  const fixture = new ChatApiFixture();
  configure?.(fixture);
  const now = Math.floor(Date.now() / 1000);
  const fakeToken = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
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
  const refreshedToken = fakeToken.replace(
    'LOCAL_TEST_INVALID_SIGNATURE',
    'LOCAL_TEST_REFRESHED_INVALID_SIGNATURE',
  );
  const fakeUser = {
    id: userId,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'local-test@example.invalid',
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: 'Local Test Person' },
    created_at: new Date().toISOString(),
    email_confirmed_at: new Date().toISOString(),
  };
  await context.addInitScript(
    ({ key, session }) => {
      localStorage.removeItem('relay-chat-demo-choice-v1');
      localStorage.setItem(key, JSON.stringify(session));
    },
    {
      key: authStorageKey,
      session: {
        access_token: fakeToken,
        refresh_token: 'LOCAL_TEST_NOT_A_REAL_REFRESH_TOKEN',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: now + 3600,
        user: fakeUser,
      },
    },
  );
  // Close the fake realtime socket before any connection is made.
  await page.routeWebSocket(`${fakeSupabaseOrigin.replace('https:', 'wss:')}/**`, (socket) =>
    socket.close({ code: 1000, reason: 'Local fixture; no provider connection.' }),
  );
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== appOrigin) {
      if (url.origin === fakeSupabaseOrigin && url.pathname === '/auth/v1/user') {
        return route.fulfill({ status: 200, json: fakeUser });
      }
      if (
        url.origin === fakeSupabaseOrigin &&
        url.pathname === '/auth/v1/token' &&
        url.searchParams.get('grant_type') === 'refresh_token'
      ) {
        fixture.authRefreshCount++;
        if (fixture.authRefreshMode === 'outage')
          return route.fulfill({
            status: 503,
            json: {
              error: 'temporarily_unavailable',
              error_description: 'Synthetic refresh provider outage.',
            },
          });
        if (fixture.authRefreshMode === 'revoked')
          return route.fulfill({
            status: 400,
            json: {
              error: 'invalid_grant',
              code: 'refresh_token_not_found',
              error_description: 'Invalid Refresh Token: Refresh Token Not Found',
            },
          });
        return route.fulfill({
          status: 200,
          json: {
            access_token: refreshedToken,
            refresh_token: 'LOCAL_REFRESHED_NOT_A_REAL_TOKEN',
            token_type: 'bearer',
            expires_in: 3600,
            expires_at: now + 3600,
            user: fakeUser,
          },
        });
      }
      // No network request to a real hosted service is allowed by this suite.
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/config') {
      return route.fulfill({
        status: 200,
        json: {
          supabaseUrl: fakeSupabaseOrigin,
          supabaseAnonKey: 'sb_publishable_LOCAL_TEST_ONLY_NOT_A_REAL_KEY',
          databaseConfigured: true,
          signInUrl: 'https://sign-in.example.test/start',
        },
      });
    }
    if (url.pathname === '/api/chat') {
      const authorization = request.headers().authorization;
      const token =
        authorization === `Bearer ${fakeToken}`
          ? 'initial'
          : authorization === `Bearer ${refreshedToken}`
            ? 'refreshed'
            : 'other';
      fixture.apiAttempts.push({ method: request.method(), body: request.postData(), token });
      if (!fixture.networkReachable) {
        const body = request.method() === 'POST' ? request.postDataJSON() : undefined;
        fixture.rejectedTransports.push({
          path: url.pathname,
          clientMessageId: body?.clientMessageId,
        });
        return route.abort('internetdisconnected');
      }
      if (token === 'other' || (fixture.rejectInitialToken && token === 'initial')) {
        fixture.unauthorizedRequests++;
        return route.fulfill({
          status: 401,
          json: { error: 'The local fixture session was not restored.' },
        });
      }
      return request.method() === 'GET' ? fixture.get(route) : fixture.post(route);
    }
    if (url.pathname === '/api/attachments') {
      if (
        ![fakeToken, refreshedToken].some(
          (token) => request.headers().authorization === `Bearer ${token}`,
        )
      ) {
        fixture.unauthenticatedMediaRequests++;
        return route.fulfill({
          status: 401,
          json: { error: 'This file requires the local fixture session.' },
        });
      }
      return fixture.media(route);
    }
    if (url.pathname === '/api/uploads') {
      if (!fixture.networkReachable) {
        fixture.rejectedTransports.push({
          path: url.pathname,
          clientMessageId: request.postDataJSON()?.clientMessageId,
        });
        return route.abort('internetdisconnected');
      }
      if (
        ![fakeToken, refreshedToken].some(
          (token) => request.headers().authorization === `Bearer ${token}`,
        )
      ) {
        fixture.unauthenticatedUploadRequests++;
        return route.fulfill({
          status: 401,
          json: { error: 'Local chunk upload requires the fixture session.' },
        });
      }
      return fixture.upload(route);
    }
    return route.continue();
  });
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).pathname === '/api/chat' && request.method() === 'GET')
      fixture.failedGetRequests.push(request.failure()?.errorText || 'failed');
  });
  await page.goto(baseURL);
  await openWorkspace(page);
  await expect(
    page
      .getByRole('main')
      .getByRole('article')
      .filter({ hasText: 'Initial workspace content stays available.' }),
  ).toBeVisible();
  await expect(page.getByText('DEMO WORKSPACE', { exact: true })).toHaveCount(0);
  return fixture;
}

async function triggerSync(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
}

async function openWorkspace(page: Page) {
  await page
    .getByRole('complementary', { name: 'Chat navigation' })
    .getByRole('button', { name: 'Reliability workspace', exact: true })
    .click();
  await expect(
    page.getByRole('main').getByRole('heading', { name: 'Reliability workspace', exact: true }),
  ).toBeVisible();
}

async function expectAccountRetained(page: Page) {
  await expect(
    page.getByRole('main').getByRole('heading', { name: 'Reliability workspace', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Your profile', exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole('main').getByRole('textbox', { name: 'Message', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) || '{}').user?.id,
      authStorageKey,
    ),
  ).toBe(userId);
}

async function send(page: Page, text: string) {
  const main = page.getByRole('main');
  await main.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await main.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(main.getByRole('article').filter({ hasText: text })).toBeVisible();
}

test('temporary GET503 keeps the session and workspace, then refresh recovers', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  fixture.getMode = 'outage';
  await triggerSync(page);
  await expect.poll(() => fixture.failedStatusGets).toBeGreaterThan(0);
  await expect(page.getByText('Temporary local test chat outage.', { exact: true })).toBeVisible();
  await expectAccountRetained(page);
  await expect(
    page.getByRole('article').filter({ hasText: 'Initial workspace content stays available.' }),
  ).toBeVisible();
  fixture.getMode = 'ok';
  fixture.addPeerMessage('A refresh after the temporary outage succeeds.');
  await triggerSync(page);
  await expect(
    page.getByRole('article').filter({ hasText: 'A refresh after the temporary outage succeeds.' }),
  ).toBeVisible();
  await expectAccountRetained(page);
});

test('native GET and send transport failures show connection guidance and retry the retained draft with its original ID', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  const main = page.getByRole('main');
  const composer = main.getByRole('textbox', { name: 'Message', exact: true });
  const guidance = 'Connection interrupted. Check your connection and try again.';
  const nativeError = /TypeError|Failed to fetch|Load failed|NetworkError|fetch failed/i;
  const text = 'A native transport failure retains this exact message intent.';
  fixture.networkReachable = false;
  try {
    // This aborts the real browser fetch, rather than returning a fixture HTTP
    // error. navigator.onLine remains true, as it can on a disconnected LAN.
    await triggerSync(page);
    await expect
      .poll(() => fixture.rejectedTransports.filter((request) => !request.clientMessageId).length)
      .toBeGreaterThan(0);
    await expect(page.getByText(guidance, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(nativeError)).toHaveCount(0);
    await expectAccountRetained(page);
    await expect(
      main.getByRole('article').filter({ hasText: 'Initial workspace content stays available.' }),
    ).toBeVisible();

    await composer.fill(text);
    await main.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(() => fixture.rejectedTransports.filter((request) => request.clientMessageId).length)
      .toBe(1);
    const failedId = fixture.rejectedTransports.find(
      (request) => request.clientMessageId,
    )!.clientMessageId!;
    expect(failedId).toMatch(uuid);
    await expect(page.getByText(guidance, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(nativeError)).toHaveCount(0);
    await expect(composer).toHaveValue(text);
    await expect(main.getByRole('article').filter({ hasText: text })).toHaveCount(0);
    expect(fixture.sends).toHaveLength(0);
    expect(fixture.state.messages.filter((message) => message.text === text)).toHaveLength(0);
    await expectAccountRetained(page);

    fixture.networkReachable = true;
    const previousSuccessfulGets = fixture.successfulGets;
    await triggerSync(page);
    await expect.poll(() => fixture.successfulGets).toBeGreaterThan(previousSuccessfulGets);
    await expect(composer).toHaveValue(text);
    await main.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(main.getByRole('article').filter({ hasText: text })).toHaveCount(1);
    await expect(composer).toHaveValue('');
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.sends[0].clientMessageId).toBe(failedId);
    expect(fixture.state.messages.filter((message) => message.text === text)).toHaveLength(1);
    await expectAccountRetained(page);
  } finally {
    fixture.networkReachable = true;
  }
});

test('a delayed stale GET cannot overwrite an acknowledged send', async ({ page, context }) => {
  const fixture = await authenticatedFixture(page, context);
  try {
    fixture.getMode = 'hold-next';
    await triggerSync(page);
    await expect.poll(() => fixture.heldGets).toBe(1);
    await expectAccountRetained(page);
    const text = 'An acknowledged send survives a stale delayed refresh.';
    await send(page, text);
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/chat' &&
        response.request().method() === 'GET' &&
        response.status() === 200,
    );
    fixture.releaseHeld();
    await (await responsePromise).finished();
    // Allow the stale JSON response and React commit to finish before asserting.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.getByRole('main').getByRole('article').filter({ hasText: text })).toHaveCount(
      1,
    );
    await expectAccountRetained(page);
  } finally {
    fixture.releaseHeld();
  }
});

test('a hung GET reaches its deadline and a later poll recovers', async ({ page, context }) => {
  // Controlled browser time exercises the actual AbortController/deadline path
  // without spending eight seconds waiting. It is not a network latency test.
  await page.clock.install();
  const fixture = await authenticatedFixture(page, context);
  try {
    const failedBefore = fixture.failedGetRequests.length;
    const successfulBefore = fixture.successfulGets;
    fixture.getMode = 'hold-next';
    await triggerSync(page);
    await expect.poll(() => fixture.heldGets).toBe(1);
    await page.clock.fastForward(8_100);
    await expect.poll(() => fixture.failedGetRequests.length).toBeGreaterThan(failedBefore);
    await expectAccountRetained(page);
    fixture.addPeerMessage('The workspace refreshes after a hung request times out.');
    await page.clock.fastForward(3_100);
    await expect.poll(() => fixture.successfulGets).toBeGreaterThan(successfulBefore);
    await expect(
      page
        .getByRole('article')
        .filter({ hasText: 'The workspace refreshes after a hung request times out.' }),
    ).toBeVisible();
    await send(page, 'Sending still works after a hung refresh.');
    await expectAccountRetained(page);
  } finally {
    fixture.releaseHeld();
  }
});

test('lost POST response retains the draft and retries the same message ID once', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  const text = 'Retry this committed message after its response is lost.';
  fixture.loseNextSendResponse = true;
  const main = page.getByRole('main');
  await main.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await main.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => fixture.sends.length).toBe(1);
  await expect(main.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(main.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(text);
  expect(fixture.sends[0].clientMessageId).toMatch(uuid);
  expect(fixture.state.messages.filter((message) => message.text === text)).toHaveLength(1);
  await main.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => fixture.sends.length).toBe(2);
  await expect(main.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  expect(fixture.sends[1].clientMessageId).toBe(fixture.sends[0].clientMessageId);
  expect(fixture.state.messages.filter((message) => message.text === text)).toHaveLength(1);
  await expect(main.getByRole('article').filter({ hasText: text })).toHaveCount(1);
  await expectAccountRetained(page);
});

test('lost committed POST response reconciles the unchanged restored draft from its exact own UUID without replay', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  const text = 'Confirm the saved draft after reloading a lost response.';
  fixture.loseNextSendResponse = true;
  // Keep the first visit uncertain until the reload's authoritative GET.
  fixture.getMode = 'outage';
  const main = page.getByRole('main');
  const storedDraft = () =>
    page.evaluate(
      ({ userId, conversationId }) =>
        JSON.parse(localStorage.getItem(`relay-drafts:${userId}`) || '{}')[conversationId]?.text,
      { userId, conversationId },
    );
  await main.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await expect.poll(storedDraft).toBe(text);
  await main.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => fixture.sends.length).toBe(1);
  await expect(main.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(main.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(text);
  const originalId = fixture.sends[0].clientMessageId;
  expect(originalId).toMatch(uuid);
  expect(fixture.state.messages.filter((message) => message.text === text)).toHaveLength(1);

  // Hold startup confirmation: the saved draft must not be discarded simply
  // because a send was attempted. Release the authenticated own-message state
  // only after checking durable draft retention and zero replay POSTs.
  fixture.getMode = 'hold-next';
  try {
    await page.reload();
    await expect.poll(() => fixture.heldGets).toBe(1);
    expect(await storedDraft()).toBe(text);
    expect(fixture.sends).toHaveLength(1);
    await expect(main.locator(`#message-${originalId}`)).toHaveCount(0);
    fixture.releaseHeld();
    await openWorkspace(page);
    await expectAccountRetained(page);
    await expect(main.locator(`#message-${originalId}`)).toHaveCount(1);
    await expect(main.locator(`#message-${originalId}`)).toContainText(text);
    await expect(main.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
    await expect(main.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await expect.poll(storedDraft).toBe('');
    expect(fixture.sends).toHaveLength(1);
    const saved = fixture.state.messages.filter((message) => message.id === originalId);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ author: { id: userId }, conversationId, text });
    expect(fixture.state.messages.filter((message) => message.text === text)).toHaveLength(1);
  } finally {
    fixture.releaseHeld();
    fixture.getMode = 'ok';
  }
});

test('intentional repeated successful identical messages receive new IDs', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  const text = 'An intentionally repeated message.';
  await send(page, text);
  await expect(
    page.getByRole('main').getByRole('textbox', { name: 'Message', exact: true }),
  ).toHaveValue('');
  await page.getByRole('main').getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('main').getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => fixture.sends.length).toBe(2);
  await expect(page.getByRole('main').getByRole('article').filter({ hasText: text })).toHaveCount(
    2,
  );
  expect(fixture.sends[0].clientMessageId).toMatch(uuid);
  expect(fixture.sends[1].clientMessageId).toMatch(uuid);
  expect(fixture.sends[1].clientMessageId).not.toBe(fixture.sends[0].clientMessageId);
  expect(
    new Set(
      fixture.state.messages
        .filter((message) => message.text === text)
        .map((message) => message.id),
    ).size,
  ).toBe(2);
});

test('visible private media uses bearer fetch once per session and survives subsequent metadata polls', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  const name = 'local-private-picture.png';
  fixture.addPeerFile(name, readFileSync('public/icons/icon-192.png'));
  await triggerSync(page);
  const image = page.getByAltText(name, { exact: true });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBe(192);
  const source = await image.getAttribute('src');
  expect(source).toMatch(/^blob:/);
  expect(fixture.mediaRequests).toBe(1);
  expect(fixture.unauthenticatedMediaRequests).toBe(0);
  const getsBefore = fixture.successfulGets;
  await triggerSync(page);
  await expect.poll(() => fixture.successfulGets).toBeGreaterThan(getsBefore);
  await expect(image).toHaveAttribute('src', source!);
  expect(fixture.mediaRequests).toBe(1);
  await page.reload();
  await openWorkspace(page);
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBe(192);
  expect(
    fixture.mediaRequests,
    'relaunch downloads through auth again; private binaries are never persisted',
  ).toBe(2);
  expect(fixture.unauthenticatedMediaRequests).toBe(0);
});

test('failed private media retries explicitly while text and ordinary polls keep working', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  const name = 'retry-private-picture.png';
  fixture.mediaMode = 'outage';
  fixture.addPeerFile(name, readFileSync('public/icons/icon-192.png'));
  await triggerSync(page);
  await expect(page.getByRole('button', { name: `Retry ${name}`, exact: true })).toBeVisible();
  expect(fixture.mediaRequests).toBe(1);
  const getsBefore = fixture.successfulGets;
  fixture.addPeerMessage('Text keeps refreshing while a file is unavailable.');
  await triggerSync(page);
  await expect.poll(() => fixture.successfulGets).toBeGreaterThan(getsBefore);
  await expect(
    page
      .getByRole('article')
      .filter({ hasText: 'Text keeps refreshing while a file is unavailable.' }),
  ).toBeVisible();
  expect(fixture.mediaRequests, 'polling does not loop failed downloads').toBe(1);
  fixture.mediaMode = 'ok';
  await page.getByRole('button', { name: `Retry ${name}`, exact: true }).click();
  await expect(page.getByAltText(name, { exact: true })).toBeVisible();
  expect(fixture.mediaRequests).toBe(2);
  expect(fixture.unauthenticatedMediaRequests).toBe(0);
});

test('a pending media download does not block text updates and is discarded on sign-out', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  const name = 'pending-private-picture.png';
  fixture.mediaMode = 'hold-next';
  fixture.addPeerFile(name, readFileSync('public/icons/icon-192.png'));
  try {
    await triggerSync(page);
    await expect.poll(() => fixture.mediaRequests).toBe(1);
    await expect(page.getByAltText(name, { exact: true })).toHaveCount(0);
    fixture.addPeerMessage('A new text message arrives before the file download finishes.');
    await triggerSync(page);
    await expect(
      page
        .getByRole('article')
        .filter({ hasText: 'A new text message arrives before the file download finishes.' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Your profile', exact: true }).first().click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Continue with Google', exact: true }),
    ).toBeVisible();
    fixture.releaseMedia();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.getByAltText(name, { exact: true })).toHaveCount(0);
    await expect(page.locator('.messages-scroll').getByRole('article')).toHaveCount(0);
    await expect(page.locator('.app-shell')).toHaveCount(0);
    expect(fixture.unauthenticatedMediaRequests).toBe(0);
  } finally {
    fixture.releaseMedia();
  }
});

test('a 5 MB image upload renders through protected binary download and reloads correctly', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  const bytes = Buffer.alloc(5 * 1024 * 1024);
  readFileSync('public/icons/icon-192.png').copy(bytes);
  const name = 'full-size-local-image.png';
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: 'image/png', buffer: bytes });
  await expect(page.getByRole('button', { name: `Remove ${name}`, exact: true })).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'Send message', exact: true }).click();
  const image = page.getByAltText(name, { exact: true });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBe(192);
  expect(fixture.sends[0].attachments?.[0].size).toBe(bytes.length);
  expect(fixture.uploads.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2, 3, 4]);
  expect(
    fixture.uploads.every(
      (chunk) =>
        chunk.totalChunks === 5 && chunk.clientMessageId === fixture.sends[0].clientMessageId,
    ),
  ).toBe(true);
  expect(fixture.sends[0].attachments?.[0].url).toBe(
    `upload:${fixture.sends[0].clientMessageId}:0`,
  );
  const committed = fixture.state.messages.find(
    (message) => message.id === fixture.sends[0].clientMessageId,
  )!.attachments[0];
  expect(
    Buffer.from(committed.url.split(',')[1], 'base64').equals(bytes),
    'assembled download retains every binary byte',
  ).toBe(true);
  expect(fixture.transportRequests).toHaveLength(6);
  expect(
    fixture.transportRequests.every((request) => request.bytes <= 2 * 1024 * 1024),
    'every upload and final-send request fits the 2 MiB transport budget',
  ).toBe(true);
  expect(
    fixture.transportRequests.find((request) => request.path === '/api/chat')!.bytes,
    'final send contains metadata only',
  ).toBeLessThan(1024);
  expect(fixture.unauthenticatedUploadRequests).toBe(0);
  expect(await image.getAttribute('src')).toMatch(/^blob:/);
  expect(fixture.mediaRequests).toBe(1);
  await page.reload();
  await openWorkspace(page);
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBe(192);
  expect(fixture.mediaRequests).toBe(2);
  expect(fixture.unauthenticatedMediaRequests).toBe(0);
});

test('offline during a middle upload chunk retains the draft and retries identical bytes with one send ID', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  const bytes = Buffer.alloc(3 * 1024 * 1024);
  readFileSync('public/icons/icon-192.png').copy(bytes);
  const name = 'offline-middle-chunk.png';
  const text = 'Keep this draft through a real browser offline transition.';
  const main = page.getByRole('main');
  const failedUploads: string[] = [];
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).pathname === '/api/uploads')
      failedUploads.push(request.failure()?.errorText || 'failed');
  });
  fixture.holdUploadChunk = 1;
  try {
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name, mimeType: 'image/png', buffer: bytes });
    await main.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
    await main.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => fixture.uploads.map((chunk) => chunk.chunkIndex)).toEqual([0, 1]);
    const originalId = fixture.uploads[0].clientMessageId;
    expect(originalId).toMatch(uuid);
    await context.setOffline(true);
    fixture.networkReachable = false;
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await expect.poll(() => failedUploads.length).toBeGreaterThan(0);
    await expect(main.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(text);
    await expect(page.getByRole('button', { name: `Remove ${name}`, exact: true })).toBeVisible();
    expect(fixture.sends).toHaveLength(0);
    await expect(main.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await main.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(
        () =>
          fixture.rejectedTransports.filter((request) => request.path === '/api/uploads').length,
      )
      .toBe(1);
    await expect(main.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await expect(main.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(text);
    await expect(main.getByRole('article').filter({ hasText: text })).toHaveCount(0);
    expect(
      fixture.rejectedTransports
        .filter((request) => request.clientMessageId)
        .every((request) => request.clientMessageId === originalId),
    ).toBe(true);
    expect(fixture.uploads).toHaveLength(2);
    expect(fixture.sends).toHaveLength(0);
    fixture.releaseUpload();
    fixture.networkReachable = true;
    await context.setOffline(false);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
    await expect(main.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await main.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(main.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
    await expect(page.getByAltText(name, { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page
          .getByAltText(name, { exact: true })
          .evaluate((element) => (element as HTMLImageElement).naturalWidth),
      )
      .toBe(192);
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.sends[0].clientMessageId).toBe(originalId);
    expect(fixture.uploads.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 0, 1, 2]);
    expect(fixture.uploads.every((chunk) => chunk.clientMessageId === originalId)).toBe(true);
    const committed = fixture.state.messages.find((message) => message.id === originalId)!
      .attachments[0];
    expect(Buffer.from(committed.url.split(',')[1], 'base64').equals(bytes)).toBe(true);
    expect(fixture.transportRequests.every((request) => request.bytes <= 2 * 1024 * 1024)).toBe(
      true,
    );
    await expect(main.getByRole('article').filter({ hasText: text })).toHaveCount(1);
    await expectAccountRetained(page);
  } finally {
    fixture.releaseUpload();
    await context.setOffline(false);
  }
});

test('a failed later chunk retains text and file; retry reuses its send ID and identical chunks', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0x6a);
  readFileSync('public/icons/icon-192.png').copy(bytes);
  const name = 'retry-chunk-picture.png';
  const text = 'The saved attachment draft survives a partial upload.';
  const main = page.getByRole('main');
  fixture.failChunkOnce = 1;
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: 'image/png', buffer: bytes });
  await main.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await main.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => fixture.uploads.length).toBe(2);
  await expect(main.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(main.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(text);
  await expect(page.getByRole('button', { name: `Remove ${name}`, exact: true })).toBeVisible();
  await expect(
    main.getByRole('status').filter({ hasText: 'Send not confirmed. Your draft is kept here.' }),
  ).toBeVisible();
  expect(fixture.sends).toHaveLength(0);
  const original = fixture.uploads[0];
  expect(original.clientMessageId).toMatch(uuid);
  await main.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(main.getByRole('article').filter({ hasText: text })).toHaveCount(1);
  await expect(main.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  expect(fixture.uploads.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 0, 1, 2]);
  expect(fixture.uploads[2]).toEqual(original);
  expect(fixture.uploads.every((chunk) => chunk.clientMessageId === original.clientMessageId)).toBe(
    true,
  );
  expect(fixture.sends).toHaveLength(1);
  expect(fixture.sends[0].clientMessageId).toBe(original.clientMessageId);
  expect(fixture.state.messages.filter((message) => message.text === text)).toHaveLength(1);
  const file = fixture.state.messages.find((message) => message.text === text)!.attachments[0];
  expect(Buffer.from(file.url.split(',')[1], 'base64').equals(bytes)).toBe(true);
  expect(fixture.transportRequests.every((request) => request.bytes <= 2 * 1024 * 1024)).toBe(true);
  expect(fixture.unauthenticatedUploadRequests).toBe(0);
  await expectAccountRetained(page);
});

test('lost final attachment ack retries chunks with the same ID and commits only one message', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  const bytes = readFileSync('public/icons/icon-192.png');
  const name = 'lost-ack-picture.png';
  const text = 'A committed attachment has one identity after its response is lost.';
  const main = page.getByRole('main');
  fixture.loseNextSendResponse = true;
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: 'image/png', buffer: bytes });
  await main.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await main.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => fixture.sends.length).toBe(1);
  await expect(main.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: `Remove ${name}`, exact: true })).toBeVisible();
  await main.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => fixture.sends.length).toBe(2);
  await expect(main.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  expect(fixture.uploads).toHaveLength(2);
  expect(fixture.uploads[1]).toEqual(fixture.uploads[0]);
  expect(fixture.sends[1].clientMessageId).toBe(fixture.sends[0].clientMessageId);
  expect(fixture.state.messages.filter((message) => message.text === text)).toHaveLength(1);
  await expect(main.getByRole('article').filter({ hasText: text })).toHaveCount(1);
  await expect
    .poll(() =>
      page
        .getByAltText(name, { exact: true })
        .evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBe(192);
});

test('a hung private media download reaches its 60-second deadline and Retry recovers', async ({
  page,
  context,
}) => {
  await page.clock.install();
  const fixture = await authenticatedFixture(page, context);
  const name = 'deadline-private-picture.png';
  fixture.mediaMode = 'hold-next';
  fixture.addPeerFile(name, readFileSync('public/icons/icon-192.png'));
  try {
    await triggerSync(page);
    await expect.poll(() => fixture.mediaRequests).toBe(1);
    await page.clock.fastForward(60_100);
    await expect(page.getByRole('button', { name: `Retry ${name}`, exact: true })).toBeVisible();
    await expectAccountRetained(page);
    await page.getByRole('button', { name: `Retry ${name}`, exact: true }).click();
    await expect(page.getByAltText(name, { exact: true })).toBeVisible();
    expect(fixture.mediaRequests).toBe(2);
    expect(fixture.unauthenticatedMediaRequests).toBe(0);
  } finally {
    fixture.releaseMedia();
  }
});

test('attachment POST gets a bounded 60-second deadline and retains its draft after timeout', async ({
  page,
  context,
}) => {
  await page.clock.install();
  const fixture = await authenticatedFixture(page, context);
  const name = 'slow-upload-local-picture.png';
  fixture.holdNextSendResponse = true;
  try {
    await page.locator('input[type="file"]').setInputFiles({
      name,
      mimeType: 'image/png',
      buffer: readFileSync('public/icons/icon-192.png'),
    });
    const sendButton = page
      .getByRole('main')
      .getByRole('button', { name: 'Send message', exact: true });
    await sendButton.click();
    await expect.poll(() => fixture.sends.length).toBe(1);
    expect(fixture.uploads).toHaveLength(1);
    expect(fixture.sends[0].attachments?.[0].url).toBe(
      `upload:${fixture.sends[0].clientMessageId}:0`,
    );
    await page.clock.fastForward(20_100);
    await expect(sendButton).toBeDisabled();
    await page.clock.fastForward(40_100);
    await expect(sendButton).toBeEnabled();
    await expect(page.getByRole('button', { name: `Remove ${name}`, exact: true })).toBeVisible();
    await expect(
      page
        .getByRole('main')
        .getByRole('status')
        .filter({ hasText: 'Send not confirmed. Your draft is kept here.' }),
    ).toBeVisible();
    expect(fixture.sends[0].clientMessageId).toMatch(uuid);
    await expectAccountRetained(page);
  } finally {
    fixture.releaseSend();
  }
});

test('one 60-second deadline bounds the whole chunk sequence and Retry recovers', async ({
  page,
  context,
}) => {
  await page.clock.install();
  const fixture = await authenticatedFixture(page, context);
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  readFileSync('public/icons/icon-192.png').copy(bytes);
  const name = 'shared-deadline-picture.png';
  const sendButton = page
    .getByRole('main')
    .getByRole('button', { name: 'Send message', exact: true });
  fixture.holdNextUploadResponse = true;
  try {
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name, mimeType: 'image/png', buffer: bytes });
    await sendButton.click();
    await expect.poll(() => fixture.uploads.length).toBe(1);
    await page.clock.fastForward(40_000);
    await expect(sendButton).toBeDisabled();
    fixture.holdNextUploadResponse = true;
    fixture.releaseUpload();
    await expect.poll(() => fixture.uploads.length).toBe(2);
    await page.clock.fastForward(20_100);
    await expect(sendButton).toBeEnabled();
    await expect(
      page
        .getByRole('main')
        .getByRole('status')
        .filter({ hasText: 'Send not confirmed. Your draft is kept here.' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: `Remove ${name}`, exact: true })).toBeVisible();
    expect(fixture.sends).toHaveLength(0);
    const originalId = fixture.uploads[0].clientMessageId;
    fixture.releaseUpload();
    await sendButton.click();
    await expect.poll(() => fixture.sends.length).toBe(1);
    await expect(page.getByAltText(name, { exact: true })).toBeVisible();
    expect(fixture.uploads.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 0, 1]);
    expect(fixture.uploads.every((chunk) => chunk.clientMessageId === originalId)).toBe(true);
    expect(fixture.sends[0].clientMessageId).toBe(originalId);
    expect(fixture.transportRequests.every((request) => request.bytes <= 2 * 1024 * 1024)).toBe(
      true,
    );
    await expectAccountRetained(page);
  } finally {
    fixture.releaseUpload();
  }
});

async function attachDraftFile(page: Page, name: string) {
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('main')
    .getByRole('button', { name: 'Attach files (up to 5 MB each)', exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from('Synthetic pending-ack draft file.'),
  });
  await expect(
    page.getByRole('main').getByRole('button', { name: `Remove ${name}`, exact: true }),
  ).toBeVisible();
}

for (const switchConversation of [true, false]) {
  test(`main delayed acknowledgement preserves ${switchConversation ? 'another conversation draft and clears only the sent draft' : 'edits and files added to the pending composer'}`, async ({
    page,
    context,
  }) => {
    const fixture = await authenticatedFixture(page, context, (fixture) => {
      fixture.state.conversations.push({
        id: '00000000-0000-4000-8000-000000000444',
        name: 'Other local conversation',
        kind: 'dm',
        members: fixture.state.conversations[0].members,
        updatedAt: new Date().toISOString(),
        unread: 0,
      });
    });
    const main = page.getByRole('main');
    const input = main.getByRole('textbox', { name: 'Message', exact: true });
    const original = 'Original pending main message';
    const edited = switchConversation
      ? 'Draft belonging to the other conversation'
      : 'Updated composer text during pending acknowledgement';
    const file = switchConversation ? 'other-conversation-draft.txt' : 'edited-pending-draft.txt';
    try {
      fixture.holdNextSendResponse = true;
      await input.fill(original);
      await main.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => fixture.sends.length).toBe(1);
      if (switchConversation)
        await page
          .getByRole('complementary')
          .getByRole('button', { name: 'Other local conversation', exact: true })
          .click();
      await input.fill(edited);
      await attachDraftFile(page, file);
      fixture.releaseSend();
      await expect(main.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
      await expect(input).toHaveValue(edited);
      await expect(main.getByRole('button', { name: `Remove ${file}`, exact: true })).toBeVisible();
      expect(fixture.sends).toHaveLength(1);
      expect(fixture.state.messages.filter((message) => message.text === original)).toHaveLength(1);
      if (switchConversation) {
        await page
          .getByRole('complementary')
          .getByRole('button', { name: 'Reliability workspace', exact: true })
          .click();
        await expect(input).toHaveValue('');
        await expect(main.locator('.draft-attachments')).toHaveCount(0);
        await page
          .getByRole('complementary')
          .getByRole('button', { name: 'Other local conversation', exact: true })
          .click();
        await expect(input).toHaveValue(edited);
        await expect(
          main.getByRole('button', { name: `Remove ${file}`, exact: true }),
        ).toBeVisible();
      }
    } finally {
      fixture.releaseSend();
    }
  });
}

for (const switchThread of [true, false]) {
  test(`thread delayed acknowledgement preserves ${switchThread ? 'another thread draft and clears only the sent reply' : 'reply edits made while acknowledgement is pending'}`, async ({
    page,
    context,
  }) => {
    const secondRoot = 'Second local root for pending thread isolation';
    const fixture = await authenticatedFixture(page, context, (fixture) => {
      fixture.addPeerMessage(secondRoot);
    });
    const main = page.getByRole('main');
    const thread = page.locator('.thread-panel');
    const input = thread.getByRole('textbox', { name: 'Reply in thread', exact: true });
    const original = 'Original pending thread reply';
    const edited = switchThread
      ? 'Other thread owns this reply draft'
      : 'Reply edited during its pending acknowledgement';
    const openRoot = async (text: string) => {
      const root = main
        .getByRole('article')
        .filter({ has: page.locator('.message-text').filter({ hasText: text }) });
      await root.hover();
      await root.getByRole('button', { name: 'Reply in thread', exact: true }).click();
      await expect(input).toBeVisible();
    };
    try {
      await openRoot('Initial workspace content stays available.');
      fixture.holdNextSendResponse = true;
      await input.fill(original);
      await thread.getByRole('button', { name: 'Send reply', exact: true }).click();
      await expect.poll(() => fixture.sends.length).toBe(1);
      if (switchThread) await openRoot(secondRoot);
      await input.fill(edited);
      fixture.releaseSend();
      await expect(thread.getByRole('button', { name: 'Send reply', exact: true })).toBeEnabled();
      await expect(input).toHaveValue(edited);
      expect(fixture.sends).toHaveLength(1);
      expect(fixture.state.messages.filter((message) => message.text === original)).toHaveLength(1);
      if (switchThread) {
        await openRoot('Initial workspace content stays available.');
        await expect(input).toHaveValue('');
        await openRoot(secondRoot);
        await expect(input).toHaveValue(edited);
      }
    } finally {
      fixture.releaseSend();
    }
  });
}

test('expanding an empty pop-up during a pending main send preserves unchanged draft identity', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  const main = page.getByRole('main');
  const input = main.getByRole('textbox', { name: 'Message', exact: true });
  try {
    fixture.holdNextSendResponse = true;
    await input.fill('Unchanged pending main draft through expansion');
    await main.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => fixture.sends.length).toBe(1);
    await main.getByRole('button', { name: 'Open in a pop-up', exact: true }).click();
    const mini = page.getByRole('region', {
      name: 'Mini conversation: Reliability workspace',
      exact: true,
    });
    await expect(mini.getByRole('textbox', { name: 'Message in pop-up', exact: true })).toHaveValue(
      '',
    );
    await mini.getByRole('button', { name: 'Expand conversation', exact: true }).click();
    await expect(mini).toHaveCount(0);
    await expect(input).toHaveValue('Unchanged pending main draft through expansion');
    fixture.releaseSend();
    await expect(input).toHaveValue('');
    expect(fixture.sends).toHaveLength(1);
    expect(
      fixture.state.messages.filter(
        (message) => message.text === 'Unchanged pending main draft through expansion',
      ),
    ).toHaveLength(1);
  } finally {
    fixture.releaseSend();
  }
});

test('actual API401 refreshes the synthetic session once and retries identical send body and UUID', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  fixture.rejectInitialToken = true;
  await send(page, 'Local send survives one expired API token');
  await expect(
    page.getByRole('main').getByRole('textbox', { name: 'Message', exact: true }),
  ).toHaveValue('');
  expect(fixture.authRefreshCount).toBe(1);
  const attempts = fixture.apiAttempts.filter((attempt) => attempt.method === 'POST');
  expect(attempts).toHaveLength(2);
  expect(attempts.map((attempt) => attempt.token)).toEqual(['initial', 'refreshed']);
  expect(attempts[1].body).toBe(attempts[0].body);
  expect(JSON.parse(attempts[0].body!).clientMessageId).toMatch(uuid);
  expect(fixture.sends).toHaveLength(1);
  expect(
    fixture.state.messages.filter(
      (message) => message.text === 'Local send survives one expired API token',
    ),
  ).toHaveLength(1);
  await expectAccountRetained(page);
});

test('API401 followed by temporary refresh503 retains identity workspace and retryable draft', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  fixture.rejectInitialToken = true;
  fixture.authRefreshMode = 'outage';
  const main = page.getByRole('main');
  const text = 'Keep the draft during a synthetic auth refresh outage';
  await main.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await main.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => fixture.authRefreshCount).toBeGreaterThan(0);
  await expect(main.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled({
    timeout: 25_000,
  });
  await expect(main.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(text);
  await expectAccountRetained(page);
  expect(fixture.sends).toHaveLength(0);
  fixture.authRefreshMode = 'ok';
  await main.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(main.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  const attempts = fixture.apiAttempts.filter((attempt) => attempt.method === 'POST');
  expect(attempts.length).toBeGreaterThanOrEqual(2);
  expect(new Set(attempts.map((attempt) => JSON.parse(attempt.body!).clientMessageId)).size).toBe(
    1,
  );
  expect(fixture.sends).toHaveLength(1);
});

test('API401 followed by revoked refresh token returns to guest and clears private UI', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  fixture.rejectInitialToken = true;
  fixture.authRefreshMode = 'revoked';
  const main = page.getByRole('main');
  await main
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Never publish this after auth revocation');
  await main.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Continue with Google', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await expect(page.locator('.messages-scroll').getByRole('article')).toHaveCount(0);
  expect(fixture.authRefreshCount).toBe(1);
  expect(fixture.sends).toHaveLength(0);
});

test('false navigator online hint does not prevent an explicit reachable send', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  const main = page.getByRole('main');
  await main
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('A reachable app works despite a false connectivity hint');
  await expect(main.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await main.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(main.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  await expect(
    main
      .getByRole('article')
      .filter({ hasText: 'A reachable app works despite a false connectivity hint' }),
  ).toHaveCount(1);
  expect(fixture.sends).toHaveLength(1);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await expectAccountRetained(page);
});

test('lost committed star-toggle acknowledgement reconciles authoritative state without replaying mutation', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  const article = page
    .getByRole('main')
    .getByRole('article')
    .filter({ hasText: 'Initial workspace content stays available.' });
  fixture.loseNextMutationResponse = true;
  const previousGets = fixture.getCount;
  await article.hover();
  await article.getByRole('button', { name: 'Star message', exact: true }).click();
  await expect.poll(() => fixture.getCount).toBeGreaterThan(previousGets);
  await article.hover();
  await expect(article.getByRole('button', { name: 'Unstar message', exact: true })).toBeVisible();
  expect(fixture.actions.filter((action) => action.type === 'star')).toHaveLength(1);
  expect(fixture.state.messages[0].starred).toBe(true);
  await expectAccountRetained(page);
});

test('foreground refetch recovers missed peer state and retains local text and file drafts', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  const main = page.getByRole('main');
  await main
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Foreground recovery must preserve this text');
  await attachDraftFile(page, 'foreground-retained.txt');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  fixture.addPeerMessage('Authoritative peer state recovered after foregrounding');
  const previousGets = fixture.getCount;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    main
      .getByRole('article')
      .filter({ hasText: 'Authoritative peer state recovered after foregrounding' }),
  ).toHaveCount(0);
  expect(fixture.getCount).toBe(previousGets);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(
    main
      .getByRole('article')
      .filter({ hasText: 'Authoritative peer state recovered after foregrounding' }),
  ).toBeVisible();
  await expect(main.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'Foreground recovery must preserve this text',
  );
  await expect(
    main.getByRole('button', { name: 'Remove foreground-retained.txt', exact: true }),
  ).toBeVisible();
  expect(fixture.getCount).toBeGreaterThan(previousGets);
  await expectAccountRetained(page);
});

test('uncommitted star failure retries the same action identity after reload without duplicate toggle', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  fixture.failNextMutationBeforeCommit = true;
  const article = () =>
    page
      .getByRole('main')
      .getByRole('article')
      .filter({ hasText: 'Initial workspace content stays available.' });
  await article().hover();
  await article().getByRole('button', { name: 'Star message', exact: true }).click();
  await expect
    .poll(() => fixture.actions.filter((action) => action.type === 'star').length)
    .toBe(1);
  await expect(page.locator('.error-banner')).toContainText(
    'Synthetic action did not commit. Explicit retry is available.',
  );
  expect(fixture.state.messages[0].starred).not.toBe(true);
  const first = fixture.actions.find((action) => action.type === 'star') as ChatAction & {
    clientActionId?: string;
  };
  expect(first.clientActionId).toMatch(uuid);
  await page.reload();
  await openWorkspace(page);
  await expectAccountRetained(page);
  await article().hover();
  await article().getByRole('button', { name: 'Star message', exact: true }).click();
  await expect(
    article().getByRole('button', { name: 'Unstar message', exact: true }),
  ).toBeVisible();
  const attempts = fixture.actions.filter((action) => action.type === 'star') as (ChatAction & {
    clientActionId?: string;
  })[];
  expect(attempts).toHaveLength(2);
  expect(attempts[1].clientActionId).toBe(first.clientActionId);
  expect(fixture.state.messages[0].starred).toBe(true);
  await article().getByRole('button', { name: 'Unstar message', exact: true }).click();
  await expect(article().getByRole('button', { name: 'Star message', exact: true })).toBeVisible();
  const completed = fixture.actions.filter((action) => action.type === 'star') as (ChatAction & {
    clientActionId?: string;
  })[];
  expect(completed).toHaveLength(3);
  expect(completed[2].clientActionId).not.toBe(first.clientActionId);
  expect(completed[2].clientActionId).toMatch(uuid);
  expect(fixture.state.messages[0].starred).toBe(false);
});

test('committed star with lost ACK and failed receipt confirmation allows a distinct Unstar intent after reload', async ({
  page,
  context,
}) => {
  const fixture = await authenticatedFixture(page, context);
  fixture.loseNextMutationResponse = true;
  fixture.failNextReceiptGet = true;
  const article = () =>
    page
      .getByRole('main')
      .getByRole('article')
      .filter({ hasText: 'Initial workspace content stays available.' });
  await article().hover();
  await article().getByRole('button', { name: 'Star message', exact: true }).click();
  await expect.poll(() => fixture.failedReceiptGets).toBe(1);
  await expect(page.locator('.error-banner')).toBeVisible();
  expect(fixture.state.messages[0].starred).toBe(true);
  const original = fixture.actions.find((action) => action.type === 'star') as Extract<
    ChatAction,
    { type: 'star' }
  >;
  expect(original.clientActionId).toMatch(uuid);
  expect(original.starred).toBe(true);
  await page.reload();
  await openWorkspace(page);
  await expectAccountRetained(page);
  await article().hover();
  await expect(
    article().getByRole('button', { name: 'Unstar message', exact: true }),
  ).toBeVisible();
  await article().getByRole('button', { name: 'Unstar message', exact: true }).click();
  await expect(article().getByRole('button', { name: 'Star message', exact: true })).toBeVisible();
  const actions = fixture.actions.filter((action) => action.type === 'star') as Extract<
    ChatAction,
    { type: 'star' }
  >[];
  expect(actions).toHaveLength(2);
  expect(actions[1].starred).toBe(false);
  expect(actions[1].clientActionId).toMatch(uuid);
  expect(actions[1].clientActionId).not.toBe(original.clientActionId);
  expect(fixture.state.messages[0].starred).toBe(false);
});
