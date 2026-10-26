import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mergePayloads,
  validateManifest,
  validatePayload,
  requireCoverageFloor,
  type CoverageManifest,
  type RawCoverage,
  type BoundCoverage,
} from '../scripts/coverage-validation';
const require = createRequire(import.meta.url);
test('the95 percent floor uses exact counts rather than a rounded percentage', () => {
  assert.throws(() => requireCoverageFloor({ covered: 18999, total: 20000 }, 'lines'), /below95/);
  requireCoverageFloor({ covered: 19000, total: 20000 }, 'lines');
  assert.throws(() => requireCoverageFloor({ covered: 0, total: 0 }, 'statements'), /below95/);
});
const { inventory, instrument } = require('../scripts/coverage-instrumentation.cjs') as {
  inventory(root: string, runId: string): CoverageManifest;
  instrument(source: string, path: string, id: string): { code: string };
};
function fixture() {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'chat-coverage-')));
  for (const d of ['src', 'public', 'scripts']) mkdirSync(resolve(root, d));
  writeFileSync(
    resolve(root, 'src/loaded.ts'),
    'function choose(x = 1) { if (x) return 10; return 20; }\nchoose(1);',
  );
  writeFileSync(resolve(root, 'src/unloaded.ts'), 'export function unopened() { return 30; }');
  writeFileSync(resolve(root, 'src/types.ts'), 'export type Id = string;');
  writeFileSync(resolve(root, 'scripts/verify-database.ts'), 'export const check = () => 1;');
  writeFileSync(resolve(root, 'scripts/tofu-schema.ts'), 'export const apply = () => 6;');
  const manifest = inventory(root, 'fixture-run');
  const sandbox = { __coverage__: {} as RawCoverage['coverage'] };
  runInNewContext(
    instrument(
      readFileSync(resolve(root, 'src/loaded.ts'), 'utf8'),
      resolve(root, 'src/loaded.ts'),
      manifest.runId,
    ).code,
    sandbox,
  );
  const raw = {
    layer: 'node',
    runId: manifest.runId,
    coverage: (sandbox as { __coverage__: RawCoverage['coverage'] }).__coverage__,
  };
  return { root, manifest, raw, close: () => rmSync(root, { recursive: true, force: true }) };
}
test('coverage counts actual execution, seeds unloaded inputs zero and retains types-only inventory', () => {
  const f = fixture();
  try {
    validateManifest(f.manifest, inventory(f.root, f.manifest.runId));
    const { combined, observedLayers } = mergePayloads(f.manifest, [f.raw]);
    assert.deepEqual([...observedLayers], ['node']);
    assert.equal(
      combined.fileCoverageFor(resolve(f.root, 'src/unloaded.ts')).toSummary().lines.covered,
      0,
    );
    assert.equal(
      combined.fileCoverageFor(resolve(f.root, 'src/loaded.ts')).toSummary().lines.covered,
      2,
    );
    assert.equal(f.manifest.files['src/types.ts'].executable, false);
    assert.ok(combined.getCoverageSummary().lines.pct < 100);
  } finally {
    f.close();
  }
});
test('coverage rejects added inputs, deleted inputs, altered seed counts and false executable flags', () => {
  const f = fixture();
  try {
    writeFileSync(resolve(f.root, 'src/new.ts'), 'export const fresh = 1;');
    assert.throws(
      () => validateManifest(f.manifest, inventory(f.root, f.manifest.runId)),
      /inventory/,
    );
    rmSync(resolve(f.root, 'src/new.ts'));
    rmSync(resolve(f.root, 'src/unloaded.ts'));
    assert.throws(
      () => validateManifest(f.manifest, inventory(f.root, f.manifest.runId)),
      /inventory/,
    );
    writeFileSync(resolve(f.root, 'src/unloaded.ts'), 'export function unopened() { return 30; }');
    const bad = structuredClone(f.manifest);
    bad.seed[resolve(f.root, 'src/loaded.ts')].s['0'] = 1;
    assert.throws(() => validateManifest(bad, inventory(f.root, f.manifest.runId)), /inventory/);
    const falseFlag = structuredClone(f.manifest);
    falseFlag.files['src/types.ts'].executable = true;
    assert.throws(
      () => validateManifest(falseFlag, inventory(f.root, f.manifest.runId)),
      /inventory/,
    );
  } finally {
    f.close();
  }
});
test('same-length edits cannot reuse source counters; stale runs and instrumenters are rejected', () => {
  const f = fixture();
  try {
    const file = resolve(f.root, 'src/loaded.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace('10', '11'));
    const fresh = inventory(f.root, f.manifest.runId);
    assert.throws(() => validatePayload(fresh, f.raw), /sourceHash/);
    const stale = structuredClone(f.raw);
    stale.runId = 'previous-run';
    assert.throws(() => validatePayload(f.manifest, stale), /run ID/);
    const altered = structuredClone(f.raw);
    (Object.values(altered.coverage)[0]! as BoundCoverage).instrumenterHash = 'old';
    assert.throws(() => validatePayload(f.manifest, altered), /instrumenterHash/);
  } finally {
    f.close();
  }
});
test('coverage rejects missing counters, malformed one-arm branches, negative values and wrong paths', () => {
  const f = fixture();
  try {
    const missing = structuredClone(f.raw);
    delete Object.values(missing.coverage)[0]!.s['0'];
    assert.throws(() => validatePayload(f.manifest, missing), /counter keys/);
    const branch = structuredClone(f.raw);
    const data = Object.values(branch.coverage)[0]!;
    const id = Object.keys(data.b).find((id) => data.b[id].length === 1)!;
    (data.b as Record<string, unknown>)[id] = 1;
    assert.throws(() => validatePayload(f.manifest, branch), /must be arrays/);
    const negative = structuredClone(f.raw);
    Object.values(negative.coverage)[0]!.s['0'] = -1;
    assert.throws(() => validatePayload(f.manifest, negative), /Invalid coverage count/);
    const wrong = structuredClone(f.raw);
    Object.values(wrong.coverage)[0]!.path = '/other.ts';
    assert.throws(() => validatePayload(f.manifest, wrong), /path mismatch/);
  } finally {
    f.close();
  }
});
test('empty and all-zero payloads do not count as an observed execution layer', () => {
  const f = fixture();
  try {
    assert.equal(
      validatePayload(f.manifest, { layer: 'browser', runId: f.manifest.runId, coverage: {} }),
      false,
    );
    assert.equal(
      validatePayload(f.manifest, {
        layer: 'node',
        runId: f.manifest.runId,
        coverage: f.manifest.seed,
      }),
      false,
    );
  } finally {
    f.close();
  }
});
test('Node counter capture preserves ordinary SIGTERM termination and writes its bounded evidence', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'chat-coverage-signal-'));
  const child = spawn(
    process.execPath,
    [
      '--require',
      resolve('scripts/capture-node-coverage.cjs'),
      '-e',
      'console.log("ready"); setInterval(()=>{},1000);',
    ],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        CHAT_COVERAGE_RUN_ID: 'signal-check',
        CHAT_ISTANBUL_DIR: dir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    await once(child.stdout!, 'data');
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    const [code, signal] = await Promise.race([
      exit,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('SIGTERM child did not exit')), 3000).unref(),
      ),
    ]);
    assert.equal(code, null);
    assert.equal(signal, 'SIGTERM');
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(readFileSync(resolve(dir, files[0]), 'utf8')).runId, 'signal-check');
  } finally {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source discovery refuses unsupported executable extensions and symlinks', () => {
  const f = fixture();
  try {
    writeFileSync(resolve(f.root, 'src/hidden.mts'), 'export const hidden = 1;');
    assert.throws(() => inventory(f.root, f.manifest.runId), /Unsupported runtime/);
    rmSync(resolve(f.root, 'src/hidden.mts'));
    symlinkSync(resolve(f.root, 'src/loaded.ts'), resolve(f.root, 'src/alias.ts'));
    assert.throws(() => inventory(f.root, f.manifest.runId), /source symlink/);
  } finally {
    f.close();
  }
});

