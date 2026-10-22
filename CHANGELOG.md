# Changelog

## Unreleased

## 0.1.0 — 2026-10-22

First release.

- **Freshness.** `edit` and `write` (and `lsp_fix` with `write: true`, when installed) are blocked on an existing file unless the agent's last read of it is still in the model's context and the file's content hash still matches: "exists but was not read in this context" or "changed since you read it (call #N)". New files pass. Paths resolve exactly as π's tools resolve them, through symlinks. Observations are stored in the session and rebuilt from π's projection on resume, fork, `/tree`, compaction and context edits.
- **Snapshots and `/undo`.** Before the first call of a run that can change files, the project root is snapshotted into a private git store under `~/.pi/agent/pi-edit-guard/` (never the project's `.git`), with a persistent private index and packed objects. The first snapshot of a root runs in the background from the session's first prompt. Write-tool targets the snapshot does not hold (ignored files, files outside the root) are journaled. `/undo [n | pre-undo-<k>] [--yes]` previews and restores content, executable bits, symlinks and the case of names exactly (also on case-insensitive file systems), deletes files created since, and makes a pre-undo checkpoint first, so an undo can be reversed. `/checkpoints` lists the checkpoints. Retention keeps 20 runs per session; stores unused for 30 days, or whose project was deleted, are removed.
- **Loop breaker.** A third identical call with nothing changed in between is blocked for tools that depend only on the files and flagged for the rest; a command that fails again after changes gets a notice from the second failure. Blocked calls, also those blocked by another extension, do not count as changes.
- **Windows.** Works on Windows with Git for Windows (which "Git Bash only" installs leave off the `PATH`). Symlinks restore with the type of their target; without Developer Mode or administrator rights the `/undo` preview names the symlinks it cannot restore. Files held open by a virus scanner or an indexer are retried, and read-only files are replaced. Directory junctions are not followed into the snapshot.
- `/guard` reports the coverage and switches each part on or off for the session; `~/.pi/agent/pi-edit-guard/config.json` configures the tool classes, limits and retention; `PI_EDIT_GUARD_DEBUG=1` logs every decision.
- Tested on Linux, macOS and Windows with a property test (300 random trees and mutations per run, with and without git, case-only renames included, restore and redo exact), integration tests against π's session manager and tools, a run inside a real π session (SDK, faux model, codemode), a live `pi -p` run, and on nine public repositories (`npm run corpus`).
