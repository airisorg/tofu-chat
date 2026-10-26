import { X509Certificate } from 'node:crypto';
import * as tls from 'node:tls';

type Environment = Readonly<Record<string, string | undefined>>;
const MAX_CA_BYTES = 64 * 1024;

function configuredCa(raw: string): string {
  const invalid = () => new Error('The configured database CA must be valid PEM CA certificates.');
  if (Buffer.byteLength(raw) > MAX_CA_BYTES) throw invalid();
  const value = raw
    .replace(/\\r\\n/g, '\\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .trim();
  const certificates =
    value.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (
    !certificates.length ||
    value.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()
  )
    throw invalid();
  try {
    for (const certificate of certificates)
      if (!new X509Certificate(certificate).ca) throw invalid();
  } catch {
    throw invalid();
  }
  return certificates.join('\n') + '\n';
}

/** Explicit driver options outrank URL sslmode/PGSSL; never weaken peer or hostname checks. */
export function databaseTls(
  databaseUrl: string,
  environment: Environment = process.env,
): tls.ConnectionOptions | undefined {
  let hostname: string;
  try {
    const url = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
    hostname = url.hostname;
  } catch {
    throw new Error('The database connection settings are invalid.');
  }
  // DATABASE_CA_CERT is an operator override; SUPABASE_CA_CERT is the database's root that Tofu provides.
  const supplied = [environment.DATABASE_CA_CERT, environment.SUPABASE_CA_CERT].find((value) =>
    value?.trim(),
  );
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  if (environment.NODE_ENV !== 'production' && local && !supplied) return undefined;
  // Without a supplied CA, leave ca absent so Node's default store and NODE_EXTRA_CA_CERTS remain effective.
  if (!supplied) return { rejectUnauthorized: true };
  const roots =
    typeof tls.getCACertificates === 'function'
      ? tls.getCACertificates('default')
      : tls.rootCertificates;
  return {
    rejectUnauthorized: true,
    ca: [...roots, configuredCa(supplied)],
  };
}
