# Working on pi-edit-guard

A π (pi-coding-agent) extension package. `README.md` is the user-facing reference; this file is for contributors and agents.

## Hard constraints — do not regress

- **Erasable TypeScript only.** π loads `.ts` directly: no `enum`, `namespace`, parameter properties or decorators; `import type`, explicit `.ts` import extensions, `"type": "module"`. `tsc` enforces `erasableSyntaxOnly` and `verbatimModuleSyntax`.
- **No runtime dependencies.** Only `node:*` and, in `index.ts` alone, `@earendil-works/pi-coding-agent` (π provides it). `guard/*` and `config.ts` import nothing from π, so they are testable alone.
- **Invisible to the project.** Nothing is written inside the project or its `.git`. Calls on the project's repository are read-only (`rev-parse`, `ls-files`, with `GIT_OPTIONAL_LOCKS=0`); every other git call goes through `runGit`, on the private store, with `GIT_*` variables from the environment removed.
- **Failure direction per invariant.** Freshness that cannot be verified blocks. A snapshot that fails allows the call, warns once per run and marks the run not covered. A loop detector that fails allows. No exception escapes a handler.
- **The transcript is the store for session state.** Observations live in `edit-guard/observation` entries and are rebuilt from π's projection; do not add a side file.
- **Paths as π resolves them.** `guard/paths.ts` mirrors π's resolver; `test/paths.test.ts` compares both on generated input. Keep them equal.

## Verify your changes

```bash
npm run check                                   # tsc, must be clean
npm test                                        # all passing; includes 300 property cases and a run inside a real π session
npm run corpus                                  # snapshot and restore of public repositories
PI_EDIT_GUARD_E2E_MODEL=<provider/model> npm run e2e   # a live pi -p run
PI_EDIT_GUARD_DEBUG=1 pi -e ./index.ts          # decisions in $TMPDIR/pi-edit-guard/debug.jsonl
```

See each new test fail without your change. Add changelog entries under `## Unreleased` in `CHANGELOG.md`; the heading's marker (`(minor)`, `(major)`, `(X.Y.Z)`) picks the next version, and a push to `main` releases (see the header of `.github/workflows/release.yml`). Never release by hand. Commit messages: `area: what changed`, lowercase.
