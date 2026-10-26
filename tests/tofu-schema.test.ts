import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { rootCertificates } from 'node:tls';
import { test } from 'node:test';
import type postgres from 'postgres';
import { applyBuildSchema } from '../scripts/tofu-schema';

const local = 'postgres://synthetic_fixture@127.0.0.1:5432/example';
const remote = 'postgres://synthetic_fixture@pooler.db.example.invalid:6543/example';
// Two public roots from Node's own store stand in for a database's CA; neither is a secret.
const [hostCa, operatorCa] = rootCertificates.map((pem) => pem.trim() + '\n');
const FAILURE =
  'Chat schema setup failed. Deployment stopped; check the database connection settings.';

type FakeBehavior = {
  connectError?: boolean;
  schemaError?: boolean;
  readError?: boolean;
  hangConnect?: boolean;
  hangSchema?: boolean;
  hangClose?: boolean;
  closeError?: boolean;
  schemaDelay?: number;
  version?: unknown;
};
function fakeDatabase(behavior: FakeBehavior = {}) {
  const order: string[] = [],
    reads: string[] = [];
  let options: Record<string, unknown> | undefined,
    connections = 0;
  const never = () => new Promise<never>(() => {});
  const factory = ((_url: string, settings: Record<string, unknown>) => {
    options = settings;
    connections++;
    // The tag reads the recorded version; begin stands in for the schema transaction.
    const tag = async (strings: TemplateStringsArray) => {
      order.push('read');
      reads.push(strings.join('?'));
      if (behavior.readError) throw new Error('synthetic-sensitive-driver-value');
      return [{ version: 'version' in behavior ? behavior.version : 6 }];
    };
    return Object.assign(tag, {
      async begin(work: unknown) {
        assert.equal(typeof work, 'function');
        order.push('connect');
        if (behavior.connectError) throw new Error('synthetic-sensitive-driver-value');
        if (behavior.hangConnect) return never();
        (settings.debug as () => void)();
        order.push('schema');
        if (behavior.schemaError) throw new Error('synthetic-sensitive-driver-value');
        if (behavior.hangSchema) return never();
        if (behavior.schemaDelay)
          await new Promise((resolve) => setTimeout(resolve, behavior.schemaDelay));
      },
      async end(settings: { timeout: number }) {
        order.push('end');
        assert.equal(settings.timeout, 2);
        if (behavior.closeError) throw new Error('synthetic-sensitive-cleanup-value');
        if (behavior.hangClose) return never();
      },
    });
  }) as unknown as typeof postgres;
  return { factory, order, reads, options: () => options, connections: () => connections };
}

// The driver's own text (here 'synthetic-sensitive-…') never reaches the message.
const sanitized = (error: unknown) => error instanceof Error && error.message === FAILURE;

test('schema step skips only a local build and refuses known hosted deployments', async () => {
  const fake = fakeDatabase();
  assert.equal(await applyBuildSchema({}, fake.factory), 'skipped');
  assert.equal(await applyBuildSchema({ DATABASE_URL: '  ' }, fake.factory), 'skipped');
  for (const marker of [{ VERCEL: '1' }, { VERCEL_ENV: 'production' }, { VERCEL_ENV: 'preview' }])
    await assert.rejects(
      applyBuildSchema(marker, fake.factory),
      (error) =>
        error instanceof Error &&
        error.message ===
          'Hosted deployment requires the chat schema step; DATABASE_URL is missing.',
    );
  assert.equal(fake.connections(), 0);
  assert.deepEqual(fake.order, []);
});

test('schema step uses one strict-TLS connection, applies the schema, reads its version and closes', async () => {
  const fake = fakeDatabase();
  assert.equal(await applyBuildSchema({ DATABASE_URL: local }, fake.factory), 6);
  assert.equal(fake.connections(), 1);
  assert.deepEqual(fake.order, ['connect', 'schema', 'read', 'end']);
  assert.deepEqual(fake.reads, ['select max(version) as version from relay.schema_migrations']);
  const options = fake.options()!;
  assert.deepEqual(
    options.ssl,
    { rejectUnauthorized: true },
    'NODE_ENV absence never skips verification for configured builds',
  );
  assert.equal(options.max, 1);
  assert.equal(options.prepare, false, 'transaction pooler: no prepared statements');
  assert.equal(options.fetch_types, false);
  assert.equal(options.connect_timeout, 15);
});

test('schema step trusts the CA the host provides, and an operator CA over it', async () => {
  for (const [environment, expected] of [
    [{ SUPABASE_CA_CERT: hostCa }, hostCa],
    [{ SUPABASE_CA_CERT: hostCa, DATABASE_CA_CERT: operatorCa }, operatorCa],
  ] as const) {
    const fake = fakeDatabase();
    assert.equal(await applyBuildSchema({ DATABASE_URL: remote, ...environment }, fake.factory), 6);
    const ssl = fake.options()!.ssl as { ca: string[]; rejectUnauthorized: boolean };
    assert.equal(ssl.rejectUnauthorized, true);
    assert.equal(ssl.ca.at(-1), expected);
  }
  const invalid = fakeDatabase();
  await assert.rejects(
    applyBuildSchema(
      { DATABASE_URL: remote, SUPABASE_CA_CERT: 'synthetic-sensitive-value' },
      invalid.factory,
    ),
    sanitized,
  );
  assert.equal(invalid.connections(), 0, 'an invalid CA never opens a connection');
});

