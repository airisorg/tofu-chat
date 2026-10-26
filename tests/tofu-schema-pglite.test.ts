import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type postgres from 'postgres';
import { applyBuildSchema } from '../scripts/tofu-schema';
import { sqlAdapter } from './helpers/pglite-sql';

test('schema step applies the app schema once, records version 6 and is safe to repeat', async () => {
  const pg = new PGlite(),
    sql = sqlAdapter(pg, (callback) => pg.transaction((tx) => callback(tx)));
  let connections = 0,
    closed = 0;
  const factory = (() => {
    connections++;
    return Object.assign(sql, {
      end: async () => {
        closed++;
      },
    });
  }) as unknown as typeof postgres;
  try {
    const environment = { DATABASE_URL: 'postgres://synthetic_fixture@127.0.0.1:5432/example' };
    assert.equal(await applyBuildSchema(environment, factory), 6);
    await pg.query(
      "insert into relay.profiles(id,email,name) values('kept','kept@test.invalid','Kept')",
    );
    assert.equal(await applyBuildSchema(environment, factory), 6);
    assert.deepEqual([connections, closed], [2, 2]);
    const tables = await pg.query<{ relname: string; relrowsecurity: boolean }>(
      "select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='relay' and c.relkind='r' order by c.relname",
    );
    assert.equal(tables.rows.length, 12);
    assert.ok(tables.rows.every((table) => table.relrowsecurity));
    assert.deepEqual((await pg.query('select version from relay.schema_migrations')).rows, [
      { version: 6 },
    ]);
    assert.deepEqual((await pg.query('select id from relay.profiles')).rows, [{ id: 'kept' }]);
  } finally {
    await pg.close();
  }
});
