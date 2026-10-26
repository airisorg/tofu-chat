import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createSecureContext, rootCertificates } from 'node:tls';
import { test } from 'node:test';
import postgres from 'postgres';
import { databaseTls } from '../src/lib/database-tls';
import { verifyDatabase } from '../scripts/verify-database';

const local = 'postgres://synthetic_fixture@127.0.0.1:5432/example';
const pooler = 'postgres://synthetic_fixture@aws-0-eu-west-1.pooler.supabase.com:6543/example';
const remote = 'postgres://synthetic_fixture@pooler.db.example.invalid:6543/example';
// Two public roots from Node's own store stand in for a database's CA; neither is a secret.
const [hostCa, operatorCa] = rootCertificates.map((pem) => pem.trim() + '\n');

test('production always verifies peers and retains the default hostname checker', () => {
  assert.deepEqual(databaseTls(local, { NODE_ENV: 'production' }), { rejectUnauthorized: true });
  assert.deepEqual(databaseTls('postgres://synthetic@other.database.test.invalid/example', {}), {
    rejectUnauthorized: true,
  });
  assert.equal(databaseTls(local, { NODE_ENV: 'development' }), undefined);
  assert.equal(databaseTls('postgres://synthetic@[::1]/example', { NODE_ENV: 'test' }), undefined);
});

test("without a supplied CA every host, Supabase included, uses only Node's default store", () => {
  for (const url of [pooler, remote, 'postgres://synthetic@db.abcdefghijklmnopqrst.supabase.co/x'])
    for (const blank of [{}, { DATABASE_CA_CERT: '', SUPABASE_CA_CERT: '  ' }])
      assert.deepEqual(databaseTls(url, { NODE_ENV: 'production', ...blank }), {
        rejectUnauthorized: true,
      });
});

test('the CA the host provides as SUPABASE_CA_CERT is trusted beside the default roots', () => {
  for (const url of [pooler, remote, local]) {
    const options = databaseTls(url, { NODE_ENV: 'production', SUPABASE_CA_CERT: hostCa })!;
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.checkServerIdentity, undefined);
    assert.equal(options.servername, undefined, 'driver uses the actual URL hostname');
    assert.ok(Array.isArray(options.ca));
    assert.equal(options.ca.at(-1), hostCa);
    assert.ok(options.ca.length > 1, 'default roots remain alongside the additional root');
    createSecureContext(options);
  }
});

test('DATABASE_CA_CERT wins over SUPABASE_CA_CERT, and an invalid winner is never skipped', () => {
  const options = databaseTls(remote, {
    NODE_ENV: 'production',
    DATABASE_CA_CERT: operatorCa,
    SUPABASE_CA_CERT: hostCa,
  })!;
  assert.ok(Array.isArray(options.ca));
  assert.equal(options.ca.at(-1), operatorCa);
  assert.throws(
    () =>
      databaseTls(remote, {
        NODE_ENV: 'production',
        DATABASE_CA_CERT: 'synthetic-sensitive-value',
        SUPABASE_CA_CERT: hostCa,
      }),
    /must be valid PEM CA certificates/,
  );
});

test('a supplied CA accepts actual and escaped PEM newlines without disabling hostname verification', () => {
  for (const name of ['DATABASE_CA_CERT', 'SUPABASE_CA_CERT'])
    for (const value of [
      hostCa,
      hostCa.replaceAll('\n', '\\n'),
      hostCa.replaceAll('\n', '\\r\\n'),
    ]) {
      const options = databaseTls(local, { NODE_ENV: 'production', [name]: value })!;
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.checkServerIdentity, undefined);
      assert.ok(Array.isArray(options.ca));
      assert.equal(options.ca.at(-1), hostCa);
      createSecureContext(options);
    }
});

test('invalid or oversized CA content fails without exposing operator input', () => {
  for (const name of ['DATABASE_CA_CERT', 'SUPABASE_CA_CERT'])
    for (const value of [
      'synthetic-sensitive-value',
      hostCa + '\nsynthetic-sensitive-value',
      hostCa + ' '.repeat(65536),
    ]) {
      assert.throws(
        () => databaseTls(local, { NODE_ENV: 'production', [name]: value }),
        (error) =>
          error instanceof Error &&
          error.message === 'The configured database CA must be valid PEM CA certificates.' &&
          !error.message.includes('synthetic-sensitive-value'),
      );
    }
  assert.throws(
    () => databaseTls('https://synthetic.test.invalid/path', {}),
    /connection settings are invalid/,
  );
});

