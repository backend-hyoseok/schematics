# Generated project type checking

Run `npm run test:integration` from the schematics repository. Node.js and pnpm
must be available. The repository uses npm; the generated projects use pnpm.
For a fully populated pnpm cache, use
`NEST_INTEGRATION_OFFLINE=1 npm run test:integration` to avoid registry access.

The suite generates ESM and CJS applications from the current source schematics,
installs their actual dependencies in temporary directories with lifecycle
scripts disabled, and runs their installed TypeScript compiler. It checks both
standard mode and a converted monorepo containing the original app, a secondary
app, and a shared library. Generated sources and compiler options are unchanged.
Only the source relocation disabled by `NODE_ENV=test` is performed by the test.

Every generated TypeScript file must belong to at least one checked config.
Both application build configs and the test config are checked; no diagnostics
are filtered. The generated `skipLibCheck` setting is respected, so this checks
the generated project's files, not the internals of dependency declarations.
Temporary projects are removed after each test. Dependency installation makes
this a separate, explicitly invoked integration suite rather than a unit test.
Dependency versions follow the generated manifest ranges and are not pinned by
a fixture lockfile.

The expected result is zero type errors, not an expected-failure assertion.
Before the template fix, ESM failed with TS2307 for `supertest/types`: once in
standard mode and in both apps' E2E files after conversion. The templates now
use `import type { App } from 'supertest/types.js'`, which resolves the declaration
under NodeNext ESM and CJS without a runtime import. Both modes must pass.
