# Contributing

Issues and pull requests are welcome.

- Read [AGENTS.md](AGENTS.md): the hard constraints (erasable TypeScript only, no runtime dependencies, never write into the project or its `.git`, the failure direction of each invariant).
- `npm install`, then `npm run check` and `npm test` must pass. CI runs them on Linux and macOS with Node 22.18, 24 and 26, against the oldest supported π (1.2.0), smoke-tests the packed tarball and enforces a coverage floor.
- A change to `guard/snapshot.ts` needs the property test to pass (`npm test` runs 300 cases; `PEG_PROPERTY_RUNS=2000 node --test test/snapshot.property.test.ts` runs more) and `npm run corpus` on real repositories (CI runs it for such pull requests and weekly).
- A change to how the guard reads π (events, entries, paths) needs a test in `test/host.test.ts`, which runs inside a real π session, and one live run: `PI_EDIT_GUARD_E2E_MODEL=anthropic/claude-haiku-4-5 npm run e2e`.
- Add a line under `## Unreleased` in `CHANGELOG.md` for every user-visible change.
- Workflows pin every action to a commit SHA with the version in a comment (Dependabot keeps them current). CI lints them with actionlint and zizmor.

## Releasing

Releases are automatic. Every push to `main` runs CI and then the **prepare** job of the [Release workflow](.github/workflows/release.yml):

- If `## Unreleased` in `CHANGELOG.md` has entries, it releases. The heading picks the version: `## Unreleased` is a patch release; `## Unreleased (minor)`, `## Unreleased (major)` or `## Unreleased (1.4.0)` say otherwise. It moves the notes under the new version, bumps `package.json`, commits `release: X.Y.Z`, tags `vX.Y.Z` and pushes both to `main`.
- If `## Unreleased` is empty, the push only runs CI.
- **publish** then runs on the tag: it tests again, packs once, attests the tarball, publishes it to npm with provenance and attaches the same tarball and its provenance bundle to the GitHub release. Because it runs on the tag, the provenance points at exactly the released commit.

To release on purpose or override the heading: **Actions → Release → Run workflow** on `main` with `patch`, `minor`, `major` or an exact version; tick *dry-run* to rehearse without pushing. Pushing a `vX.Y.Z` tag yourself (with `package.json` and a `## X.Y.Z` section in place) runs **publish** directly. Every step is idempotent, so a failed release is finished by re-running it.

npm authentication is trusted publishing from the `npm` environment: there is no npm token. The release commit is pushed with the workflow's `GITHUB_TOKEN`; if `main` is protected, allow GitHub Actions to push to it.

### One-time setup

npm cannot publish the first version of a package through trusted publishing ([npm/cli#8544](https://github.com/npm/cli/issues/8544)), so the first release needs one manual step:

1. Create the repository `jlrrequina/pi-edit-guard` and, under **Settings → Environments**, an environment `npm` that only `main` and `v*` tags can deploy from.
2. Push `main`. The Release workflow tags `v0.1.0` from `## Unreleased (0.1.0)`; its **publish** run fails at "Publish to npm", because the package does not exist yet.
3. Publish that tag by hand, from a clean checkout: `git checkout v0.1.0 && npm ci && npm publish --access public`.
4. On npmjs.com, under the package's **Settings → Trusted Publisher**, add GitHub Actions: user `jlrrequina`, repository `pi-edit-guard`, workflow `release.yml`, environment `npm`. Then require two-factor authentication and disallow tokens for publishing.
5. Re-run the failed **publish** run: it skips npm (the version exists) and creates the GitHub release.

A new trusted-publisher configuration expires if no publish succeeds within 2 days, so add it in step 4 shortly before the next release, or re-create it then.