test('explicit verification outranks insecure URL and PGSSL options in the installed driver', async () => {
  const previous = process.env.PGSSL;
  process.env.PGSSL = 'require';
  const clients: ReturnType<typeof postgres>[] = [];
  try {
    for (const mode of ['require', 'disable', 'prefer']) {
      const url = pooler + '?sslmode=' + mode;
      const options = databaseTls(url, { NODE_ENV: 'production' })!;
      const client = postgres(url, { ssl: options, max: 1, prepare: false });
      clients.push(client);
      assert.equal(typeof client.options.ssl, 'object');
      assert.equal(
        (client.options.ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized,
        true,
      );
      assert.deepEqual(client.options.ssl, options);
    }
  } finally {
    if (previous === undefined) delete process.env.PGSSL;
    else process.env.PGSSL = previous;
    await Promise.all(clients.map((client) => client.end({ timeout: 0 })));
  }
  // Lazy driver construction performed no connection/query.
});

type FakeBehavior = {
  connectError?: boolean;
  queryError?: boolean;
  hangConnect?: boolean;
  hangQuery?: boolean;
  hangClose?: boolean;
  verified?: number;
};
function fakeProbe(behavior: FakeBehavior = {}) {
  const order: string[] = [],
    queries: string[] = [];
  let options: Record<string, unknown> | undefined;
  const never = () => new Promise<never>(() => {});
  const factory = ((_url: string, settings: Record<string, unknown>) => {
    options = settings;
    return {
      async unsafe(query: string) {
        order.push('connect');
        if (behavior.connectError) throw new Error('synthetic-sensitive-driver-value');
        if (behavior.hangConnect) return never();
        (settings.debug as () => void)();
        order.push('query');
        queries.push(query);
        if (behavior.queryError) throw new Error('synthetic-sensitive-driver-value');
        if (behavior.hangQuery) return never();
        return [{ verified: behavior.verified ?? 1 }];
      },
      async end(settings: { timeout: number }) {
        order.push('end');
        assert.equal(settings.timeout, 2);
        if (behavior.hangClose) return never();
      },
    };
  }) as unknown as typeof postgres;
  return { factory, order, queries, options: () => options };
}

test('build gate forces strict TLS, connects first, selects once and closes', async () => {
  const fake = fakeProbe();
  assert.equal(await verifyDatabase({ DATABASE_URL: local }, fake.factory), 'verified');
  assert.deepEqual(fake.order, ['connect', 'query', 'end']);
  assert.deepEqual(fake.queries, ['select 1 as verified']);
  assert.deepEqual(
    fake.options()!.ssl,
    { rejectUnauthorized: true },
    'NODE_ENV absence never skips verification for configured builds',
  );
  assert.equal(fake.options()!.fetch_types, false, 'no driver type-introspection query');
  assert.equal(fake.options()!.connect_timeout, 15);
});

test('build gate trusts the CA the host provides, and an operator CA over it', async () => {
  for (const [environment, expected] of [
    [{ SUPABASE_CA_CERT: hostCa }, hostCa],
    [{ SUPABASE_CA_CERT: hostCa, DATABASE_CA_CERT: operatorCa }, operatorCa],
  ] as const) {
    const fake = fakeProbe();
    assert.equal(
      await verifyDatabase({ DATABASE_URL: remote, ...environment }, fake.factory),
      'verified',
    );
    const ssl = fake.options()!.ssl as { ca: string[]; rejectUnauthorized: boolean };
    assert.equal(ssl.rejectUnauthorized, true);
    assert.equal(ssl.ca.at(-1), expected);
  }
});

test('missing URL skips only a local build and refuses known hosted deployments', async () => {
  const fake = fakeProbe();
  assert.equal(await verifyDatabase({}, fake.factory), 'skipped');
  for (const marker of [{ VERCEL: '1' }, { VERCEL_ENV: 'production' }, { VERCEL_ENV: 'preview' }]) {
    await assert.rejects(verifyDatabase(marker, fake.factory), /DATABASE_URL is missing/);
  }
  assert.deepEqual(fake.order, []);
});

test('build gate fails and closes on certificate/auth/query/result errors without raw diagnostics', async () => {
  for (const behavior of [{ connectError: true }, { queryError: true }, { verified: 0 }]) {
    const fake = fakeProbe(behavior);
    await assert.rejects(
      verifyDatabase({ DATABASE_URL: local }, fake.factory),
      (error) =>
        error instanceof Error &&
        error.message.startsWith('Database TLS verification failed.') &&
        !error.message.includes('synthetic-sensitive-driver-value'),
    );
    assert.equal(fake.order.at(-1), 'end');
  }
});

test('build connect/query/cleanup deadlines are bounded and fail publication', async () => {
  for (const behavior of [{ hangConnect: true }, { hangQuery: true }, { hangClose: true }]) {
    const fake = fakeProbe(behavior);
    await assert.rejects(
      verifyDatabase({ DATABASE_URL: local }, fake.factory, { connect: 15, query: 15, close: 15 }),
      /Deployment stopped/,
    );
    assert.equal(fake.order.at(-1), 'end');
  }
});

test('actual verification CLI skips an unconfigured local environment and fails a hosted one without a stack', () => {
  // Preserve only the opt-in collector; never inherit provider/database configuration.
  const coverageEnv = process.env.CHAT_COVERAGE_RUN_ID
    ? Object.fromEntries(
        ['NODE_OPTIONS', 'CHAT_COVERAGE_RUN_ID', 'CHAT_ISTANBUL_DIR', 'CHAT_COVERAGE_LAYER']
          .filter((key) => process.env[key] !== undefined)
          .map((key) => [key, process.env[key]]),
      )
    : {};
  const localRun = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/verify-database.ts'], {
    env: { ...coverageEnv, NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(localRun.status, 0);
  assert.match(localRun.stdout, /skipped: no local DATABASE_URL/);
  assert.equal(localRun.stderr, '');
  const hostedRun = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/verify-database.ts'], {
    env: { ...coverageEnv, NODE_ENV: 'test', VERCEL: '1' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(hostedRun.status, 1);
  assert.equal(hostedRun.stdout, '');
  assert.equal(
    hostedRun.stderr.trim(),
    'Hosted deployment requires database TLS verification; DATABASE_URL is missing.',
  );
});
