import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  fixtureUser,
  freePort,
  nativeCluster,
  nativeEnabled,
  nativeSkip,
  recordNativeEvidence,
  spawnNext,
  stopChild,
  until,
} from './helpers/native-postgres';

test(
  'opt-in actual Next HTTP routes bridge HTTPS getUser and native PostgreSQL with synthetic identities',
  { skip: nativeEnabled ? false : nativeSkip, timeout: 90000 },
  async (t) => {
    const cluster = await nativeCluster('http');
    const owner = fixtureUser('http-owner'),
      peer = fixtureUser('http-peer'),
      outsider = fixtureUser('http-outsider');
    const cached = fixtureUser('http-cached'),
      rightful = fixtureUser('http-rightful'),
      inviter = fixtureUser('http-inviter');
    const previousEmail = 'transferred-address@native-test.invalid';
    cached.email = previousEmail;
    rightful.email = previousEmail;
    // Deliberately recognizable fixture strings, not credentials or real sessions.
    const tokens = new Map([
      ['synthetic-native-owner-token', owner],
      ['synthetic-native-peer-token', peer],
      ['synthetic-native-outsider-token', outsider],
      ['synthetic-native-cached-token', cached],
      ['synthetic-native-rightful-token', rightful],
      ['synthetic-native-inviter-token', inviter],
    ]);
    let providerMode: 'normal' | 'outage' = 'normal',
      identityRequests = 0;
    const provider = createServer(
      { key: await readFile(cluster.keyPath), cert: await readFile(cluster.certPath) },
      (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.url !== '/auth/v1/user') {
          response.writeHead(404);
          response.end(JSON.stringify({ message: 'Fixture path unavailable' }));
          return;
        }
        identityRequests++;
        if (providerMode === 'outage') {
          response.writeHead(503);
          response.end(JSON.stringify({ message: 'Fixture auth outage' }));
          return;
        }
        const token = String(request.headers.authorization ?? '').replace(/^Bearer /, ''),
          user = tokens.get(token);
        if (!user) {
          response.writeHead(401);
          response.end(JSON.stringify({ message: 'Fixture token rejected', code: 'bad_jwt' }));
          return;
        }
        response.writeHead(200);
        response.end(JSON.stringify(user));
      },
    );
    let next: ReturnType<typeof spawnNext> | undefined;
    let evidence: Record<string, unknown> | undefined;
    let primaryFailure: unknown;
    let failed = false;
    const cleanupFailures: unknown[] = [];
    const started = Date.now(),
      completed: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        provider.once('error', reject);
        provider.listen(0, '127.0.0.1', resolve);
      });
      const address = provider.address();
      assert.ok(address && typeof address !== 'string');
      // Installed NextURL normalizes loopback hostnames to localhost. Use that
      // canonical origin for both the actual wire Host and browser Origin header.
      const authUrl = `https://127.0.0.1:${address.port}`,
        authBrokerUrl = 'https://broker.native-test.invalid',
        port = await freePort(),
        origin = `http://localhost:${port}`;
      const buildId = (await readFile('.next/BUILD_ID', 'utf8')).trim();
      if (process.env.CHAT_NATIVE_EXPECTED_BUILD_ID)
        assert.equal(
          buildId,
          process.env.CHAT_NATIVE_EXPECTED_BUILD_ID,
          'explicit externally reviewed build binding',
        );
      let buildBinding:
        { buildId: string; runtimeSourceHashes: Record<string, string>; scope: string } | undefined;
      if (process.env.CHAT_NATIVE_BUILD_BINDING) {
        buildBinding = JSON.parse(await readFile(process.env.CHAT_NATIVE_BUILD_BINDING, 'utf8'));
        assert.equal(buildBinding!.buildId, buildId);
        for (const [path, hash] of Object.entries(buildBinding!.runtimeSourceHashes))
          assert.equal(
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex'),
            hash,
            `fresh-build source binding for ${path}`,
          );
      }
      next = spawnNext(port, {
        ...process.env,
        NODE_ENV: 'production',
        NODE_EXTRA_CA_CERTS: cluster.certPath,
        DATABASE_URL: cluster.url,
        SUPABASE_URL: authUrl,
        SUPABASE_ANON_KEY: 'sb_publishable_native_fixture',
        NEXT_PUBLIC_SUPABASE_URL: authUrl,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_native_fixture',
        // Set after the build to prove the compiled endpoint reads runtime configuration.
        TOFU_AUTH_BROKER_URL: authBrokerUrl,
        NEXT_TELEMETRY_DISABLED: '1',
      });
      await until(
        async () => {
          if (next!.child.exitCode !== null)
            throw new Error(
              `Isolated Next process exited before readiness: ${next!.diagnostics()}`,
            );
          try {
            return (await fetch(`${origin}/api/config`, { signal: AbortSignal.timeout(500) })).ok;
          } catch {
            return false;
          }
        },
        'isolated production Next API',
        20000,
      );
      const admin = cluster.client();
      type Actor = 'owner' | 'peer' | 'outsider' | 'cached' | 'rightful' | 'inviter';
      const tokenFor = (who: Actor = 'owner') => `synthetic-native-${who}-token`;
      async function request(
        path: string,
        body?: unknown,
        who: Actor = 'owner',
        extra: Record<string, string> = {},
      ) {
        return fetch(origin + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Authorization: `Bearer ${tokenFor(who)}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }),
            ...extra,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        });
      }
      async function json(path: string, body?: unknown, who: Actor = 'owner') {
        const response = await request(path, body, who);
        const data = await response.json();
        assert.equal(
          response.status,
          200,
          `expected success for ${path}; received ${response.status}: ${data.error ?? ''}`,
        );
        assert.match(response.headers.get('cache-control') ?? '', /no-store/);
        return data;
      }
      let conversationId = '',
        messageId = '';
      await t.test(
        'actual HTTP config, verified identity, invitation claims and send receipt replay',
        async () => {
          const configResponse = await fetch(origin + '/api/config'),
            config = await configResponse.json();
          assert.equal(configResponse.status, 200);
          assert.match(configResponse.headers.get('cache-control') ?? '', /no-store/);
          assert.equal(config.databaseConfigured, true);
          assert.equal(config.supabaseUrl, authUrl);
          assert.equal(config.supabaseAnonKey, 'sb_publishable_native_fixture');
          assert.equal(config.authBrokerUrl, authBrokerUrl);
          assert.deepEqual(Object.keys(config).sort(), [
            'authBrokerUrl',
            'databaseConfigured',
            'supabaseAnonKey',
            'supabaseUrl',
          ]);
          assert.ok(!JSON.stringify(config).includes('chat_fixture'));
          assert.equal((await json('/api/chat')).state.user.id, owner.id);
          const clientActionId = crypto.randomUUID(),
            creation = {
              type: 'create',
              kind: 'group',
              name: 'Real HTTP fixture',
              emails: [peer.email!],
              clientActionId,
              clientActionCreatedAt: new Date().toISOString(),
            };
          const created = await json('/api/chat', creation);
          conversationId = created.id;
          assert.ok(conversationId);
          assert.equal(
            (await json('/api/chat', creation)).id,
            conversationId,
            'create receipt prevents a duplicate group across actual HTTP retries',
          );
          const confirmation = await json(`/api/chat?clientActionId=${clientActionId}`);
          assert.equal(confirmation.actionId, clientActionId);
          assert.equal(confirmation.id, conversationId);
          assert.equal(
            (await json('/api/chat', undefined, 'peer')).state.conversations[0].id,
            conversationId,
            'verified email claims its invitation',
          );
          messageId = crypto.randomUUID();
          const send = {
            type: 'send',
            conversationId,
            clientMessageId: messageId,
            text: 'Actual route and native driver message',
          };
          await json('/api/chat', send);
          await json('/api/chat', send);
          const peerState = (await json('/api/chat', undefined, 'peer')).state;
          assert.equal(
            peerState.messages.filter((message: { id: string }) => message.id === messageId).length,
            1,
          );
          assert.equal(
            Number((await admin`select count(*)::int as count from relay.conversations`)[0].count),
            1,
          );
          assert.equal(
            Number((await admin`select count(*)::int as count from relay.messages`)[0].count),
            1,
          );
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.events where conversation_id=${conversationId}`
              )[0].count,
            ),
            3,
            'one creation event before peer joined, then two send events; replay emits none',
          );
          completed.push('positive config/auth/invite/send/create receipt bridge');
        },
      );
      await t.test(
        'actual chunk upload, private byte stream and ownership protections',
        async () => {
          const bytes = Buffer.from('Private native HTTP attachment\n'),
            id = crypto.randomUUID();
          const upload = {
            conversationId,
            clientMessageId: id,
            attachmentIndex: 0,
            name: 'private.txt',
            type: 'text/plain',
            size: bytes.length,
            chunkIndex: 0,
            totalChunks: 1,
            data: bytes.toString('base64'),
          };
          await json('/api/uploads', upload);
          await json('/api/uploads', upload);
          const send = {
            type: 'send',
            conversationId,
            clientMessageId: id,
            text: 'Chunk file',
            attachments: [
              { name: upload.name, type: upload.type, size: upload.size, url: `upload:${id}:0` },
            ],
          };
          await json('/api/chat', send);
          const state = (await json('/api/chat', undefined, 'peer')).state;
          const fileMessage = state.messages.find((message: { id: string }) => message.id === id);
          assert.equal(
            fileMessage.attachments[0].url,
            `/api/attachments?messageId=${id}&index=0`,
            'state has a protected reference, never file base64',
          );
          const response = await request(
            `/api/attachments?messageId=${id}&index=0`,
            undefined,
            'peer',
          );
          assert.equal(response.status, 200);
          assert.equal(response.headers.get('content-type'), 'text/plain');
          assert.match(response.headers.get('cache-control') ?? '', /private.*no-store/);
          assert.match(response.headers.get('vary') ?? '', /Authorization/);
          assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
          assert.equal(
            (await request(`/api/attachments?messageId=${id}&index=0`, undefined, 'outsider'))
              .status,
            404,
          );
          assert.equal(
            (await json('/api/chat', undefined, 'outsider')).state.conversations.length,
            0,
          );
          assert.equal(
            (await request('/api/chat', { type: 'edit', messageId, text: 'Foreign edit' }, 'peer'))
              .status,
            403,
          );
          assert.equal((await request('/api/uploads', upload, 'outsider')).status, 404);
          assert.equal(
            Number((await admin`select count(*)::int as count from relay.uploads`)[0].count),
            0,
          );
          completed.push('chunk/private stream/foreign account and author isolation');
        },
      );
      await t.test(
        'actual HTTP origin, auth rejection, provider outage and write quota classification',
        async () => {
          const before = Number(
            (await admin`select count(*)::int as count from relay.messages`)[0].count,
          );
          const eventsBefore = Number(
            (await admin`select count(*)::int as count from relay.events`)[0].count,
          );
          for (const action of [
            { type: 'edit', messageId, text: 'Rejected surplus target' },
            { type: 'react', messageId, emoji: '👍' },
            { type: 'star', messageId, starred: true },
            { type: 'delete', messageId },
            { type: 'profile', status: 'Rejected surplus target' },
          ]) {
            assert.equal(
              (await request('/api/chat', { ...action, conversationId: crypto.randomUUID() }))
                .status,
              400,
              'surplus targets must be rejected at the actual HTTP boundary',
            );
          }
          assert.equal(
            Number((await admin`select count(*)::int as count from relay.events`)[0].count),
            eventsBefore,
            'rejected input must not emit notifications',
          );
          assert.equal(
            (await admin`select text from relay.messages where id=${messageId}`)[0].text,
            'Actual route and native driver message',
          );
          assert.equal((await fetch(origin + '/api/chat')).status, 401);
          assert.equal(
            (
              await request('/api/chat', undefined, 'owner', {
                Authorization: 'Bearer synthetic-native-rejected-token',
              })
            ).status,
            401,
          );
          assert.equal(
            (
              await request('/api/chat', { type: 'profile', name: 'Must not change' }, 'owner', {
                Origin: 'https://foreign.invalid',
              })
            ).status,
            403,
          );
          providerMode = 'outage';
          const outage = await request('/api/chat');
          assert.equal(outage.status, 503);
          assert.match((await outage.json()).error, /session is still saved/i);
          providerMode = 'normal';
          assert.equal((await json('/api/chat')).state.user.id, owner.id);
          await admin`insert into relay.request_limits(owner_id,bucket,window_start,requests) values(${owner.id},'write',date_trunc('minute',now()),120) on conflict(owner_id,bucket,window_start) do update set requests=120`;
          const limited = await request('/api/chat', {
            type: 'send',
            conversationId,
            text: 'Quota cannot commit',
            clientMessageId: crypto.randomUUID(),
          });
          assert.equal(limited.status, 429);
          assert.match((await limited.json()).error, /wait a minute/);
          assert.equal(
            Number((await admin`select count(*)::int as count from relay.messages`)[0].count),
            before,
          );
          completed.push('HTTP cross-origin/auth outage/invalid token/quota status');
        },
      );
      await t.test(
        'fresh HTTP identity claims prevent cached email ownership from exposing a new private group',
        async () => {
          await json('/api/chat', undefined, 'inviter');
          await json('/api/chat', undefined, 'cached');
          const existing = await json(
            '/api/chat',
            {
              type: 'create',
              kind: 'group',
              name: 'Previously authorized membership',
              emails: [previousEmail],
              clientActionId: crypto.randomUUID(),
              clientActionCreatedAt: new Date().toISOString(),
            },
            'inviter',
          );
          const established = (await json('/api/chat', undefined, 'cached')).state;
          assert.ok(
            established.conversations.some(
              (conversation: { id: string }) => conversation.id === existing.id,
            ),
          );
          const priorMessageId = crypto.randomUUID();
          await json(
            '/api/chat',
            {
              type: 'send',
              conversationId: existing.id,
              text: 'Already authorized historical content',
              clientMessageId: priorMessageId,
            },
            'inviter',
          );

          // Provider authority changes first. The database still maps the old
          // address to A when C invites it; no verified A request has refreshed it.
          cached.email = 'current-address@native-test.invalid';
          assert.equal(
            (await admin`select email from relay.profiles where id=${cached.id}`)[0].email,
            previousEmail,
          );
          const created = await json(
            '/api/chat',
            {
              type: 'create',
              kind: 'group',
              name: 'New private transferred-address group',
              emails: [previousEmail],
              clientActionId: crypto.randomUUID(),
              clientActionCreatedAt: new Date().toISOString(),
            },
            'inviter',
          );
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.participants where conversation_id=${created.id} and user_id=${cached.id}`
              )[0].count,
            ),
            0,
            'cached address alone must never grant new membership',
          );
          assert.ok(
            created.state.conversations
              .find((conversation: { id: string }) => conversation.id === created.id)
              .members.some(
                (person: { id: string; email: string }) =>
                  person.id === `invite:${previousEmail}` && person.email === previousEmail,
              ),
          );
          const secretMessageId = crypto.randomUUID(),
            secretText = 'Only the freshly verified recipient may read this';
          await json(
            '/api/chat',
            {
              type: 'send',
              conversationId: created.id,
              text: secretText,
              clientMessageId: secretMessageId,
            },
            'inviter',
          );

          const refreshed = (await json('/api/chat', undefined, 'cached')).state;
          assert.equal(refreshed.user.id, cached.id);
          assert.equal(refreshed.user.email, cached.email);
          assert.ok(
            refreshed.conversations.some(
              (conversation: { id: string }) => conversation.id === existing.id,
            ),
            'a verified email change preserves already authorized memberships',
          );
          assert.ok(
            refreshed.messages.some((message: { id: string }) => message.id === priorMessageId),
          );
          assert.ok(
            refreshed.conversations.every(
              (conversation: { id: string }) => conversation.id !== created.id,
            ),
          );
          assert.ok(
            refreshed.messages.every(
              (message: { id: string; text: string }) =>
                message.id !== secretMessageId && message.text !== secretText,
            ),
          );
          assert.equal(
            (await admin`select email from relay.profiles where id=${cached.id}`)[0].email,
            cached.email,
          );
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.invites where conversation_id=${created.id} and email=${previousEmail}`
              )[0].count,
            ),
            1,
          );

          const accepted = (await json('/api/chat', undefined, 'rightful')).state;
          assert.equal(accepted.user.id, rightful.id);
          assert.equal(accepted.user.email, previousEmail);
          assert.ok(
            accepted.conversations.some(
              (conversation: { id: string }) => conversation.id === created.id,
            ),
          );
          assert.ok(
            accepted.conversations.every(
              (conversation: { id: string }) => conversation.id !== existing.id,
            ),
            'a reused email does not inherit the former identity’s historical membership',
          );
          assert.equal(
            accepted.messages.filter(
              (message: { id: string; text: string }) =>
                message.id === secretMessageId && message.text === secretText,
            ).length,
            1,
          );
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.participants where conversation_id=${created.id} and user_id=${rightful.id}`
              )[0].count,
            ),
            1,
          );
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.participants where conversation_id=${created.id} and user_id=${cached.id}`
              )[0].count,
            ),
            0,
          );
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.invites where conversation_id=${created.id} and email=${previousEmail}`
              )[0].count,
            ),
            0,
          );
          completed.push(
            'HTTP freshly verified invitation claim, cached-email confidentiality and historical membership isolation',
          );
        },
      );
      const sourceHashes = Object.fromEntries(
        await Promise.all(
          [
            'src/lib/server.ts',
            'src/app/api/chat/route.ts',
            'src/app/api/uploads/route.ts',
            'src/app/api/attachments/route.ts',
            'tests/native-http.test.ts',
            'tests/helpers/native-postgres.ts',
          ].map(async (path) => [
            path,
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex'),
          ]),
        ),
      );
      evidence = {
        scope:
          'Actual prebuilt Next production HTTP handlers -> actual Supabase SDK getUser over local CA-trusted HTTPS -> actual postgres.js SSL driver -> fresh native PostgreSQL. Identities, tokens and provider responses are synthetic; no real Google/Supabase/Tofu account, browser or hosting proof.',
        buildId,
        buildBinding,
        prebuiltSourceVerification: buildBinding
          ? 'Externally recorded fresh production build ID and all recorded runtime source hashes matched before launch.'
          : 'Prebuilt source alignment unverified; hashes describe working files, not their presence in the compiled bundle.',
        sourceHashes,
        cases: completed,
        passed: completed.length === 4,
        identityRequests,
        durationMs: Date.now() - started,
        productionDatabaseTls:
          'Production databaseTls verifies the fixture peer and hostname using NODE_EXTRA_CA_CERTS. This is synthetic trusted-certificate proof; the hosted build gate must separately establish managed-provider connectivity.',
      };
    } catch (error) {
      primaryFailure = error;
      failed = true;
    } finally {
      try {
        if (next) await stopChild(next.child);
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        await cluster.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (failed && !cleanupFailures.length) throw primaryFailure;
    if (cleanupFailures.length)
      throw new AggregateError(
        [...(failed ? [primaryFailure] : []), ...cleanupFailures],
        'Native HTTP fixture failed or teardown did not complete; inspect its private work directory.',
      );
    if (evidence)
      await recordNativeEvidence('native-http', {
        ...evidence,
        cleanup:
          'Next child stopped, provider closed, and exact temporary database stopped/removed successfully',
      });
  },
);
