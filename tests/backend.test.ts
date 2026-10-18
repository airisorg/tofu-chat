import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createDemoState, applyDemoAction } from '../src/lib/demo';
import {
  publicConfig,
  readActionBody,
  authenticatedUser,
  ChatError,
  SCHEMA,
  validateAttachments,
  validateUploadChunk,
} from '../src/lib/server';
import type { ChatAction, ChatState } from '../src/lib/types';
import { PendingSendIds, withRequestDeadline } from '../src/lib/use-chat';
import {
  MAX_ACTION_BODY_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_UPLOAD_BODY_BYTES,
  UPLOAD_CHUNK_BYTES,
} from '../src/lib/media-limits';
import { uploadAttachments } from '../src/lib/media-upload';
import { POST as postUploadRoute } from '../src/app/api/uploads/route';
import { PrivateMediaCache, privateMediaReference } from '../src/lib/media-cache';
import { GET as getAttachmentRoute } from '../src/app/api/attachments/route';
import emojiData from '@emoji-mart/data/sets/15/native.json';
import { isNativeEmoji, MAX_REACTION_LENGTH } from '../src/lib/native-emoji';

const anonKey = `e30.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.test-signature`;

test('native reaction validation accepts every picker variant', () => {
  const values = Object.values(emojiData.emojis).flatMap((emoji) =>
    emoji.skins.map((skin) => skin.native),
  );
  assert.equal(values.length, 3395);
  assert.equal(Math.max(...values.map((value) => value.length)), 15);
  assert.ok(values.every((value) => value.length <= MAX_REACTION_LENGTH));
  for (const value of values) assert.equal(isNativeEmoji(value), true);
});

test('native reaction validation rejects text and mixed sequences', () => {
  for (const value of [
    null,
    undefined,
    7,
    {},
    '',
    'hello',
    '1',
    '👍 ready',
    'ready👍',
    '👍👍',
    '🇬',
    '🇬🇷🇬🇷',
    '🔥🏽',
    '\u200D',
    '\uFE0F',
    '👍\n',
    ' 👍',
    '👍 ',
    '👍'.repeat(11),
  ])
    assert.equal(isNativeEmoji(value), false, 'only one bounded native sequence is allowed');
});

test('demo reactions use the same native sequence contract', () => {
  const initial = createDemoState();
  for (const emoji of ['🇬🇷', '1️⃣', '👩🏽‍💻']) {
    const action: ChatAction = { type: 'react', messageId: 'demo-message-1', emoji };
    const added = applyDemoAction(initial, action).state;
    assert.deepEqual(added.messages[0].reactions, [{ emoji, userIds: [initial.user.id] }]);
    assert.deepEqual(applyDemoAction(added, action).state.messages[0].reactions, []);
  }
  for (const emoji of ['hello', '👍 ready', '👍👍', '🇬', '👍\n'])
    assert.throws(
      () => applyDemoAction(initial, { type: 'react', messageId: 'demo-message-1', emoji }),
      /emoji/,
    );
});

test('chunk validation bounds indices, canonical base64, exact binary lengths, and 5 MB metadata', () => {
  const data = Buffer.alloc(UPLOAD_CHUNK_BYTES).toString('base64');
  const chunk = {
    clientMessageId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    attachmentIndex: 0,
    name: 'photo.png',
    type: 'image/png',
    size: MAX_ATTACHMENT_BYTES,
    chunkIndex: 0,
    totalChunks: 5,
    data,
  };
  assert.equal(validateUploadChunk(chunk).data, data);
  assert.ok(Buffer.byteLength(JSON.stringify(chunk)) < MAX_UPLOAD_BODY_BYTES);
  for (const change of [
    { attachmentIndex: -1 },
    { attachmentIndex: 3 },
    { chunkIndex: 5 },
    { totalChunks: 6 },
    { size: MAX_ATTACHMENT_BYTES + 1 },
    { data: data + 'AAAA' },
    { data: data.slice(4) },
    { data: '!!!!' },
    { type: 'image/svg+xml' },
    { clientMessageId: 'wrong' },
  ])
    assert.throws(() => validateUploadChunk({ ...chunk, ...change }), ChatError);
  const tail = {
    ...chunk,
    size: UPLOAD_CHUNK_BYTES + 1,
    totalChunks: 2,
    chunkIndex: 1,
    data: 'AA==',
  };
  assert.equal(validateUploadChunk(tail).size, UPLOAD_CHUNK_BYTES + 1);
  assert.throws(
    () => validateUploadChunk({ ...tail, data: 'AB==' }),
    /data/,
    'unused padding bits must be canonical',
  );
});

