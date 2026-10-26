import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.argv.includes('--combined')) {
  const require = createRequire(import.meta.url);
  const result = spawnSync(
    process.execPath,
    [require.resolve('tsx/cli'), 'scripts/merge-combined-coverage.ts', '--check'],
    { stdio: 'inherit', env: process.env },
  );
  process.exit(result.status ?? 1);
}

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

type Metric = { total: number; covered: number; skipped: number; pct: number };
type Metrics = Record<'lines' | 'branches' | 'functions' | 'statements', Metric>;
const root = process.cwd();
const report = JSON.parse(
  readFileSync(resolve(root, 'test-results/coverage/coverage-summary.json'), 'utf8'),
) as Record<string, Metrics>;
const files = new Map(
  Object.entries(report)
    .filter(([path]) => path !== 'total')
    .map(([path, metrics]) => [relative(root, path).split(sep).join('/'), metrics]),
);
function sources(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error('Coverage inventory must not follow symlinks.');
    return entry.isDirectory()
      ? sources(path)
      : /\.(?:tsx?|js)$/.test(path) && !path.endsWith('.d.ts')
        ? [path]
        : [];
  });
}
const expected = [
  ...sources('src'),
  ...sources('public').filter((path) => path.endsWith('.js')),
  'scripts/verify-database.ts',
  'scripts/tofu-schema.ts',
].sort();
for (const path of expected)
  if (!files.has(path)) throw new Error(`Coverage denominator omitted ${path}`);
for (const path of files.keys())
  if (!expected.includes(path)) throw new Error(`Unexpected coverage input ${path}`);

// These narrow floors sit below the audited 4257501 baseline. They protect
// heavily exercised trust/retry boundaries; global UI coverage stays visible.
const floors = {
  'src/lib/server.ts': { lines: 90, branches: 80, functions: 90 },
  'src/lib/action-identity.ts': { lines: 95, branches: 75, functions: 95 },
  'src/lib/login-callback.ts': { lines: 95, branches: 85, functions: 95 },
} as const;
for (const [path, limits] of Object.entries(floors))
  for (const [metric, minimum] of Object.entries(limits)) {
    const actual = files.get(path)![metric as keyof Metrics].pct;
    if (actual < minimum)
      throw new Error(`${path} ${metric} coverage ${actual}% is below its ${minimum}% floor.`);
  }
console.log(
  JSON.stringify(
    {
      scope: 'Node unit/SQL execution only; browser assertions are not instrumented coverage.',
      sourceFiles: expected.length,
      zeroLineFiles: expected.filter((path) => files.get(path)!.lines.covered === 0),
      total: report.total,
      floors,
    },
    null,
    2,
  ),
);
