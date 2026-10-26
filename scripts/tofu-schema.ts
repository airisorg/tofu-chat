// The build's schema step: applies the app's own idempotent schema (applySchema in
// src/lib/server.ts) before `next build`, so a new deployment's database has its relay tables,
// with row-level security and their grants, before anyone signs in. The server still applies the
// same schema on first authenticated use; applySchema's transaction advisory lock makes the build
// and any running instance take turns.
import { basename } from 'node:path';
import postgres from 'postgres';
import { databaseTls } from '../src/lib/database-tls';
import { applySchema } from '../src/lib/server';

const FAILURE =
  'Chat schema setup failed. Deployment stopped; check the database connection settings.';
const DEFAULT_DEADLINES = { connect: 15_000, schema: 60_000, close: 3_000 };

async function deadline<T>(work: PromiseLike<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(FAILURE)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One verified connection, the app's schema, its recorded version. No credential/host/driver errors are printed or returned. */
export async function applyBuildSchema(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  createClient: typeof postgres = postgres,
  limits = DEFAULT_DEADLINES,
): Promise<number | 'skipped'> {
  const url = environment.DATABASE_URL?.trim();
  if (!url) {
    if (
      environment.VERCEL === '1' ||
      ['production', 'preview'].includes(environment.VERCEL_ENV ?? '')
    ) {
      throw new Error('Hosted deployment requires the chat schema step; DATABASE_URL is missing.');
    }
    return 'skipped';
  }
  let sql: ReturnType<typeof postgres> | undefined;
  let onQuery = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let version = 0;
  let schemaFailure: Error | undefined;
  let cleanupFailure: Error | undefined;
  try {
    // The same TLS rules as scripts/verify-database.ts: production verification, the host's CA.
    const client = createClient(url, {
      ssl: databaseTls(url, {
        NODE_ENV: 'production',
        DATABASE_CA_CERT: environment.DATABASE_CA_CERT,
        SUPABASE_CA_CERT: environment.SUPABASE_CA_CERT,
      }),
      max: 1,
      prepare: false,
      fetch_types: false,
      connect_timeout: 15,
      idle_timeout: 0,
      onnotice: () => {},
      // Called when a query is built on the authenticated connection; the first (BEGIN) ends the
      // connect phase. Do not print the callback's query/parameter arguments.
      debug: () => onQuery(),
    });
    sql = client;
    const phaseDeadline = new Promise<never>((_, reject) => {
      const expire = () => reject(new Error(FAILURE));
      timer = setTimeout(expire, limits.connect);
      let started = false;
      onQuery = () => {
        if (started) return;
        started = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(expire, limits.schema);
      };
    });
    const work = (async () => {
      await applySchema(client);
      const rows = await client`select max(version) as version from relay.schema_migrations`;
      return Number(rows[0]?.version);
    })();
    version = await Promise.race([work, phaseDeadline]);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error(FAILURE);
  } catch {
    schemaFailure = new Error(FAILURE);
  } finally {
    try {
      if (timer) clearTimeout(timer);
      onQuery = () => {};
      if (sql) await deadline(sql.end({ timeout: 2 }), limits.close);
    } catch {
      cleanupFailure = new Error('Chat schema connection cleanup failed. Deployment stopped.');
    }
  }
  // Keep both sanitized failures; raw driver errors could expose credentials.
  if (schemaFailure && cleanupFailure)
    throw new AggregateError(
      [schemaFailure, cleanupFailure],
      'Chat schema setup and cleanup failed. Deployment stopped.',
    );
  if (schemaFailure) throw schemaFailure;
  if (cleanupFailure) throw cleanupFailure;
  return version;
}

if (basename(process.argv[1] ?? '') === 'tofu-schema.ts') {
  void applyBuildSchema()
    .then((result) => {
      console.log(
        result === 'skipped'
          ? 'Chat schema step skipped: no local DATABASE_URL.'
          : `Chat schema ready: version ${result}.`,
      );
    })
    .catch((error) => {
      // A timed-out connection is only half-closed; exit rather than wait for the peer to close it.
      process.stderr.write(`${error.message}\n`, () => process.exit(1));
    });
}
