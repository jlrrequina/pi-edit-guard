---
name: edit-guard
description: Explains pi-edit-guard, the π (pi) extension that blocks stale writes, snapshots every run for /undo and stops repeated identical tool calls. Use when a tool result contains "edit-guard:" (a blocked edit or write, an identical call, a command that keeps failing), or when the user asks how to undo or revert what the agent changed, restore a checkpoint, see what a run changed, switch the guard off, or configure it.
license: MIT
compatibility: Requires the pi-edit-guard extension in the π coding agent (pi install npm:@lenard9191/pi-edit-guard) and git. The slash commands are for the user; the model cannot call them.
metadata:
  author: jlrrequina
  package: "@lenard9191/pi-edit-guard"
  homepage: https://jlrrequina.github.io/pi-edit-guard/
---

# edit-guard

`pi-edit-guard` keeps three rules on your tool calls:

1. **Freshness.** A write to an existing file (`edit`, `write`, and `lsp_fix` with `write: true`) needs a read of that file that is still in your context and whose content still matches the disk. A new file passes.
2. **Reversibility.** Before the first call of each run that can change files, the project is snapshotted into a private store, so the user can restore it exactly with `/undo`.
3. **Progress.** An identical call with nothing changed in between gives the same result, so the third one is blocked or flagged.

It never writes into the project or its `.git`. Its state is under `~/.pi/agent/pi-edit-guard/`.

## Messages and what to do

| Message | Cause | What to do |
|---|---|---|
| `edit-guard: src/app.ts exists but was not read in this context. Read it, then retry.` | You did not read the file in this context, or your read left the context (compaction summarized it, or an extension pruned it). `grep`, `find` and `ls` results do not count as reads. | `read` the file, then make the edit against what you read. |
| `edit-guard: src/app.ts changed since you read it (call #12). Read it again, then retry.` | The file changed after your read in call #12: the user, a formatter, another agent or a shell command changed it. | `read` it again and redo the edit on the new content. Do not overwrite the change. |
| `edit-guard: cannot verify src/app.ts (…). Read it, then retry.` | The guard could not hash the file. | `read` it, then retry. |
| `edit-guard: identical call #3 with no change in between; the result would be identical. Change the input or the state first.` | A call that depends only on the files, repeated with nothing changed. The call was blocked. | Use the result you already have, or change the input. |
| `edit-guard: identical call #3 with no change in between.` | Added to the result of a shell, web or other call whose result can depend on more than the files. The call ran. | Decide whether one more repeat can help. |
| `edit-guard: this command failed 2 times after changes. Stop. Re-read the relevant code top-down, state which assumption was wrong, and choose a different approach before the next edit.` | A shell, web or check command keeps failing after your edits. | Stop editing and do what the message says. |

A blocked call changes nothing, and it does not count as a change.

## Undoing the agent's work

Only the user can run `/undo`. When the user asks how to revert what you did, tell them to type `/undo`. Do not run `git checkout`, `git restore`, `git stash` or `git reset` for this: they also discard the user's own uncommitted work, and they do not restore the untracked or ignored files that the run changed. To revert your own work in the middle of a task, edit the files back.

| Command | Effect |
|---|---|
| `/undo` | Restore the files to the state before the latest run that changed something. It shows the paths that change and asks first. |
| `/undo <n>` | The state before run `n` of this session. |
| `/undo pre-undo-<k>` | The state before undo `k`: this reverses an undo. |
| `/undo … --yes` | No confirmation. Required without a UI, for example in `pi -p`. |
| `/checkpoints` | This session's checkpoints and how many paths differ from now. |
| `/guard` | Status: the switches, the root and its store, whether the current run is covered, and what is never covered. |
| `/guard on`, `/guard off` | All three parts on or off for this session. |
| `/guard freshness on\|off`, `/guard snapshots on\|off`, `/guard loop on\|off` | One part on or off for this session. |

`/undo` restores content, executable bits, symlinks and the case of names, deletes files the run created, and touches only the paths that differ. It never touches commits, the index, branches or the stash.

## What `/undo` does not cover

- changes by shell commands outside the project root, and by shell commands to files the snapshot does not hold (ignored files);
- the content of nested git repositories and submodules;
- what is behind a directory junction on Windows;
- empty directories, and permission bits other than the executable bit;
- files git cannot read.

When a snapshot fails, the run is not covered and the user sees a warning. No snapshots are taken in the home directory, at a file-system root, or in a directory outside git with more than 20,000 files or 500 MB.

## Configuration

The user configures the guard in `~/.pi/agent/pi-edit-guard/config.json`. Every key is optional; a wrong key is reported once and its default applies.

| Key | Default | Meaning |
|---|---|---|
| `freshness`, `snapshots`, `loop` | `true` | Turn a part off for every session. |
| `repeatLimit` | `3` | The identical call that is blocked or flagged. |
| `readTools` | `["read"]` | Tools whose result is an observation of a file. |
| `writeTools` | `{ "edit": "path", "write": "path" }` | Tools that change exactly one file, with the argument that names it. |
| `readOnlyTools` | `read`, `grep`, `find`, `ls` and other tools that never change files | Every other tool counts as changing files. |
| `volatileTools` | `bash`, `codemode`, web tools and other tools whose result can depend on more than the files | They get the failure notice instead of a block. |
| `exclude` | `[]` | More patterns the store ignores (`.gitignore` syntax). Files that match leave the next snapshot. |
| `keepRuns` | `20` | Run checkpoints kept per session. |
| `storeMaxAgeDays` | `7` | Checkpoints older than this are deleted in every session; stores unused for this long are deleted at session start. |

`PI_EDIT_GUARD_DEBUG=1` logs every decision to `pi-edit-guard/debug.jsonl` in the temporary directory. The full reference is the README: <https://github.com/jlrrequina/pi-edit-guard#readme>.
