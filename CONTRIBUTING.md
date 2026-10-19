# Contributing

Work on a branch or fork and open a pull request targeting `main`. The branch
blocks direct pushes, force pushes and deletion. Merging requires an approving
maintainer review, resolved review threads and all required CI and CodeQL gates
against the current base. New commits dismiss old approvals; the latest push
needs approval from someone other than its pusher. Maintainer ownership applies
to every file, including workflows and test policy.

External fork contributions need maintainer approval before CI runs. Review
workflow changes before approving a run, and keep CI credentials and fixtures
separate from production. Secret scanning uses the scanner's default rules with
an empty fingerprint exclusion file and ignores inline allow comments. A root
`.gitleaksignore` is rejected, so a contribution cannot introduce a silent
scanner exclusion.

Use Node.js 22.13 or newer, run `npm ci`, and start `npm run dev`. The local **Explore demo** preview needs no provider account. Preview is disabled by default in production; `NEXT_PUBLIC_ENABLE_DEMO=true` explicitly enables it for testing.

Run `npm run typecheck`, `npm run build`, and `npm run test:unit` for server/client changes. Browser tests require a separately running local server; install their engines with `npx playwright install chromium webkit`. All browser configurations default to `http://127.0.0.1:3000`; set `APP_URL` for another local port. Hosted URLs are rejected because these suites use synthetic accounts and fault fixtures. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` optionally selects your Chromium binary.

Before a pull request, run `npm run format:check`, `npm run lint`, and
`npm run test:coverage` as well. `npm run format` applies the shared formatting.
Type checking generates Next.js route declarations first; `next-env.d.ts` and
`.next/` are generated and must remain untracked. The executable `test:catalog`
lists fast, SQL, native and browser layers without pretending discovery is execution.

CI runs unit/SQL coverage, lint, formatting, type checks, a production build,
dependency advisories and selected functional browser tests. A separate security
workflow scans reachable Git history and the checked-out tree. GitHub-managed
CodeQL default setup separately analyzes JavaScript/TypeScript in this repository;
fork owners must enable code scanning for their own fork.
Native PostgreSQL and compiled API integration also run in CI with disposable
fixtures. CI also runs combined Node/browser coverage with 95% line and statement floors, plus the reviewed landing and header/sidebar screenshot suites on macOS. The complete screenshot inventory retains its documented local run.
CI never receives production credentials.

ESLint uses current JavaScript/TypeScript recommended rules and React's two
core Hooks correctness rules. The Next-specific lint bundle is intentionally
absent: its version-matched dependency tree currently includes an unpatched
`braces` advisory (GHSA-vfj7-8cjw-p6xm). Revisit that choice when a compatible
patched release exists; do not use `npm audit fix --force` to downgrade Next.

Use the relevant `test:*` script for the behavior changed. `test:voice` captures a real minute through Chromium's synthetic microphone and takes roughly a minute. The SQL benchmarks use disposable in-process PGlite databases; they do not contact the deployed database. Browser traces and captures default to ignored `test-results/`; `CHAT_EVIDENCE_DIR` optionally exports selected review captures elsewhere.

Visual regression baselines under `tests/visual-regression.spec.ts-snapshots/` show synthetic local conversations. Review rendered component differences before updating a baseline. Baseline approval is separate from comparisons with Google's actual interface and from device acceptance.

Keep changes focused, preserve account isolation and stable retry identities, and describe the checks run in your pull request. Do not include populated environment files, credentials, production messages, personal screenshots, or recordings. Bundled fonts, icons and emoji data retain their separate license notices. This project is independent of Google; new features must describe what this app actually supports.

Submit work you have the right to share under the project license, and preserve notices for any third-party code or assets you add.

For a suspected credential or private-data issue, use GitHub's private vulnerability reporting when available; do not post credentials or private account data in a public issue.

See [the complete browser inventory and screenshot review process](docs/testing.md) for the two-server aggregate command, non-vacuous geometry checks, source binding and evidence boundaries.