test('upload route rejects unsigned and cross-origin requests before database access and uses a small body bound', async () => {
  configure();
  const unsigned = await postUploadRoute(
    new Request('https://chat.example.com/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
  assert.equal(unsigned.status, 401);
  const foreign = await postUploadRoute(
    new Request('https://chat.example.com/api/uploads', {
      method: 'POST',
      headers: { Origin: 'https://outside.example', 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
  assert.equal(foreign.status, 403);
  await assert.rejects(
    readActionBody(
      new Request('https://chat.example.com/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: ' '.repeat(MAX_UPLOAD_BODY_BYTES + 1),
      }),
      MAX_UPLOAD_BODY_BYTES,
    ),
    (error: unknown) => error instanceof ChatError && error.status === 413,
  );
});

test('client media transport bounds every chunk and uses stable final upload references', async () => {
  const bytes = Buffer.alloc(MAX_ATTACHMENT_BYTES, 23);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  const action: Extract<ChatAction, { type: 'send' }> = {
    type: 'send',
    text: '',
    conversationId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    attachments: [
      {
        name: 'photo.png',
        type: 'image/png',
        size: bytes.length,
        url: `data:image/png;base64,${bytes.toString('base64')}`,
      },
    ],
  };
  const chunks: ReturnType<typeof validateUploadChunk>[] = [];
  const final = await uploadAttachments(
    action,
    async (chunk) => {
      chunks.push(validateUploadChunk(chunk));
      assert.ok(Buffer.byteLength(JSON.stringify(chunk)) < MAX_UPLOAD_BODY_BYTES);
    },
    new AbortController().signal,
  );
  assert.equal(chunks.length, 5);
  assert.deepEqual(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, 'base64'))), bytes);
  assert.equal(final.attachments![0].url, `upload:${action.clientMessageId}:0`);
  assert.ok(JSON.stringify(final).length < 1024);
  assert.equal(
    action.attachments![0].url.startsWith('data:'),
    true,
    'draft file data remains intact for retries',
  );
  let duplicate = 0;
  await uploadAttachments(
    action,
    async (chunk) => {
      assert.deepEqual(chunk, chunks[duplicate++]);
    },
    new AbortController().signal,
  );
  const controller = new AbortController();
  let called = 0;
  await assert.rejects(
    uploadAttachments(
      action,
      async () => {
        called++;
        controller.abort(new Error('Offline'));
      },
      controller.signal,
    ),
    /Offline/,
  );
  assert.equal(called, 1, 'cancellation prevents later chunks and final send');
});
function configure() {
  process.env.SUPABASE_URL = 'https://auth.example.com';
  process.env.SUPABASE_ANON_KEY = anonKey;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.TOFU_AUTH_BROKER_URL;
}

test('public config exposes only public settings and rejects insecure/misassigned keys', () => {
  configure();
  process.env.DATABASE_URL = 'postgres://private:secret@private.example/db';
  assert.deepEqual(publicConfig(), {
    authBrokerUrl: 'https://oauth.trytofu.ai',
    supabaseUrl: 'https://auth.example.com',
    supabaseAnonKey: anonKey,
    databaseConfigured: true,
  });
  assert.equal(JSON.stringify(publicConfig()).includes('secret'), false);
  process.env.SUPABASE_URL = 'http://auth.example.com';
  assert.equal(publicConfig().supabaseUrl, '');
  assert.equal(publicConfig().supabaseAnonKey, '');
  process.env.SUPABASE_URL = 'https://user:password@auth.example.com';
  assert.equal(publicConfig().supabaseUrl, '');
  process.env.SUPABASE_URL = 'https://auth.example.com?secret=no';
  assert.equal(publicConfig().supabaseUrl, '');
  configure();
  process.env.SUPABASE_ANON_KEY = `e30.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.private`;
  assert.equal(publicConfig().supabaseAnonKey, '');
  process.env.SUPABASE_ANON_KEY = 'sb_secret_private';
  assert.equal(publicConfig().supabaseAnonKey, '');
  process.env.SUPABASE_ANON_KEY = 'sb_publishable_demo';
  assert.equal(publicConfig().supabaseAnonKey, 'sb_publishable_demo');
  delete process.env.DATABASE_URL;
});

test('JSON reader accepts ordinary actions, rejects invalid content, and bounds streamed requests', async () => {
  const request = (body: string, headers: Record<string, string> = {}) =>
    new Request('https://chat.example.com/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
  assert.deepEqual(await readActionBody(request('{"type":"read","conversationId":"test"}')), {
    type: 'read',
    conversationId: 'test',
  });
  await assert.rejects(
    readActionBody(request('{')),
    (e: unknown) => e instanceof ChatError && e.status === 400,
  );
  await assert.rejects(
    readActionBody(request('{}', { 'Content-Type': 'text/plain' })),
    (e: unknown) => e instanceof ChatError && e.status === 415,
  );
  await assert.rejects(
    readActionBody(request('{}', { 'Content-Length': String(MAX_ACTION_BODY_BYTES + 1) })),
    (e: unknown) => e instanceof ChatError && e.status === 413,
  );
  await assert.rejects(
    readActionBody(request(' '.repeat(MAX_ACTION_BODY_BYTES + 1))),
    (e: unknown) => e instanceof ChatError && e.status === 413,
  );
});

test('authentication rejects absent bearer and uses provider-verified identity/email', async () => {
  configure();
  await assert.rejects(
    authenticatedUser(new Request('https://chat.example.com/api/chat')),
    (e: unknown) => e instanceof ChatError && e.status === 401,
  );
  const originalFetch = globalThis.fetch;
  let confirmed = true;
  let called = false;
  const token = 'x'.repeat(40);
  globalThis.fetch = async (input, init) => {
    called = true;
    assert.equal(String(input).startsWith('https://auth.example.com/auth/v1/user'), true);
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token}`);
    return Response.json({
      id: 'verified-account-id',
      email: 'friend@example.com',
      email_confirmed_at: confirmed ? '2026-10-05T00:00:00Z' : null,
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
      created_at: '2026-10-05T00:00:00Z',
    });
  };
  const request = new Request('https://chat.example.com/api/chat', {
    headers: { Authorization: `Bearer ${token}` },
  });
  try {
    const user = await authenticatedUser(request);
    assert.equal(user.id, 'verified-account-id');
    assert.equal(user.email, 'friend@example.com');
    assert.equal(called, true);
    confirmed = false;
    await assert.rejects(
      authenticatedUser(request),
      (e: unknown) => e instanceof ChatError && e.status === 403,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('demo conversations implement message, thread, reaction, star, profile, and leaving interactions', () => {
  let state = createDemoState();
  const mutate = (action: ChatAction) => {
    const result = applyDemoAction(state, action);
    state = result.state;
    return result.id;
  };
  const original: ChatState = structuredClone(state);
  const conversationId = mutate({
    type: 'create',
    name: 'Friends',
    kind: 'group',
    emails: ['friend@example.com'],
  })!;
  const conversation = () => state.conversations.find((c) => c.id === conversationId)!;
  assert.equal(conversation().members.length, 2);
  const messageId = mutate({ type: 'send', conversationId, text: 'Hello, friend!' })!;
  mutate({ type: 'react', messageId, emoji: '👍' });
  assert.deepEqual(state.messages.at(-1)?.reactions, [{ emoji: '👍', userIds: [state.user.id] }]);
  mutate({ type: 'react', messageId, emoji: '👍' });
  assert.equal(state.messages.at(-1)?.reactions.length, 0);
  mutate({ type: 'star', messageId });
  assert.equal(state.messages.at(-1)?.starred, true);
  mutate({ type: 'edit', messageId, text: 'Hello again!' });
  assert.equal(state.messages.at(-1)?.edited, true);
  const replyId = mutate({
    type: 'send',
    conversationId,
    text: 'A thread reply',
    parentId: messageId,
  });
  assert.equal(state.messages.find((m) => m.id === replyId)?.parentId, messageId);
  mutate({ type: 'read', conversationId, unread: true });
  assert.equal(conversation().unread, 1);
  mutate({ type: 'read', conversationId });
  assert.equal(conversation().unread, 0);
  mutate({
    type: 'conversation',
    conversationId,
    pinned: true,
    muted: true,
    section: 'My people',
    name: 'Best friends',
  });
  assert.equal(conversation().name, 'Best friends');
  assert.equal(conversation().pinned, true);
  assert.equal(conversation().muted, true);
  assert.equal(conversation().section, 'My people');
  mutate({ type: 'invite', conversationId, emails: ['another@example.com'] });
  assert.equal(conversation().members.length, 3);
  mutate({ type: 'profile', name: 'New Name', status: 'Away' });
  assert.equal(state.messages.find((m) => m.id === messageId)?.author.name, 'New Name');
  mutate({ type: 'delete', messageId });
  const deleted = state.messages.find((m) => m.id === messageId)!;
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.text, '');
  assert.deepEqual(deleted.attachments, []);
  mutate({ type: 'leave', conversationId });
  assert.equal(
    state.conversations.some((c) => c.id === conversationId),
    false,
  );
  assert.equal(
    state.messages.some((m) => m.conversationId === conversationId),
    false,
  );
  assert.equal(
    original.messages.find((m) => m.id === 'demo-message-1')?.text.includes('Good morning'),
    true,
  );
});

test('demo rejects foreign edits, cross-conversation threads, invalid invitations and unsafe attachment URLs', () => {
  const state = createDemoState();
  assert.throws(
    () => applyDemoAction(state, { type: 'edit', messageId: 'demo-message-1', text: 'Changed' }),
    /your own/,
  );
  assert.throws(
    () => applyDemoAction(state, { type: 'delete', messageId: 'demo-message-1' }),
    /your own/,
  );
  assert.throws(
    () =>
      applyDemoAction(state, {
        type: 'send',
        conversationId: 'demo-maya-dm',
        text: 'Wrong thread',
        parentId: 'demo-message-1',
      }),
    /thread/,
  );
  assert.throws(
    () =>
      applyDemoAction(state, {
        type: 'create',
        name: 'Bad',
        kind: 'group',
        emails: ['not an email'],
      }),
    /email/,
  );
  assert.throws(
    () =>
      applyDemoAction(state, {
        type: 'invite',
        conversationId: 'demo-maya-dm',
        emails: ['friend@example.com'],
      }),
    /group/,
  );
  assert.throws(
    () =>
      applyDemoAction(state, {
        type: 'send',
        conversationId: 'demo-design',
        text: '',
        attachments: [
          { name: 'bad.svg', type: 'image/svg+xml', url: 'javascript:alert(1)', size: 100 },
        ],
      }),
    /Attach/,
  );
  assert.throws(
    () =>
      applyDemoAction(state, {
        type: 'send',
        conversationId: 'demo-design',
        text: 'x'.repeat(6001),
      }),
    /6000/,
  );
  const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]).toString('base64');
  const sent = applyDemoAction(state, {
    type: 'send',
    conversationId: 'demo-design',
    text: '',
    attachments: [
      { name: 'voice.webm', type: 'audio/webm', url: `data:audio/webm;base64,${audio}`, size: 5 },
    ],
  });
  assert.equal(sent.state.messages.at(-1)?.attachments[0].type, 'audio/webm');
});

test('schema keeps chat tables private and enables RLS for every table', () => {
  assert.match(SCHEMA, /CREATE SCHEMA IF NOT EXISTS relay/);
  assert.match(SCHEMA, /REVOKE ALL ON SCHEMA relay FROM PUBLIC/);
  for (const name of [
    'profiles',
    'conversations',
    'participants',
    'invites',
    'messages',
    'reactions',
    'stars',
    'events',
    'uploads',
    'schema_migrations',
  ]) {
    assert.match(SCHEMA, new RegExp(`CREATE TABLE IF NOT EXISTS relay\\.${name}`));
    assert.match(SCHEMA, new RegExp(`ALTER TABLE relay\\.${name} ENABLE ROW LEVEL SECURITY`));
  }
});

test('server accepts safe media signatures and rejects active content, spoofing, mismatched sizes, and excessive files', () => {
  const file = (type: string, bytes: Buffer) => ({
    name: 'attachment',
    type,
    size: bytes.length,
    url: `data:${type};base64,${bytes.toString('base64')}`,
  });
  const png = file('image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  assert.equal(validateAttachments([png])[0].type, 'image/png');
  for (const [type, bytes] of [
    ['audio/webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0])],
    ['audio/mp4', Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 0])],
    ['audio/ogg', Buffer.from('OggS\0')],
    ['audio/wav', Buffer.from([82, 73, 70, 70, 12, 0, 0, 0, 87, 65, 86, 69])],
    ['audio/mpeg', Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0])],
    ['audio/mpeg', Buffer.from([255, 251, 144, 0])],
  ] as const)
    assert.equal(validateAttachments([file(type, bytes)])[0].type, type);
  assert.throws(
    () =>
      validateAttachments([
        { ...png, type: 'image/svg+xml', url: 'data:image/svg+xml;base64,PHN2Zz4=' },
      ]),
    /Use an image/,
  );
  assert.throws(() => validateAttachments([{ ...png, url: 'javascript:alert(1)' }]), /file data/);
  assert.throws(
    () => validateAttachments([file('image/png', Buffer.from('<script>alert(1)</script>'))]),
    /content does not match/,
  );
  assert.throws(
    () => validateAttachments([file('audio/webm', Buffer.from('<script>alert(1)</script>'))]),
    /content does not match/,
  );
  assert.throws(
    () => validateAttachments([file('audio/wav', Buffer.from('RIFFxxxxNOTWAVE'))]),
    /content does not match/,
  );
  assert.throws(
    () => validateAttachments([file('audio/mpeg', Buffer.from('<script>alert(1)</script>'))]),
    /content does not match/,
  );
  assert.throws(
    () => validateAttachments([file('audio/mpeg', Buffer.from([255, 224, 0, 0]))]),
    /content does not match/,
  );
  assert.throws(() => validateAttachments([{ ...png, size: 1 }]), /up to 5 MB/);
  assert.throws(() => validateAttachments([png, png, png, png]), /up to 3/);
  assert.throws(
    () => validateAttachments([file('text/plain', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))]),
    /up to 5 MB/,
  );
});

test('5 MB media boundary accepts actual signatures just below and at the limit, and rejects one byte above', () => {
  for (const [type, signature] of [
    ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
    ['application/pdf', Buffer.from('%PDF-1.7\n')],
    ['audio/mp4', Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 109, 52, 97, 32])],
  ] as const) {
    for (const size of [MAX_ATTACHMENT_BYTES - 1, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES + 1]) {
      const bytes = Buffer.alloc(size);
      signature.copy(bytes);
      const attachment = {
        name: 'size-boundary',
        type,
        size,
        url: `data:${type};base64,${bytes.toString('base64')}`,
      };
      if (size <= MAX_ATTACHMENT_BYTES)
        assert.equal(validateAttachments([attachment])[0].size, size, `${type} ${size} bytes`);
      else
        assert.throws(
          () => validateAttachments([attachment]),
          /up to 5 MB/,
          `${type} one byte above limit`,
        );
    }
    const invalid = Buffer.alloc(MAX_ATTACHMENT_BYTES);
    assert.throws(
      () =>
        validateAttachments([
          {
            name: 'spoofed-media',
            type,
            size: invalid.length,
            url: `data:${type};base64,${invalid.toString('base64')}`,
          },
        ]),
      /content does not match/,
    );
  }
});

test('three maximum-size attachments fit the bounded JSON request including base64 and UTF-8 metadata', async () => {
  const bytes = Buffer.alloc(MAX_ATTACHMENT_BYTES);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  const attachments = Array.from({ length: MAX_ATTACHMENTS }, (_, index) => ({
    name: `image-${index}.png`,
    type: 'image/png',
    size: bytes.length,
    url: `data:image/png;base64,${bytes.toString('base64')}`,
  }));
  const action = {
    type: 'send',
    conversationId: '11111111-1111-4111-8111-111111111111',
    text: '😀'.repeat(3000),
    attachments,
  };
  const body = JSON.stringify(action);
  assert.equal(
    Buffer.byteLength(body) > 20 * 1024 * 1024,
    true,
    'binary-to-base64 overhead exceeds 20 MiB',
  );
  assert.equal(Buffer.byteLength(body) < MAX_ACTION_BODY_BYTES, true);
  const parsed = (await readActionBody(
    new Request('https://chat.example.com/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
  )) as typeof action;
  assert.equal(validateAttachments(parsed.attachments).length, MAX_ATTACHMENTS);
  assert.equal(parsed.text, action.text);
});

test('JSON byte limit accepts its exact boundary and cancels an oversized chunked stream even with a false length header', async () => {
  const exact = '{}'.padEnd(MAX_ACTION_BODY_BYTES);
  assert.deepEqual(
    await readActionBody(
      new Request('https://chat.example.com/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: exact,
      }),
    ),
    {},
  );
  let cancelled = false;
  let sent = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
      if (++sent > 24) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '2' },
    body: stream,
    duplex: 'half',
  } as RequestInit;
  await assert.rejects(
    readActionBody(new Request('https://chat.example.com/api/chat', init)),
    (e: unknown) => e instanceof ChatError && e.status === 413,
  );
  assert.equal(cancelled, true);
});

test('demo uses the same inclusive 5 MB limit for picked files and audio', () => {
  const bytes = Buffer.alloc(MAX_ATTACHMENT_BYTES);
  const attachment = {
    name: 'large.txt',
    type: 'text/plain',
    size: bytes.length,
    url: `data:text/plain;base64,${bytes.toString('base64')}`,
  };
  const result = applyDemoAction(createDemoState(), {
    type: 'send',
    conversationId: 'demo-design',
    text: '',
    attachments: [attachment],
  });
  assert.equal(result.state.messages.at(-1)?.attachments[0].size, MAX_ATTACHMENT_BYTES);
  assert.throws(
    () =>
      applyDemoAction(result.state, {
        type: 'send',
        conversationId: 'demo-design',
        text: '',
        attachments: [{ ...attachment, size: MAX_ATTACHMENT_BYTES + 1 }],
      }),
    /up to 5 MB/,
  );
});

test('private binary endpoint rejects unauthenticated requests before accessing database media', async () => {
  configure();
  const response = await getAttachmentRoute(
    new Request(
      'https://chat.example.com/api/attachments?messageId=11111111-1111-4111-8111-111111111111&index=0',
    ),
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Sign in to continue.' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

const mediaBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
function mediaFixture(count = 1, account = 'account-a'): ChatState {
  const state = createDemoState();
  state.user = { ...state.user, id: account };
  state.messages = Array.from({ length: count }, (_, index) => {
    const id = `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`;
    return {
      ...state.messages[0],
      id,
      attachments: [
        {
          name: `${index}.png`,
          type: 'image/png',
          size: mediaBytes.length,
          url: `/api/attachments?messageId=${id}&index=0`,
        },
      ],
    };
  });
  return state;
}
function mediaResponse(bytes: Uint8Array = mediaBytes, type = 'image/png') {
  return new Response(Uint8Array.from(bytes), {
    headers: { 'Content-Type': type, 'Content-Length': String(bytes.byteLength) },
  });
}

test('private media cache stays lazy, deduplicates downloads and reuses object URLs across polling', async () => {
  let calls = 0;
  let created = 0;
  const revoked: string[] = [];
  const cache = new PrivateMediaCache(
    async () => {
      calls++;
      return mediaResponse();
    },
    () => {},
    { create: () => `blob:fixture-${++created}`, revoke: (url) => revoked.push(url) },
  );
  const state = mediaFixture();
  cache.adopt(state);
  assert.equal(calls, 0);
  assert.equal(cache.materialize(state).messages[0].attachments[0].url, '');
  assert.equal(cache.materialize(state).messages[0].attachments[0].loading, true);
  const source = state.messages[0].attachments[0].url;
  await Promise.all([cache.load(source), cache.load(source)]);
  assert.equal(calls, 1);
  assert.equal(created, 1);
  assert.equal(cache.materialize(state).messages[0].attachments[0].url, 'blob:fixture-1');
  cache.adopt(structuredClone(state));
  await cache.load(source);
  assert.equal(calls, 1, 'ordinary polls never re-download a cached file');
  cache.reset();
  assert.deepEqual(revoked, ['blob:fixture-1']);
});

test('private media cache limits download concurrency and releases queued jobs after reset', async () => {
  const pending: (() => void)[] = [];
  let calls = 0;
  const cache = new PrivateMediaCache(
    () => {
      calls++;
      return new Promise((resolve) => pending.push(() => resolve(mediaResponse())));
    },
    () => {},
    { create: () => 'blob:fixture', revoke: () => {} },
  );
  const state = mediaFixture(3);
  cache.adopt(state);
  const jobs = state.messages.map((message) => cache.load(message.attachments[0].url));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  pending.shift()!();
  await jobs[0];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
  cache.reset();
  await Promise.all(jobs);
  pending.forEach((resolve) => resolve());
});

test('account reset prevents a late download from repopulating another identity and revokes saved media', async () => {
  let resolveOld: (response: Response) => void = () => {};
  let calls = 0;
  const created: string[] = [];
  const revoked: string[] = [];
  const cache = new PrivateMediaCache(
    () =>
      ++calls === 1
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(mediaResponse()),
    () => {},
    {
      create: () => {
        const url = `blob:fixture-${created.length}`;
        created.push(url);
        return url;
      },
      revoke: (url) => revoked.push(url),
    },
  );
  const first = mediaFixture(1, 'account-a');
  cache.adopt(first);
  const oldJob = cache.load(first.messages[0].attachments[0].url);
  await new Promise((resolve) => setImmediate(resolve));
  const second = mediaFixture(1, 'account-b');
  cache.adopt(second);
  resolveOld(mediaResponse());
  await oldJob;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 0, 'late private media for the previous account is discarded');
  await cache.load(second.messages[0].attachments[0].url);
  assert.equal(calls, 2);
  assert.equal(created.length, 1);
  cache.reset();
  assert.deepEqual(revoked, created);
});

test('private media errors remain retryable without polling loops and validate MIME and byte lengths', async () => {
  let calls = 0;
  let failure = 'status';
  const cache = new PrivateMediaCache(
    async () => {
      calls++;
      if (failure === 'status') return new Response(null, { status: 503 });
      if (failure === 'mime') return mediaResponse(mediaBytes, 'text/plain');
      if (failure === 'size') return mediaResponse(mediaBytes.subarray(0, 3));
      return mediaResponse();
    },
    () => {},
    { create: () => 'blob:fixture', revoke: () => {} },
  );
  const state = mediaFixture();
  cache.adopt(state);
  const source = state.messages[0].attachments[0].url;
  await cache.load(source);
  assert.match(cache.materialize(state).messages[0].attachments[0].error!, /retry/);
  cache.adopt(state);
  await cache.load(source);
  assert.equal(calls, 1, 'polling/visibility does not endlessly retry a failed file');
  for (failure of ['mime', 'size']) {
    await cache.load(source, true);
    assert.match(cache.materialize(state).messages[0].attachments[0].error!, /unavailable/);
  }
  failure = 'ok';
  await cache.load(source, true);
  assert.equal(cache.materialize(state).messages[0].attachments[0].url, 'blob:fixture');
  cache.adopt({ ...state, messages: [] });
  cache.reset();
});

test('private media native transport errors use connection guidance and retry only on request', async () => {
  let attempts = 0;
  const cache = new PrivateMediaCache(
    async () => {
      if (++attempts === 1) throw new TypeError('Load failed');
      return mediaResponse();
    },
    () => {},
    { create: () => 'blob:network-retry', revoke: () => {} },
  );
  const state = mediaFixture();
  const source = state.messages[0].attachments[0].url;
  try {
    cache.adopt(state);
    await cache.load(source);
    const failed = cache.materialize(state).messages[0].attachments[0];
    assert.equal(failed.error, 'Connection interrupted. Check your connection and try again.');
    assert.equal(failed.url, '');
    cache.adopt(state);
    await cache.load(source);
    assert.equal(attempts, 1, 'a normalized error does not introduce automatic retries');
    await cache.load(source, true);
    assert.equal(attempts, 2);
    assert.equal(cache.materialize(state).messages[0].attachments[0].url, 'blob:network-retry');
  } finally {
    cache.reset();
  }
});

test('media reference parsing never fetches arbitrary hosts or unregistered private URLs', async () => {
  let calls = 0;
  const cache = new PrivateMediaCache(
    async () => {
      calls++;
      return mediaResponse();
    },
    () => {},
  );
  cache.adopt(mediaFixture());
  for (const source of [
    'https://evil.example/file',
    '//evil.example/file',
    'data:image/png;base64,AA==',
    '/api/attachments?messageId=11111111-1111-4111-8111-000000000002&index=0',
    '/api/attachments?messageId=11111111-1111-4111-8111-000000000001&index=0&token=bad',
  ])
    await cache.load(source);
  assert.equal(calls, 0);
  assert.equal(
    privateMediaReference(
      '/api/attachments?messageId=11111111-1111-4111-8111-000000000001&index=3',
    ),
    undefined,
  );
  cache.reset();
});

test('bounded media cache evicts older object URLs and deletes files removed by fresh state', async () => {
  let created = 0;
  const revoked: string[] = [];
  const cache = new PrivateMediaCache(
    async () => mediaResponse(),
    () => {},
    { create: () => `blob:fixture-${++created}`, revoke: (url) => revoked.push(url) },
    { bytes: 18, files: 2 },
  );
  const state = mediaFixture(3);
  cache.adopt(state);
  for (const message of state.messages) await cache.load(message.attachments[0].url);
  assert.deepEqual(revoked, ['blob:fixture-1']);
  assert.match(cache.materialize(state).messages[0].attachments[0].error!, /Retry/);
  assert.equal(cache.materialize(state).messages[2].attachments[0].url, 'blob:fixture-3');
  cache.adopt({ ...state, messages: [] });
  assert.deepEqual(revoked, ['blob:fixture-1', 'blob:fixture-2', 'blob:fixture-3']);
  cache.reset();
});

test('Media eviction needs explicit retry', async () => {
  let calls = 0;
  let created = 0;
  const cache = new PrivateMediaCache(
    async () => {
      calls++;
      return mediaResponse();
    },
    () => {},
    { create: () => `blob:fixture-${++created}`, revoke: () => {} },
    { bytes: 18, files: 2 },
  );
  const state = mediaFixture(3);
  cache.adopt(state);
  for (const message of state.messages) await cache.load(message.attachments[0].url);
  assert.equal(calls, 3);
  const evicted = cache.materialize(state).messages[0].attachments[0];
  assert.equal(evicted.url, '');
  assert.equal(evicted.loading, false);
  assert.match(evicted.error!, /cleared from memory/);
  for (let poll = 0; poll < 3; poll++) {
    cache.adopt(structuredClone(state));
    for (const message of state.messages) await cache.load(message.attachments[0].url);
  }
  assert.equal(
    calls,
    3,
    'visible rows and polling must never automatically re-download an evicted file',
  );
  assert.equal(
    (cache as unknown as { entries: Map<string, unknown> }).entries.size,
    2,
    'eviction flags share source metadata; they do not accumulate cached entries',
  );
  await cache.load(state.messages[0].attachments[0].url, true);
  assert.equal(calls, 4);
  assert.equal(cache.materialize(state).messages[0].attachments[0].url, 'blob:fixture-4');
  assert.equal((cache as unknown as { entries: Map<string, unknown> }).entries.size, 2);
  cache.reset();
});

test('auth provider outages preserve sessions while invalid credentials still require sign-in', async () => {
  configure();
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const request = new Request('https://chat.example.com/api/chat', {
    headers: { Authorization: `Bearer ${'x'.repeat(40)}` },
  });
  try {
    globalThis.fetch = async () =>
      Response.json({ message: 'Temporary provider outage' }, { status: 503 });
    await assert.rejects(
      authenticatedUser(request),
      (e: unknown) => e instanceof ChatError && e.status === 503,
    );
    console.error = () => undefined; // SDK logs its synthetic transport error.
    globalThis.fetch = async () => {
      throw new TypeError('Synthetic network failure');
    };
    await assert.rejects(
      authenticatedUser(request),
      (e: unknown) => e instanceof ChatError && e.status === 503,
    );
    globalThis.fetch = async () =>
      Response.json({ message: 'Invalid JWT', code: 'bad_jwt' }, { status: 401 });
    await assert.rejects(
      authenticatedUser(request),
      (e: unknown) => e instanceof ChatError && e.status === 401,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test('request deadlines and external offline abort release even unresponsive operations', async () => {
  const deadline = new AbortController();
  await assert.rejects(
    withRequestDeadline(deadline, 10, () => new Promise<never>(() => undefined)),
    /timed out/,
  );
  assert.equal(deadline.signal.aborted, true);
  const offline = new AbortController();
  const pending = withRequestDeadline(offline, 1000, () => new Promise<never>(() => undefined));
  offline.abort(new Error('Offline fixture'));
  await assert.rejects(pending, /Offline fixture/);
  const recovered = new AbortController();
  assert.equal(await withRequestDeadline(recovered, 1000, async () => 'recovered'), 'recovered');
  assert.equal(recovered.signal.aborted, false);
});

test('logical sends reuse UUIDs after ambiguous failure and renew them after acknowledgement or account reset', async () => {
  const ids = new PendingSendIds();
  const send: Extract<ChatAction, { type: 'send' }> = {
    type: 'send',
    conversationId: '11111111-1111-4111-8111-111111111111',
    text: ' Hello friend ',
  };
  const original = await ids.prepare(send);
  const retry = await ids.prepare({ ...send, text: 'Hello friend' });
  assert.equal(retry.action.clientMessageId, original.action.clientMessageId);
  ids.acknowledge(original.fingerprint, original.action.clientMessageId);
  const intentionalRepeat = await ids.prepare(send);
  assert.notEqual(intentionalRepeat.action.clientMessageId, original.action.clientMessageId);
  ids.clear();
  const newAccount = await ids.prepare(send);
  assert.notEqual(newAccount.action.clientMessageId, intentionalRepeat.action.clientMessageId);
  const differentText = await ids.prepare({ ...send, text: 'Different message' });
  assert.notEqual(differentText.action.clientMessageId, newAccount.action.clientMessageId);
  const inFlight = ids.prepare(send);
  ids.clear();
  await assert.rejects(inFlight, /account changed/);
});

test('native M4A picker fixture passes canonical audio/mp4 server validation', () => {
  const bytes = readFileSync('tests/fixtures/picker-tone.m4a');
  const files = validateAttachments([
    {
      name: 'picker-tone.m4a',
      type: 'audio/mp4',
      size: bytes.length,
      url: `data:audio/mp4;base64,${bytes.toString('base64')}`,
    },
  ]);
  assert.equal(files[0].size, bytes.length);
  assert.equal(files[0].type, 'audio/mp4');
});

test('send IDs survive reload as hashed metadata and remain isolated by verified account', async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const action: Extract<ChatAction, { type: 'send' }> = {
    type: 'send',
    conversationId: '11111111-1111-4111-8111-111111111111',
    text: 'Private message content',
    attachments: [
      { name: 'private.txt', type: 'text/plain', size: 6, url: 'data:text/plain;base64,c2VjcmV0' },
    ],
  };
  const first = new PendingSendIds(storage);
  first.bindVerifiedIdentity('verified-account-a');
  const ambiguous = await first.prepare(action);
  assert.equal([...values.values()].join('').includes(action.text), false);
  assert.equal([...values.values()].join('').includes(action.attachments![0].url), false);
  first.clear(); // Component unmount/startup keeps the metadata.
  const reloaded = new PendingSendIds(storage);
  reloaded.bindVerifiedIdentity('verified-account-a');
  const retried = await reloaded.prepare(action);
  assert.equal(retried.action.clientMessageId, ambiguous.action.clientMessageId);
  reloaded.acknowledge(retried.fingerprint, retried.action.clientMessageId);
  const acknowledgedReload = new PendingSendIds(storage);
  acknowledgedReload.bindVerifiedIdentity('verified-account-a');
  const newSend = await acknowledgedReload.prepare(action);
  assert.notEqual(newSend.action.clientMessageId, ambiguous.action.clientMessageId);
  acknowledgedReload.bindVerifiedIdentity('verified-account-b');
  assert.equal(values.has('relay-chat-send-ids-v1:verified-account-a'), false);
  const otherAccount = await acknowledgedReload.prepare(action);
  assert.notEqual(otherAccount.action.clientMessageId, newSend.action.clientMessageId);
  acknowledgedReload.clear(true); // Explicit sign-out removes retry metadata.
  assert.equal(values.has('relay-chat-send-ids-v1:verified-account-b'), false);
  assert.equal(values.has('relay-chat-send-ids-last-identity-v1'), false);
});

test('storage failures retain bounded in-memory send retry protection', async () => {
  const storage = {
    getItem: () => {
      throw new Error('Storage denied');
    },
    setItem: () => {
      throw new Error('Storage denied');
    },
    removeItem: () => {
      throw new Error('Storage denied');
    },
  };
  const ids = new PendingSendIds(storage);
  ids.bindVerifiedIdentity('verified-account-a');
  const action: Extract<ChatAction, { type: 'send' }> = {
    type: 'send',
    conversationId: '11111111-1111-4111-8111-111111111111',
    text: 'Hello',
  };
  const first = await ids.prepare(action);
  assert.equal((await ids.prepare(action)).action.clientMessageId, first.action.clientMessageId);
  ids.clear(true);
  assert.notEqual((await ids.prepare(action)).action.clientMessageId, first.action.clientMessageId);
});