test('function-only input is executable and changed same-coordinate modules cannot inherit old hits', () => {
  const f = fixture();
  try {
    writeFileSync(resolve(f.root, 'src/function.ts'), 'function noop() {}');
    const fresh = inventory(f.root, f.manifest.runId);
    assert.equal(fresh.files['src/function.ts'].statementCount, 0);
    assert.equal(fresh.files['src/function.ts'].executable, true);
    const file = resolve(f.root, 'src/loaded.ts');
    const before = readFileSync(file, 'utf8');
    const after = before.replace('10', '11').replace('choose(1)', 'choose(0)');
    const sandbox = { __coverage__: {} as RawCoverage['coverage'] };
    runInNewContext(instrument(before, file, f.manifest.runId).code, sandbox);
    const old = structuredClone(sandbox.__coverage__[file]) as BoundCoverage;
    runInNewContext(instrument(after, file, f.manifest.runId).code, sandbox);
    const next = sandbox.__coverage__[file] as BoundCoverage;
    assert.notEqual(next.sourceHash, old.sourceHash);
    assert.ok(
      Object.entries(old.s).some(([id, count]) => count > 0 && next.s[id] === 0),
      'old branch hits must reset',
    );
    validatePayload(inventory(f.root, f.manifest.runId), f.raw);
  } finally {
    f.close();
  }
});

