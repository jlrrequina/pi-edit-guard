# Security policy

## Reporting a vulnerability

Report it privately at <https://github.com/jlrrequina/pi-edit-guard/security/advisories/new> (**Security → Report a vulnerability**). Please do not open a public issue.

Expect a first response within 7 days. Fixes ship as a patch release, and the advisory is published once the fix is on npm. Only the latest release is supported.

In scope: anything that makes the extension write into a project or its `.git`, restore the wrong content, follow a symlink out of the project during a restore, leak the contents of its store (which can hold copies of ignored files such as `.env`), or let a write through that the freshness rule should block.

## Verifying a release

Releases are built and published only by the [Release workflow](.github/workflows/release.yml), from the tagged commit, with no long-lived npm token (trusted publishing).

```bash
npm audit signatures                                   # in a project that installed the package: npm provenance
gh attestation verify lenard9191-pi-edit-guard-<version>.tgz -R jlrrequina/pi-edit-guard
gh release verify v<version> -R jlrrequina/pi-edit-guard       # GitHub releases are immutable
```

The tarball attached to each GitHub release is byte-identical to the one on npm. It comes with its provenance as `lenard9191-pi-edit-guard-<version>.tgz.intoto.jsonl` (the Sigstore bundle with the SLSA v1 statement, signature, certificate and transparency-log entry), which verifies without GitHub's attestation store:

```bash
gh attestation verify lenard9191-pi-edit-guard-<version>.tgz \
  --bundle lenard9191-pi-edit-guard-<version>.tgz.intoto.jsonl -R jlrrequina/pi-edit-guard
```

A successful verification shows the signer as `.github/workflows/release.yml@refs/tags/v<version>` in this repository.
