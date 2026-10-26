const { createInstrumenter } = require('istanbul-lib-instrument');
const { readdirSync, readFileSync } = require('node:fs');
const { resolve, relative, sep } = require('node:path');
const { createHash } = require('node:crypto');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const instrumenterHash = sha256(
  readFileSync(__filename) + require('istanbul-lib-instrument/package.json').version,
);
function runtimeSources(root) {
  function walk(directory) {
    return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Coverage cannot follow a source symlink.');
      if (entry.isDirectory()) return walk(path);
      if (/\.(jsx|mjs|cjs|mts|cts)$/.test(path))
        throw new Error(`Unsupported runtime source extension: ${path}`);
      return /\.(tsx?|js)$/.test(path) && !path.endsWith('.d.ts') ? [path] : [];
    });
  }
  return [
    ...walk('src'),
    ...walk('public').filter((path) => path.endsWith('.js')),
    'scripts/verify-database.ts',
    'scripts/tofu-schema.ts',
  ].sort();
}
function instrument(source, filename, runId) {
  if (!runId) throw new Error('Coverage instrumentation requires a run ID.');
  const instrumenter = createInstrumenter({
    esModules: true,
    compact: false,
    preserveComments: true,
    produceSourceMap: true,
    coverageGlobalScope: 'globalThis',
    coverageGlobalScopeFunc: false,
    parserPlugins: ['typescript', 'jsx'],
  });
  let code = instrumenter.instrumentSync(source, filename);
  const coverage = instrumenter.lastFileCoverage();
  const binding = { sourceHash: sha256(source), instrumenterHash, runId };
  Object.assign(coverage, binding);
  const generatedHash = /var hash = "([a-f0-9]+)";/.exec(code)?.[1];
  if (!generatedHash) throw new Error('Unsupported Istanbul counter identity.');
  const boundHash = sha256(JSON.stringify(binding));
  coverage.hash = boundHash;
  // Replace only the generated initializer prefix, never user source literals.
  const initializerEnd = code.indexOf('\n  var actualCoverage');
  if (initializerEnd < 0) throw new Error('Unsupported Istanbul initializer boundary.');
  code =
    code.slice(0, initializerEnd).replaceAll(generatedHash, boundHash) + code.slice(initializerEnd);
  // Bind the actual executing counter object, not an external map with matching
  // line coordinates. Same-length source changes must not reuse stale counters.
  {
    let inserted = false;
    code = code.replace(/\n(cov_[a-z0-9]+\(\));/, (match) => {
      inserted = true;
      return `${match}\nObject.assign(globalThis.__coverage__[${JSON.stringify(filename)}], ${JSON.stringify(binding)});`;
    });
    if (!inserted) throw new Error('Unsupported Istanbul counter initializer.');
  }
  return { code, coverage, map: null }; // Counter locations already refer to original source.
}
function inventory(root, runId) {
  const files = {},
    seed = {};
  for (const path of runtimeSources(root)) {
    const filename = resolve(root, path),
      source = readFileSync(filename, 'utf8');
    const data = instrument(source, filename, runId);
    seed[filename] = data.coverage;
    files[path] = {
      sha256: sha256(source),
      lines: source.replace(/\n$/, '').split('\n').length,
      statementCount: Object.keys(data.coverage.statementMap).length,
      executable: ['s', 'f', 'b'].some((key) => Object.keys(data.coverage[key]).length > 0),
    };
  }
  return {
    root,
    runId,
    instrumenterHash,
    files,
    seed,
    scope:
      'Original-source executable statements; unloaded inputs seeded at zero. Types-only modules stay inventoried with zero executable statements.',
  };
}
function sourcePath(root, absolute) {
  return relative(root, absolute).split(sep).join('/');
}
module.exports = { runtimeSources, instrument, inventory, sourcePath, instrumenterHash };