test('malformed counts cannot shrink or falsely fill the denominator', () => {
  const f = fixture();
  try {
    for (const value of [NaN, Infinity, -1, 1.5]) {
      const bad = structuredClone(f.raw);
      Object.values(bad.coverage)[0]!.s['0'] = value;
      assert.throws(() => validatePayload(f.manifest, bad), /Invalid coverage count/);
    }
    const extra = structuredClone(f.raw);
    Object.values(extra.coverage)[0]!.s.unmapped = 1;
    assert.throws(() => validatePayload(f.manifest, extra), /counter keys/);
    const short = structuredClone(f.raw);
    const data = Object.values(short.coverage)[0]!;
    data.b[Object.keys(data.b)[0]] = [];
    assert.throws(() => validatePayload(f.manifest, short), /cardinality/);
  } finally {
    f.close();
  }
});

test('executed merge CLI rejects missing execution, missing layers, false participation and failed tests', () => {
  const f = fixture();
  const output = resolve(f.root, 'test-results/combined-coverage');
  try {
    mkdirSync(resolve(output, 'raw'), { recursive: true });
    writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(f.manifest));
    const covered = structuredClone(f.manifest.seed);
    for (const data of Object.values(covered)) {
      for (const key of ['s', 'f'] as const)
        for (const id of Object.keys(data[key])) data[key][id] = 1;
      for (const id of Object.keys(data.b)) data.b[id] = data.b[id].map(() => 1);
    }
    const put = (layer: string) =>
      writeFileSync(
        resolve(output, 'raw', `${layer}.json`),
        JSON.stringify({
          layer,
          runId: f.manifest.runId,
          testId: layer === 'browser' ? 'actual-test' : undefined,
          coverage: covered,
        }),
      );
    ['node', 'server', 'browser'].forEach(put);
    const execution = {
      runId: f.manifest.runId,
      node: { exitCode: 0 },
      server: { exitCode: 0 },
      browser: { exitCode: 0, tests: 1, testIds: ['actual-test'] },
    };
    const save = (data: unknown) =>
      writeFileSync(resolve(output, 'execution.json'), JSON.stringify(data));
    const run = () =>
      spawnSync(
        process.execPath,
        [require.resolve('tsx/cli'), resolve('scripts/merge-combined-coverage.ts'), '--check'],
        {
          cwd: f.root,
          encoding: 'utf8',
          env: { ...process.env, NODE_OPTIONS: '' },
        },
      );
    assert.notEqual(run().status, 0, 'missing execution must fail');
    save(execution);
    const positive = run();
    assert.equal(
      positive.status,
      0,
      `genuine complete passing union is accepted: ${positive.stderr}`,
    );
    rmSync(resolve(output, 'raw/server.json'));
    assert.match(run().stderr, /required layer server/);
    put('server');
    save({ ...execution, browser: { ...execution.browser, testIds: ['different-test'] } });
    assert.match(run().stderr, /participation mismatch/);
    save({ ...execution, runId: 'stale' });
    assert.match(run().stderr, /passing source-bound/);
    save({ ...execution, browser: { ...execution.browser, exitCode: 1 } });
    assert.match(run().stderr, /passing source-bound/);
    save(execution);
    writeFileSync(
      resolve(output, 'raw/browser.json'),
      JSON.stringify({
        layer: 'browser',
        runId: f.manifest.runId,
        testId: 'actual-test',
        coverage: f.manifest.seed,
      }),
    );
    assert.match(run().stderr, /required layer browser/);
  } finally {
    f.close();
  }
});