test('schema step failures stop the build with a sanitized message and still close', async () => {
  for (const behavior of [
    { connectError: true },
    { schemaError: true },
    { readError: true },
    { version: null },
    { version: 0 },
  ]) {
    const fake = fakeDatabase(behavior);
    await assert.rejects(applyBuildSchema({ DATABASE_URL: local }, fake.factory), sanitized);
    assert.equal(fake.order.at(-1), 'end');
  }
  await assert.rejects(
    applyBuildSchema(
      { DATABASE_URL: 'https://synthetic.test.invalid/path' },
      fakeDatabase().factory,
    ),
    sanitized,
  );
});

test('schema step keeps both sanitized reasons when cleanup fails too', async () => {
  await assert.rejects(
    applyBuildSchema(
      { DATABASE_URL: local },
      fakeDatabase({ schemaError: true, closeError: true }).factory,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, 'Chat schema setup and cleanup failed. Deployment stopped.');
      assert.deepEqual(
        error.errors.map((entry: Error) => entry.message),
        [FAILURE, 'Chat schema connection cleanup failed. Deployment stopped.'],
      );
      return true;
    },
  );
  await assert.rejects(
    applyBuildSchema({ DATABASE_URL: local }, fakeDatabase({ closeError: true }).factory),
    /^Error: Chat schema connection cleanup failed\. Deployment stopped\.$/,
  );
});

test('schema step connect/schema/cleanup deadlines are bounded and stop the build', async () => {
  for (const behavior of [{ hangConnect: true }, { hangSchema: true }, { hangClose: true }]) {
    const fake = fakeDatabase(behavior);
    await assert.rejects(
      applyBuildSchema({ DATABASE_URL: local }, fake.factory, {
        connect: 15,
        schema: 15,
        close: 15,
      }),
      /Deployment stopped/,
    );
    assert.equal(fake.order.at(-1), 'end');
  }
});

test('schema step lifts the connect deadline once the connection answers', async () => {
  // The schema outlasts the connect limit but not the schema limit, so only a lifted connect
  // timer lets it finish.
  const fake = fakeDatabase({ schemaDelay: 60 });
  assert.equal(
    await applyBuildSchema({ DATABASE_URL: local }, fake.factory, {
      connect: 20,
      schema: 1_000,
      close: 100,
    }),
    6,
  );
  assert.deepEqual(fake.order, ['connect', 'schema', 'read', 'end']);
});

async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('No loopback port allocated.');
  return address.port;
}

test('actual schema CLI skips a local build, refuses a hosted one, and prints no driver detail', async () => {
  // Preserve only the opt-in collector; never inherit provider/database configuration.
  const coverageEnv = process.env.CHAT_COVERAGE_RUN_ID
    ? Object.fromEntries(
        ['NODE_OPTIONS', 'CHAT_COVERAGE_RUN_ID', 'CHAT_ISTANBUL_DIR', 'CHAT_COVERAGE_LAYER']
          .filter((key) => process.env[key] !== undefined)
          .map((key) => [key, process.env[key]]),
      )
    : {};
  const run = (environment: Record<string, string>) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'scripts/tofu-schema.ts'], {
      env: { ...coverageEnv, NODE_ENV: 'test', ...environment },
      encoding: 'utf8',
      timeout: 15000,
    });
  const localRun = run({});
  assert.equal(localRun.status, 0);
  assert.equal(localRun.stdout, 'Chat schema step skipped: no local DATABASE_URL.\n');
  assert.equal(localRun.stderr, '');
  const hostedRun = run({ VERCEL: '1' });
  assert.equal(hostedRun.status, 1);
  assert.equal(hostedRun.stdout, '');
  assert.equal(
    hostedRun.stderr.trim(),
    'Hosted deployment requires the chat schema step; DATABASE_URL is missing.',
  );
  // Nothing listens on this loopback port: the connection is refused.
  const port = await closedLoopbackPort();
  const failedRun = run({
    DATABASE_URL: `postgres://synthetic_user:synthetic-sensitive-password@127.0.0.1:${port}/synthetic_db`,
  });
  assert.equal(failedRun.status, 1);
  assert.equal(failedRun.stdout, '');
  assert.equal(failedRun.stderr, FAILURE + '\n');
  assert.doesNotMatch(failedRun.stderr, /synthetic|127\.0\.0\.1|ECONNREFUSED/);
  assert.ok(!failedRun.stderr.includes(String(port)));
});
