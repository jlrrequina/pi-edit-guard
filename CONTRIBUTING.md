# Contributing

Issues and pull requests are welcome.

- Read [AGENTS.md](AGENTS.md): the hard constraints (erasable TypeScript only, no runtime dependencies, never write into the project or its `.git`, the failure direction of each invariant).
- `npm install`, then `npm run check` and `npm test` must pass. CI runs them on Linux, macOS and Windows with Node 22.18, 24 and 26, against the oldest supported π (1.2.0), smoke-tests the packed tarball and enforces a coverage floor.
- Every change in behavior comes with a test that fails without the change: write the test first, or run it once with the change reverted.
- A change to `guard/snapshot.ts` needs the property test to pass (`npm test` runs 300 cases; `PEG_PROPERTY_RUNS=2000 node --test test/snapshot.property.test.ts` runs more) and `npm run corpus` on real repositories (CI runs it for such pull requests and weekly).
- A change to how the guard reads π (events, entries, paths) needs a test in `test/host.test.ts`, which runs inside a real π session, and one live run: `PI_EDIT_GUARD_E2E_MODEL=anthropic/claude-haiku-4-5 npm run e2e`.
- Add a line under `## Unreleased` in `CHANGELOG.md` for every user-visible change. Do not change that heading or the version in `package.json`: the maintainers choose the version.
- Workflows pin every action to a commit SHA with the version in a comment (Dependabot keeps them current). CI lints them with actionlint and zizmor.
- A change to a message, a command or a configuration key updates the README, the skill (`skills/edit-guard/SKILL.md`), the site (`docs/site/index.html`) and `llms.txt` together; `test/package.test.ts` checks that they agree. `docs/cover.png` is `docs/cover.html` rendered at 1280×640 with device scale 2.
- `.github/security-insights.yml` (OpenSSF Security Insights) and `.bestpractices.json` (answers for the OpenSSF Best Practices badge) state facts about the repository and its settings. Keep them true when a fact changes, and update `last-updated` in the first; the comment at its top shows how to validate it.
