import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type postgres from 'postgres';
import { databaseTls } from '../src/lib/database-tls';
import { verifyDatabase } from '../scripts/verify-database';
import {
  applySchema,
  ChatError,
  enforceRequestLimit,
  getAttachment,
  getChat,
  mutateChat,
  stageUpload,
  type UploadChunk,
} from '../src/lib/server';
import {
  advisoryBarrier,
  fixtureUser,
  nativeCluster,
  nativeEnabled,
  nativeSkip,
  recordNativeEvidence,
  until,
} from './helpers/native-postgres';

function chunk(
  conversationId: string,
  clientMessageId = crypto.randomUUID(),
  data = Buffer.from('native file'),
): UploadChunk {
  return {
    conversationId,
    clientMessageId,
    attachmentIndex: 0,
    name: 'native.txt',
    type: 'text/plain',
    size: data.length,
    chunkIndex: 0,
    totalChunks: 1,
    data: data.toString('base64'),
  };
}
const failure = (status: number) => (error: unknown) =>
  error instanceof ChatError && error.status === status;

test(
  'opt-in native PostgreSQL concurrency, TLS, memberships and immutable staging',
  { skip: nativeEnabled ? false : nativeSkip, timeout: 90000 },
  async (t) => {
    const fixture = await nativeCluster('database');
    const started = Date.now();
    const completed: string[] = [];
    try {
      const admin = fixture.client(),
        one = fixture.client(),
        two = fixture.client(),
        blocker = fixture.client(),
        observer = fixture.client();
      const pids = await Promise.all(
        [admin, one, two, blocker, observer].map(async (sql) =>
          Number((await sql`select pg_backend_pid() as pid`)[0].pid),
        ),
      );
      assert.equal(
        new Set(pids).size,
        5,
        'five actual native sessions, not a single-session SQL adapter',
      );
      assert.equal(
        (await admin`select ssl from pg_stat_ssl where pid=pg_backend_pid()`)[0].ssl,
        true,
      );
      await applySchema(admin);
      const version = String((await admin`select version()`)[0].version).split(',')[0];
      await t.test(
        'strict runtime TLS and the build gate reject untrusted certificates and preserve hostname checks',
        async () => {
          const required = fixture.client('require');
          assert.equal(
            (await required`select ssl from pg_stat_ssl where pid=pg_backend_pid()`)[0].ssl,
            true,
          );
          const untrusted = fixture.client(databaseTls(fixture.url, { NODE_ENV: 'production' }));
          await assert.rejects(
            untrusted`select 1`,
            (error) => error instanceof Error && /self.signed|certificate/i.test(error.message),
          );
          const trustedOptions = databaseTls(fixture.url, {
            NODE_ENV: 'production',
            DATABASE_CA_CERT: fixture.certificate,
          })!;
          const trusted = fixture.client(trustedOptions);
          assert.equal(
            (await trusted`select ssl from pg_stat_ssl where pid=pg_backend_pid()`)[0].ssl,
            true,
            'runtime helper verifies the fixture CA and host SAN over an encrypted connection',
          );
          assert.equal(Number((await trusted`select 1 as trusted`)[0].trusted), 1);
          const wrongHost = fixture.client({
            ...trustedOptions,
            servername: 'wrong.native-test.invalid',
          });
          await assert.rejects(
            wrongHost`select 1`,
            (error) =>
              error instanceof Error && /hostname|altnames|does not match/i.test(error.message),
            'a trusted CA does not authorize a different server name',
          );
          assert.equal(
            await verifyDatabase({
              DATABASE_URL: fixture.url,
              DATABASE_CA_CERT: fixture.certificate,
            }),
            'verified',
            'actual read-only deployment gate accepts the trusted native certificate',
          );
          await assert.rejects(
            verifyDatabase({ DATABASE_URL: fixture.url }),
            (error) =>
              error instanceof Error &&
              error.message ===
                'Database TLS verification failed. Deployment stopped; check trusted certificate and connection settings.',
            'actual gate rejects an untrusted certificate without exposing connection details',
          );
          completed.push('strict TLS helper and read-only build gate certificate challenge');
        },
      );
      async function pair(label: string) {
        const owner = fixtureUser(`${label}-owner`),
          peer = fixtureUser(`${label}-peer`);
        await getChat(owner, admin);
        await getChat(peer, admin);
        const conversationId = (
          await mutateChat(
            owner,
            { type: 'create', kind: 'group', name: label, emails: [peer.email!] },
            admin,
          )
        ).id!;
        await getChat(peer, admin);
        await admin`delete from relay.events where conversation_id=${conversationId}`;
        return { owner, peer, conversationId };
      }
      const eventCount = async (sql: postgres.Sql, conversationId: string) =>
        Number(
          (
            await sql`select count(*)::int as count from relay.events where conversation_id=${conversationId}`
          )[0].count,
        );
      await t.test(
        'concurrent first sign-ins claim one invitation without losing the latest profile',
        async () => {
          const owner = fixtureUser('first-signin-owner'),
            account = fixtureUser('first-signin-peer');
          await getChat(owner, admin);
          const conversationId = (
            await mutateChat(
              owner,
              {
                type: 'create',
                kind: 'group',
                name: 'Concurrent first sign-in',
                emails: [account.email!],
              },
              admin,
            )
          ).id!;
          let probes = 0,
            release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          // Both real profile SELECTs return absence before either INSERT begins.
          // The second native transaction must then take the insert-only conflict
          // path, reread the committed profile and preserve the claimed membership.
          const observed = (connection: postgres.Sql) =>
            new Proxy(connection, {
              get(target, property) {
                if (property === 'begin')
                  return async (work: (tx: postgres.TransactionSql) => Promise<unknown>) =>
                    target.begin((tx) =>
                      work(
                        new Proxy(tx, {
                          apply: async (tag, receiver, argumentsList) => {
                            const rows = await Reflect.apply(tag, receiver, argumentsList);
                            const parts = argumentsList[0] as TemplateStringsArray;
                            if (
                              Array.isArray(parts) &&
                              parts.join('').includes('has_pending_invites') &&
                              argumentsList.includes(account.id) &&
                              !rows.length
                            ) {
                              probes++;
                              await gate;
                            }
                            return rows;
                          },
                        }),
                      ),
                    );
                return Reflect.get(target, property);
              },
            });
          const reads = Promise.allSettled([
            getChat(account, observed(one)),
            getChat(account, observed(two)),
          ]);
          try {
            await until(async () => probes === 2, 'both identified first-sign-in profile reads');
          } finally {
            release();
          }
          const results = await reads;
          for (const result of results) {
            assert.equal(
              result.status,
              'fulfilled',
              result.status === 'rejected'
                ? `${result.reason?.name} (${result.reason?.code ?? 'no code'}): ${result.reason?.message}`
                : undefined,
            );
            if (result.status === 'fulfilled') {
              assert.equal(result.value.user.id, account.id);
              assert.equal(result.value.user.email, account.email);
              assert.equal(result.value.conversations[0].id, conversationId);
            }
          }
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.profiles where id=${account.id}`
              )[0].count,
            ),
            1,
          );
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.participants where user_id=${account.id} and conversation_id=${conversationId}`
              )[0].count,
            ),
            1,
          );
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.invites where conversation_id=${conversationId}`
              )[0].count,
            ),
            0,
          );
          const otherIdentity = { ...account, id: crypto.randomUUID() };
          await assert.rejects(getChat(otherIdentity, two), failure(409));
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.profiles where id=${otherIdentity.id}`
              )[0].count,
            ),
            0,
          );
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.participants where user_id=${otherIdentity.id}`
              )[0].count,
            ),
            0,
          );
          completed.push('concurrent first-sign-in profile and invitation claim');
        },
      );
      await t.test(
        'an invitation committed after a negative probe is claimed by a resumed or next request',
        async () => {
          const owner = fixtureUser('probe-owner'),
            original = fixtureUser('probe-peer');
          const account = { ...original, email: 'probe-new-address@native-test.invalid' };
          await getChat(owner, admin);
          await getChat(original, admin);
          const conversationId = (
            await mutateChat(
              owner,
              { type: 'create', kind: 'space', name: 'Invitation boundary', emails: [] },
              admin,
            )
          ).id!;
          let entered!: () => void, release!: () => void;
          const ready = new Promise<void>((resolve) => {
              entered = resolve;
            }),
            gate = new Promise<void>((resolve) => {
              release = resolve;
            });
          let gated = false;
          const observed = new Proxy(one, {
            get(target, property) {
              if (property === 'begin')
                return async (work: (tx: postgres.TransactionSql) => Promise<unknown>) =>
                  target.begin((tx) =>
                    work(
                      new Proxy(tx, {
                        apply: async (tag, receiver, argumentsList) => {
                          const rows = await Reflect.apply(tag, receiver, argumentsList);
                          const parts = argumentsList[0] as TemplateStringsArray;
                          if (
                            Array.isArray(parts) &&
                            parts.join('').includes('has_pending_invites') &&
                            argumentsList.includes(account.id) &&
                            !gated
                          ) {
                            assert.equal(rows[0].has_pending_invites, false);
                            gated = true;
                            entered();
                            await gate;
                          }
                          return rows;
                        },
                      }),
                    ),
                  );
              return Reflect.get(target, property);
            },
          });
          const reading = getChat(account, observed);
          const outcome = Promise.allSettled([reading]);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              ready,
              reading.then(() => {
                throw new Error('Profile read completed before its probe gate.');
              }),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Profile probe gate timed out.')), 10000);
              }),
            ]);
            // The inviter sees the committed old address; the new verified address
            // remains unknown until the paused reader performs its actual UPDATE.
            await mutateChat(
              owner,
              { type: 'invite', conversationId, emails: [account.email!] },
              two,
            );
            assert.equal(
              Number(
                (
                  await admin`select count(*)::int as count from relay.invites where conversation_id=${conversationId}`
                )[0].count,
              ),
              1,
            );
          } finally {
            clearTimeout(timer);
            release();
            await outcome;
          }
          const first = await reading;
          assert.equal(first.user.email, account.email);
          assert.ok(first.conversations.length <= 1);
          if (first.conversations.length) assert.equal(first.conversations[0].id, conversationId);
          const next = await getChat(account, one);
          assert.equal(next.conversations[0].id, conversationId);
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.invites where conversation_id=${conversationId}`
              )[0].count,
            ),
            0,
          );
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.participants where user_id=${account.id} and conversation_id=${conversationId}`
              )[0].count,
            ),
            1,
          );
          completed.push(
            'invitation committed after negative EXISTS is claimed exactly once by resumed or next request',
          );
        },
      );
      await t.test(
        'two native sessions racing a send and an action UUID commit one message, one receipt and one event fanout',
        async () => {
          const { owner, peer, conversationId } = await pair('identical-races');
          const clientMessageId = crypto.randomUUID(),
            payload = {
              type: 'send',
              conversationId,
              text: 'Concurrent native send',
              clientMessageId,
            };
          const lock = await advisoryBarrier(blocker, observer, `relay-send:${clientMessageId}`);
          const sends = [mutateChat(owner, payload, one), mutateChat(owner, payload, two)];
          try {
            await lock.waitForBlocked([pids[1], pids[2]]);
          } finally {
            await lock.release();
          }
          const results = await Promise.all(sends);
          assert.deepEqual(
            results.map((result) => result.id),
            [clientMessageId, clientMessageId],
          );
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.messages where id=${clientMessageId}`
              )[0].count,
            ),
            1,
          );
          assert.equal(await eventCount(admin, conversationId), 2);
          await assert.rejects(mutateChat(peer, payload, two), failure(409));
          await assert.rejects(
            mutateChat(owner, { ...payload, text: 'Changed intent' }, one),
            failure(409),
          );
          await admin`delete from relay.events where conversation_id=${conversationId}`;
          const clientActionId = crypto.randomUUID(),
            action = {
              type: 'star',
              messageId: clientMessageId,
              starred: true,
              clientActionId,
              clientActionCreatedAt: new Date().toISOString(),
            };
          const actionLock = await advisoryBarrier(
            blocker,
            observer,
            `relay-action:${clientActionId}`,
          );
          const actions = [mutateChat(owner, action, one), mutateChat(owner, action, two)];
          try {
            await actionLock.waitForBlocked([pids[1], pids[2]]);
          } finally {
            await actionLock.release();
          }
          const changed = await Promise.all(actions);
          assert.ok(changed.every((result) => result.actionId === clientActionId));
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.operations where id=${clientActionId}`
              )[0].count,
            ),
            1,
          );
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.stars where message_id=${clientMessageId}`
              )[0].count,
            ),
            1,
          );
          assert.equal(
            await eventCount(admin, conversationId),
            1,
            'a personal star emits once for its owner',
          );
          await assert.rejects(mutateChat(owner, { ...action, starred: false }, two), failure(409));
          completed.push('locked concurrent send/action UUID races');
        },
      );
      await t.test(
        'different members competing for the last invitation slot cannot exceed thirty people',
        async () => {
          const { owner, peer, conversationId } = await pair('last-slot');
          await mutateChat(
            owner,
            {
              type: 'invite',
              conversationId,
              emails: Array.from({ length: 27 }, (_, n) => `waiting-${n}@native-test.invalid`),
            },
            admin,
          );
          await admin`delete from relay.events where conversation_id=${conversationId}`;
          let release!: () => void, entered!: () => void;
          const ready = new Promise<void>((resolve) => {
              entered = resolve;
            }),
            gate = new Promise<void>((resolve) => {
              release = resolve;
            });
          const held = blocker.begin(async (tx) => {
            await tx`select id from relay.conversations where id=${conversationId} for update`;
            entered();
            await gate;
          });
          await ready;
          const invites = [
            mutateChat(
              owner,
              { type: 'invite', conversationId, emails: ['last-a@native-test.invalid'] },
              one,
            ),
            mutateChat(
              peer,
              { type: 'invite', conversationId, emails: ['last-b@native-test.invalid'] },
              two,
            ),
          ];
          try {
            await until(
              async () =>
                Number(
                  (
                    await observer`select count(*)::int as count from pg_stat_activity where pid=any(${[pids[1], pids[2]]}::int[]) and cardinality(pg_blocking_pids(pid))>0`
                  )[0].count,
                ) === 2,
              'both identified invitation transactions',
            );
          } finally {
            release();
            await held;
          }
          const results = await Promise.allSettled(invites);
          assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
          const rejected = results.find(
            (result) => result.status === 'rejected',
          ) as PromiseRejectedResult;
          assert.ok(
            rejected.reason instanceof ChatError && /up to 30 people/.test(rejected.reason.message),
            `expected membership-cap rejection; got ${rejected.reason?.name} (${rejected.reason?.code ?? rejected.reason?.status ?? 'no code'}): ${rejected.reason?.message}`,
          );
          const slots =
            await admin`select (select count(*) from relay.participants where conversation_id=${conversationId})+(select count(*) from relay.invites where conversation_id=${conversationId}) as count`;
          assert.equal(Number(slots[0].count), 30);
          assert.equal(
            await eventCount(admin, conversationId),
            2,
            'one successful invitation fans out to the two current accounts',
          );
          completed.push('last membership slot across different accounts');
        },
      );
      await t.test(
        'rare verified-email changes retry only a definite native deadlock and remain correct',
        async () => {
          for (let round = 0; round < 3; round++) {
            const { owner, peer, conversationId } = await pair(`email-change-race-${round}`);
            const updatedOwner = { ...owner, email: `updated-owner-${round}@native-test.invalid` },
              updatedPeer = { ...peer, email: `updated-peer-${round}@native-test.invalid` };
            let deadlocks = 0,
              attempts = 0,
              arrived = 0;
            let release!: () => void, entered!: () => void;
            const ready = new Promise<void>((resolve) => {
              entered = resolve;
            });
            const gate = new Promise<void>((resolve) => {
              release = resolve;
            });
            // The identity sync now commits before event fanout, so the former
            // email/event deadlock is absent. A test-only opposing row lock inside
            // those real identity transactions forces an actual native40P01 and
            // proves the production retry path without mocking a driver error.
            const observed = (connection: postgres.Sql, ownId: string, peerId: string) => {
              let gated = false;
              return new Proxy(connection, {
                get(target, property) {
                  if (property === 'begin')
                    return async (work: (tx: postgres.TransactionSql) => Promise<unknown>) => {
                      attempts++;
                      try {
                        return await target.begin((tx) =>
                          work(
                            new Proxy(tx, {
                              apply: async (tag, receiver, argumentsList) => {
                                const rows = await Reflect.apply(tag, receiver, argumentsList);
                                const parts = argumentsList[0] as TemplateStringsArray;
                                if (
                                  !gated &&
                                  Array.isArray(parts) &&
                                  parts.join('').includes('update relay.profiles set email=') &&
                                  argumentsList.includes(ownId)
                                ) {
                                  gated = true;
                                  if (++arrived === 2) entered();
                                  await gate;
                                  await tx`select id from relay.profiles where id=${peerId} for key share`;
                                }
                                return rows;
                              },
                            }),
                          ),
                        );
                      } catch (error) {
                        if (
                          error &&
                          typeof error === 'object' &&
                          'code' in error &&
                          error.code === '40P01'
                        )
                          deadlocks++;
                        throw error;
                      }
                    };
                  return Reflect.get(target, property);
                },
              });
            };
            const actionA = crypto.randomUUID(),
              actionB = crypto.randomUUID(),
              stamp = new Date().toISOString();
            const invitations = [
              mutateChat(
                updatedOwner,
                {
                  type: 'invite',
                  conversationId,
                  emails: ['after-change-a@native-test.invalid'],
                  clientActionId: actionA,
                  clientActionCreatedAt: stamp,
                },
                observed(one, owner.id, peer.id),
              ),
              mutateChat(
                updatedPeer,
                {
                  type: 'invite',
                  conversationId,
                  emails: ['after-change-b@native-test.invalid'],
                  clientActionId: actionB,
                  clientActionCreatedAt: stamp,
                },
                observed(two, peer.id, owner.id),
              ),
            ];
            const settled = Promise.allSettled(invitations);
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                ready,
                settled.then(() => {
                  throw new Error(
                    'Identity operations settled before both row locks were acquired.',
                  );
                }),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error('Identity row gate timed out.')),
                    10000,
                  );
                }),
              ]);
            } finally {
              clearTimeout(timer);
              release();
              await settled;
            }
            const results = await Promise.all(invitations);
            assert.ok(
              deadlocks >= 1,
              'actual PostgreSQL generated a deadlock victim, not a mocked exception',
            );
            assert.ok(
              attempts >= 7 && attempts <= 10,
              'identity synchronization and only definite deadlock rollback trigger bounded transaction attempts',
            );
            assert.deepEqual(
              results.map((result) => result.actionId),
              [actionA, actionB],
            );
            assert.equal((await getChat(updatedOwner, admin)).user.email, updatedOwner.email);
            assert.equal((await getChat(updatedPeer, admin)).user.email, updatedPeer.email);
            assert.equal(
              Number(
                (
                  await admin`select count(*)::int as count from relay.invites where conversation_id=${conversationId}`
                )[0].count,
              ),
              2,
            );
            assert.equal(
              Number(
                (
                  await admin`select count(*)::int as count from relay.operations where id=any(${[actionA, actionB]}::uuid[])`
                )[0].count,
              ),
              2,
            );
            assert.equal(
              await eventCount(admin, conversationId),
              4,
              'two successful distinct changes; aborted attempt has no events or receipt',
            );
          }
          completed.push('rare verified-email changes with observed native40P01 retry');
        },
      );
      await t.test(
        'native commit barriers prove leave-winning and send-winning membership/media order',
        async () => {
          const left = await pair('leave-first');
          const oldFile = chunk(left.conversationId);
          await stageUpload(left.owner, oldFile, admin);
          await mutateChat(
            left.owner,
            {
              type: 'send',
              conversationId: left.conversationId,
              clientMessageId: oldFile.clientMessageId,
              text: 'Existing file',
              attachments: [
                {
                  name: oldFile.name,
                  type: oldFile.type,
                  size: oldFile.size,
                  url: `upload:${oldFile.clientMessageId}:0`,
                },
              ],
            },
            admin,
          );
          await admin`delete from relay.events where conversation_id=${left.conversationId}`;
          let release!: () => void, entered!: () => void;
          const ready = new Promise<void>((resolve) => {
              entered = resolve;
            }),
            gate = new Promise<void>((resolve) => {
              release = resolve;
            });
          // Run the real leave work on a real native transaction, then pause just
          // before commit. The sender must wait on its uncommitted membership delete.
          const heldLeaveConnection = new Proxy(one, {
            get(target, property) {
              if (property === 'begin')
                return (work: (tx: postgres.TransactionSql) => Promise<unknown>) =>
                  target.begin(async (tx) => {
                    const result = await work(tx);
                    entered();
                    await gate;
                    return result;
                  });
              return Reflect.get(target, property);
            },
          });
          const leaving = mutateChat(
            left.peer,
            { type: 'leave', conversationId: left.conversationId },
            heldLeaveConnection,
          );
          let sendingOutcome:
            Promise<PromiseSettledResult<Awaited<ReturnType<typeof mutateChat>>>> | undefined;
          const racedMessageId = crypto.randomUUID();
          let readinessTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              ready,
              leaving.then(() => {
                throw new Error('Leave committed before its barrier.');
              }),
              new Promise<never>((_, reject) => {
                readinessTimer = setTimeout(
                  () => reject(new Error('Leave commit-barrier readiness timed out.')),
                  10000,
                );
              }),
            ]);
            const sending = mutateChat(
              left.peer,
              {
                type: 'send',
                conversationId: left.conversationId,
                text: 'Racing leave',
                clientMessageId: racedMessageId,
              },
              two,
            );
            sendingOutcome = Promise.allSettled([sending]).then((results) => results[0]);
            await until(
              async () =>
                Number(
                  (
                    await observer`select count(*)::int as count from pg_stat_activity where pid=${pids[2]} and pg_blocking_pids(pid) @> ${[pids[1]]}::int[]`
                  )[0].count,
                ) === 1,
              'sender waiting on the identified leave transaction',
            );
            assert.deepEqual(
              (await getAttachment(left.peer, oldFile.clientMessageId, 0, admin)).bytes,
              Buffer.from('native file'),
              'an MVCC read before leave commits is currently authorized',
            );
          } finally {
            if (readinessTimer) clearTimeout(readinessTimer);
            release();
            await leaving.catch(() => {});
          }
          await leaving;
          const outcome = await sendingOutcome!;
          assert.equal(outcome.status, 'rejected');
          if (outcome.status === 'rejected')
            assert.ok(
              failure(404)(outcome.reason),
              'the committed leave rejects the blocked sender',
            );
          await assert.rejects(
            getAttachment(left.peer, oldFile.clientMessageId, 0, admin),
            failure(404),
          );
          assert.equal((await getChat(left.peer, admin)).conversations.length, 0);
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.messages where conversation_id=${left.conversationId}`
              )[0].count,
            ),
            1,
          );
          assert.equal(
            await eventCount(admin, left.conversationId),
            1,
            'no message invalidation is emitted by a rejected send',
          );
          await assert.rejects(
            mutateChat(
              left.peer,
              {
                type: 'send',
                conversationId: left.conversationId,
                text: 'After completed leave',
                clientMessageId: crypto.randomUUID(),
              },
              two,
            ),
            failure(404),
          );
          assert.equal((await getChat(left.peer, admin)).messages.length, 0);
          const first = await pair('send-first'),
            clientMessageId = crypto.randomUUID(),
            clientActionId = crypto.randomUUID();
          const lock = await advisoryBarrier(blocker, observer, `relay-action:${clientActionId}`);
          const leave = mutateChat(
            first.peer,
            {
              type: 'leave',
              conversationId: first.conversationId,
              clientActionId,
              clientActionCreatedAt: new Date().toISOString(),
            },
            two,
          );
          try {
            await lock.waitForBlocked([pids[2]]);
            await mutateChat(
              first.peer,
              {
                type: 'send',
                conversationId: first.conversationId,
                clientMessageId,
                text: 'Commits before leave',
              },
              one,
            );
          } finally {
            await lock.release();
          }
          await leave;
          assert.equal(
            (await getChat(first.owner, admin)).messages.find(
              (message) => message.id === clientMessageId,
            )?.text,
            'Commits before leave',
          );
          assert.equal((await getChat(first.peer, admin)).messages.length, 0);
          assert.equal(
            await eventCount(admin, first.conversationId),
            3,
            'two send events plus one post-leave event',
          );
          completed.push('leave/send/media transaction order');
        },
      );
      await t.test(
        'staging quota and immutable chunks survive competing sessions and final send consumes once',
        async () => {
          const { owner, peer, conversationId } = await pair('upload-races');
          for (let i = 0; i < 5; i++) await stageUpload(owner, chunk(conversationId), admin);
          const a = chunk(conversationId),
            b = chunk(conversationId);
          const lock = await advisoryBarrier(blocker, observer, `relay-upload-owner:${owner.id}`);
          const uploads = [stageUpload(owner, a, one), stageUpload(owner, b, two)];
          const settled = Promise.allSettled(uploads);
          try {
            await lock.waitForBlocked([pids[1], pids[2]]);
          } finally {
            await lock.release();
          }
          const results = await settled;
          assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
          const rejection = results.find(
            (result) => result.status === 'rejected',
          ) as PromiseRejectedResult;
          assert.ok(failure(429)(rejection.reason));
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.uploads where owner_id=${owner.id}`
              )[0].count,
            ),
            6,
          );
          assert.equal(await eventCount(admin, conversationId), 0);
          await admin`delete from relay.uploads where owner_id=${owner.id}`;
          const file = chunk(conversationId);
          const identical = await Promise.all([
            stageUpload(owner, file, one),
            stageUpload(owner, file, two),
          ]);
          assert.ok(identical.every((result) => result.ok));
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.uploads where message_id=${file.clientMessageId}`
              )[0].count,
            ),
            1,
          );
          await assert.rejects(
            stageUpload(
              owner,
              { ...file, data: Buffer.from('changed txt').toString('base64') },
              two,
            ),
            failure(409),
          );
          await assert.rejects(stageUpload(peer, file, two), failure(409));
          const message = {
            type: 'send',
            conversationId,
            text: 'Native upload',
            clientMessageId: file.clientMessageId,
            attachments: [
              {
                name: file.name,
                type: file.type,
                size: file.size,
                url: `upload:${file.clientMessageId}:0`,
              },
            ],
          };
          const final = await Promise.all([
            mutateChat(owner, message, one),
            mutateChat(owner, message, two),
          ]);
          assert.ok(final.every((result) => result.id === file.clientMessageId));
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.uploads where message_id=${file.clientMessageId}`
              )[0].count,
            ),
            0,
          );
          assert.deepEqual(
            (await getAttachment(peer, file.clientMessageId, 0, admin)).bytes,
            Buffer.from('native file'),
          );
          assert.equal(await eventCount(admin, conversationId), 2);
          await stageUpload(owner, file, one);
          assert.equal(
            Number(
              (
                await admin`select count(*)::int as count from relay.uploads where message_id=${file.clientMessageId}`
              )[0].count,
            ),
            0,
            'retry after commit compares existing bytes without recreating staging',
          );
          completed.push('staging quota/chunk identity/finalization races');
        },
      );
      await t.test('the last request-quota slot is atomic across native sessions', async () => {
        const account = fixtureUser('quota');
        await admin`insert into relay.request_limits(owner_id,bucket,window_start,requests) values(${account.id},'write',date_trunc('minute',now()),119)`;
        const results = await Promise.allSettled([
          enforceRequestLimit(account, 'write', one),
          enforceRequestLimit(account, 'write', two),
        ]);
        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
        assert.ok(
          failure(429)(
            (results.find((result) => result.status === 'rejected') as PromiseRejectedResult)
              .reason,
          ),
        );
        assert.equal(
          Number(
            (
              await admin`select requests from relay.request_limits where owner_id=${account.id} and bucket='write'`
            )[0].requests,
          ),
          120,
        );
        completed.push('atomic request quota boundary');
      });
      const sourceHashes = Object.fromEntries(
        await Promise.all(
          [
            'src/lib/server.ts',
            'src/lib/database-tls.ts',
            'scripts/verify-database.ts',
            'tests/native-database.test.ts',
            'tests/helpers/native-postgres.ts',
          ].map(async (path) => [
            path,
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex'),
          ]),
        ),
      );
      await fixture.close();
      await recordNativeEvidence('native-database', {
        scope:
          'Fresh disposable native PostgreSQL, actual production SQL functions, five verified TLS driver connections; excludes browser, real provider, production network and managed platform.',
        version,
        schemaVersion: 6,
        distinctConnections: pids.length,
        cases: completed,
        passed: completed.length === 9,
        sourceHashes,
        durationMs: Date.now() - started,
        cleanup: 'cluster stopped and temporary directory removed successfully',
      });
    } finally {
      await fixture.close();
    }
  },
);
