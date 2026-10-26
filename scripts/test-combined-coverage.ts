import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createServer } from 'node:net';
import { captureBinding, bindingChanges } from './test-browser-suites';
import { requireOwnedServerShutdown } from './coverage-server-lifecycle';
async function main() {
  const root = process.cwd(),
    output = resolve('test-results/combined-coverage'),
    require = createRequire(import.meta.url),
    tsx = require.resolve('tsx/cli'),
    next = require.resolve('next/dist/bin/next'),
    playwright = require.resolve('@playwright/test/cli');
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' };
  // Never inherit real database/auth keys into synthetic coverage processes.
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'USER',
    'LOGNAME',
    'LANG',
    'TERM',
    'CI',
    'PLAYWRIGHT_BROWSERS_PATH',
    'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
    'NO_COLOR',
    'FORCE_COLOR',
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  if (
    require('node:fs')
      .readdirSync(root)
      .some((name: string) => name.startsWith('.env') && name !== '.env.example')
  )
    throw new Error('Coverage fixtures require a checkout without dotenv provider configuration.');
  mkdirSync(output, { recursive: true });
  const before = captureBinding(root);
  delete before['next-env.d.ts'];
  function unchanged() {
    const after = captureBinding(root);
    delete after['next-env.d.ts'];
    const drift = bindingChanges(before, after);
    if (drift.length) throw new Error(`Coverage run source/test drift: ${drift.join(', ')}`);
  }
  function run(
    name: string,
    args: string[],
    cwd = root,
    extra: Record<string, string | undefined> = {},
  ) {
    console.log(`Coverage stage: ${name}`);
    const result = spawnSync(process.execPath, args, {
      cwd,
      env: { ...env, ...extra },
      stdio: 'inherit',
    });
    if (result.status !== 0) throw new Error(`${name} failed with status ${result.status}.`);
    unchanged();
    return result.status;
  }
  run('prepare original-source inventory', [tsx, 'scripts/prepare-combined-coverage.ts']);
  const manifest = JSON.parse(readFileSync(resolve(output, 'manifest.json'), 'utf8')) as {
    runId: string;
  };
  const collect = {
    CHAT_COVERAGE_RUN_ID: manifest.runId,
    CHAT_ISTANBUL_DIR: resolve(output, 'raw'),
    NODE_OPTIONS: `--require=${JSON.stringify(resolve('scripts/capture-node-coverage.cjs'))}`,
  };
  const execution: {
    runId: string;
    node: { exitCode: number };
    browser?: { exitCode: number; tests: number; testIds: string[] };
    server?: { exitCode: number; processExitCode: number | null; signal: string | null };
    scope: string;
    before: Record<string, string>;
    after?: Record<string, string>;
  } = {
    runId: manifest.runId,
    node: { exitCode: -1 },
    scope:
      'Node + real local browser + server execution only. Explicit --ignore-snapshots: reviewed pixels and ordinary production security/SW gates remain separate. No provider/database credentials inherited.',
    before,
  };
  try {
    execution.node.exitCode = run(
      'instrumented isolated Node assertions',
      [tsx, 'scripts/test-node.ts'],
      resolve(output, 'node-source'),
      { ...collect, CHAT_COVERAGE_LAYER: 'node', NODE_ENV: 'test' },
    );
    run(
      'local instrumented read-only database build check',
      [tsx, 'scripts/verify-database.ts'],
      resolve(output, 'node-source'),
      { ...collect, CHAT_COVERAGE_LAYER: 'node', NODE_ENV: 'production' },
    );
    run(
      'local instrumented database schema build step',
      [tsx, 'scripts/tofu-schema.ts'],
      resolve(output, 'node-source'),
      { ...collect, CHAT_COVERAGE_LAYER: 'node', NODE_ENV: 'production' },
    );
    run('opt-in instrumented Webpack build', [next, 'build', '--webpack'], root, {
      CHAT_INSTRUMENT_COVERAGE: '1',
      NEXT_PUBLIC_ENABLE_DEMO: 'true',
    });
    const port = Number(process.env.CHAT_COVERAGE_PORT || 3113);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error('Invalid local coverage port.');
    await new Promise<void>((done, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () =>
        probe.close((error) => (error ? reject(error) : done())),
      );
    });
    const url = `http://127.0.0.1:${port}`,
      log = createWriteStream(resolve(output, 'server.log'));
    const server = spawn(
      process.execPath,
      [next, 'start', '--hostname', '127.0.0.1', '--port', String(port)],
      {
        cwd: root,
        env: { ...env, ...collect, CHAT_COVERAGE_LAYER: 'server', CHAT_INSTRUMENT_COVERAGE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    server.stdout.pipe(log, { end: false });
    server.stderr.pipe(log, { end: false });
    const exit = once(server, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
    let ready = false;
    let browserError: unknown;
    let cleanupError: unknown;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (server.exitCode !== null) throw new Error('Coverage server exited before readiness.');
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
          await response.arrayBuffer();
          if (response.status === 200) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((done) => setTimeout(done, 100));
      }
      if (!ready) throw new Error('Coverage server did not return200.');
      run(
        'unchanged browser behavior (portable execution; pixels separately)',
        [playwright, 'test', '--config', 'playwright.coverage.config.ts', '--ignore-snapshots'],
        root,
        {
          CHAT_COLLECT_COVERAGE: '1',
          CHAT_COVERAGE_RUN_ID: manifest.runId,
          CHAT_ISTANBUL_DIR: collect.CHAT_ISTANBUL_DIR,
          APP_URL: url,
        },
      );
      const results = JSON.parse(readFileSync(resolve(output, 'browser-results.json'), 'utf8')) as {
        stats: { expected: number; unexpected: number; flaky: number; skipped: number };
        suites: ReportSuite[];
      };
      type ReportSuite = { specs?: { id: string }[]; suites?: ReportSuite[] };
      const testIds = (suite: ReportSuite): string[] => [
        ...(suite.specs || []).map((spec) => spec.id),
        ...(suite.suites || []).flatMap(testIds),
      ];
      if (
        results.stats.unexpected ||
        results.stats.flaky ||
        results.stats.skipped ||
        !results.stats.expected
      )
        throw new Error(
          'Coverage browser acceptance requires every selected case to pass without skip/retry.',
        );
      execution.browser = {
        exitCode: 0,
        tests: results.stats.expected,
        testIds: results.suites.flatMap(testIds),
      };
    } catch (error) {
      browserError = error;
    }
    try {
      const requested =
        server.exitCode === null && server.signalCode === null && server.kill('SIGTERM');
      const result = await Promise.race([
        exit,
        new Promise<never>((_, reject) =>
          (cleanupTimer = setTimeout(() => {
            server.kill('SIGKILL');
            reject(new Error('Coverage server cleanup timed out.'));
          }, 10_000)).unref(),
        ),
      ]);
      requireOwnedServerShutdown(requested, result[0], result[1]);
      execution.server = { exitCode: ready ? 0 : 1, processExitCode: result[0], signal: result[1] };
    } catch (error) {
      cleanupError = error;
    } finally {
      clearTimeout(cleanupTimer);
      log.end();
      await finished(log);
    }
    if (browserError && cleanupError)
      throw new AggregateError([browserError, cleanupError], 'Browser and cleanup failed.');
    if (browserError) throw browserError;
    if (cleanupError) throw cleanupError;
    unchanged();
    execution.after = captureBinding(root);
    delete execution.after['next-env.d.ts'];
    writeFileSync(resolve(output, 'execution.json'), JSON.stringify(execution, null, 2));
    run('complete source-bound counter merge and95% gate', [
      tsx,
      'scripts/check-coverage.ts',
      '--combined',
    ]);
  } catch (error) {
    writeFileSync(
      resolve(output, 'execution-failed.json'),
      JSON.stringify({ ...execution, error: String(error) }, null, 2),
    );
    throw error;
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
