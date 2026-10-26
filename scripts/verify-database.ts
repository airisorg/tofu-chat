import { basename } from 'node:path';
import postgres from 'postgres';
import { databaseTls } from '../src/lib/database-tls';

const FAILURE =
  'Database TLS verification failed. Deployment stopped; check trusted certificate and connection settings.';
const DEFAULT_DEADLINES = { connect: 15_000, query: 5_000, close: 2_000 };

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

/** Read-only deployment gate. No credential/host/driver errors are printed or returned. */
export async function verifyDatabase(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  createClient: typeof postgres = postgres,
  limits = DEFAULT_DEADLINES,
): Promise<'verified' | 'skipped'> {
  const url = environment.DATABASE_URL?.trim();
  if (!url) {
    if (
      environment.VERCEL === '1' ||
      ['production', 'preview'].includes(environment.VERCEL_ENV ?? '')
    ) {
      throw new Error(
        'Hosted deployment requires database TLS verification; DATABASE_URL is missing.',
      );
    }
    return 'skipped';
  }
  let sql: ReturnType<typeof postgres> | undefined;
  let onQuery = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let verificationFailure: Error | undefined;
  let cleanupFailure: Error | undefined;
  try {
    sql = createClient(url, {
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
      // Called when this one query is built on the authenticated connection.
      // Do not print the callback's query/parameter arguments.
      debug: () => onQuery(),
    });
    const phaseDeadline = new Promise<never>((_, reject) => {
      const expire = () => reject(new Error(FAILURE));
      timer = setTimeout(expire, limits.connect);
      let started = false;
      onQuery = () => {
        if (started) return;
        started = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(expire, limits.query);
      };
    });
    // A direct query avoids the driver's cold reserve()+fetch_types:false
    // readiness path while keeping the probe to exactly one SELECT.
    const rows = await Promise.race([sql.unsafe('select 1 as verified'), phaseDeadline]);
    if (rows.length !== 1 || Number(rows[0]?.verified) !== 1) throw new Error(FAILURE);
  } catch {
    verificationFailure = new Error(FAILURE);
  } finally {
    try {
      if (timer) clearTimeout(timer);
      onQuery = () => {};
      if (sql) await deadline(sql.end({ timeout: 2 }), limits.close);
    } catch {
      cleanupFailure = new Error('Database verification cleanup failed. Deployment stopped.');
    }
  }
  // Preserve both sanitized failures; a finally throw would hide the reason
  // verification failed, while raw driver errors could expose credentials.
  if (verificationFailure && cleanupFailure)
    throw new AggregateError(
      [verificationFailure, cleanupFailure],
      'Database verification and cleanup failed. Deployment stopped.',
    );
  if (verificationFailure) throw verificationFailure;
  if (cleanupFailure) throw cleanupFailure;
  return 'verified';
}

if (basename(process.argv[1] ?? '') === 'verify-database.ts') {
  void verifyDatabase()
    .then((result) => {
      console.log(
        result === 'verified'
          ? 'Database TLS verification passed.'
          : 'Database TLS verification skipped: no local DATABASE_URL.',
      );
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
