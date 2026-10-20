/** Snapshot, journal and restore on fixed scenarios (the property test randomizes them). */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findRoot, journal, listCheckpoints, needsJournal, openStore, prepareRestore, applyRestore, createCheckpoint, retain, runGit, refuseRoot, sweepStores, storeDir } from "../guard/snapshot.ts";
import type { Checkpoint, CheckpointId, Store } from "../guard/snapshot.ts";
import { cleanup, initRepo, projectGitState, readTree, sameTree, tempDir, writeFile, writeLink } from "./helpers.ts";

const SESSION = "s1";

async function setup(gitRoot: boolean) {
  const root = tempDir("peg-root-");
  const base = tempDir("peg-base-");
  const outside = tempDir("peg-out-");
  writeFile(root, "src/a.ts", "export const a = 1;\n");
  writeFile(root, "src/b.ts", "b\r\nwith crlf\r\n");
  writeFile(root, "bin/run.sh", "#!/bin/sh\necho hi\n", true);
  writeLink(root, "link-to-a", "src/a.ts");
  writeFile(root, ".gitignore", "*.log\n.env\n");
  writeFile(root, ".gitattributes", "* text=auto eol=lf\n"); // the store must keep the CRLF bytes anyway
  writeFile(root, "debug.log", "ignored, never touched\n");
  writeFile(root, ".env", "SECRET=1\n");
  writeFile(outside, "notes.md", "outside the root\n");
  if (gitRoot) initRepo(root);
  const r = await findRoot(root);
  const store = await openStore(base, r, []);
  return { root, base, outside, store };
}

let runs = 0;
/** A run: checkpoint first, then the mutations; write-tool targets go through the journal first. */
async function runWith(store: Store, n: number, mutate: (write: (abs: string) => Promise<void>) => Promise<void> | void): Promise<Checkpoint> {
  runs++;
  const c: CheckpointId = { kind: "run", n };
  const { commit } = await createCheckpoint(store, SESSION, c);
  const write = async (abs: string) => {
    if (await needsJournal(store, commit, abs)) await journal(store, SESSION, c, abs);
  };
  await mutate(write);
  return { ...c, commit };
}

async function undo(store: Store, target: Checkpoint, k: number, afterRun: number) {
  const pre = { kind: "pre-undo" as const, k, afterRun };
  const { plan, preUndo } = await prepareRestore(store, SESSION, target, pre);
  const applied = await applyRestore(store, plan);
  assert.deepEqual(applied.errors, []);
  return { plan, preUndo, applied };
}

for (const gitRoot of [true, false]) {
  const kind = gitRoot ? "git root" : "plain directory";

  test(`${kind}: restore brings back content, modes, symlinks and CRLF bytes; deletes added files; leaves ignored files alone`, async () => {
    const { root, base, outside, store } = await setup(gitRoot);
    try {
      const before = readTree(root);
      const gitBefore = gitRoot ? projectGitState(root) : undefined;
      const run1 = await runWith(store, 1, async (write) => {
        await write(join(root, "src/a.ts"));
        writeFile(root, "src/a.ts", "changed\n");
        writeFile(root, "src/new/deep.ts", "new\n");
        unlinkSync(join(root, "src/b.ts"));
        chmodSync(join(root, "bin/run.sh"), 0o644);
        writeLink(root, "link-to-a", "elsewhere");
        writeFile(root, "more.log", "a new ignored file the agent did not write through a tool\n");
      });
      await undo(store, run1, 1, 1);
      const after = readTree(root, ["more.log"]);
      assert.equal(sameTree(before, after), undefined);
      assert.equal(readFileSync(join(root, "src/b.ts"), "utf8"), "b\r\nwith crlf\r\n");
      assert.ok(!existsSync(join(root, "src/new")), "a directory left empty by the restore is removed");
      assert.ok(existsSync(join(root, "more.log")), "an ignored file the agent did not write stays");
      if (gitBefore) assert.deepEqual(projectGitState(root), gitBefore, "the project's own git state is untouched");
      assert.ok(!existsSync(join(root, ".pi-edit-guard")) && readTree(root).size === before.size + 1, "nothing new inside the project");
    } finally {
      cleanup(root, base, outside);
    }
  });

  test(`${kind}: journal restores an ignored .env and a file outside the root, and deletes a new file outside the root`, async () => {
    const { root, base, outside, store } = await setup(gitRoot);
    try {
      const run1 = await runWith(store, 1, async (write) => {
        await write(join(root, ".env"));
        writeFile(root, ".env", "SECRET=2\n");
        await write(join(outside, "notes.md"));
        writeFile(outside, "notes.md", "changed outside\n");
        await write(join(outside, "created.md"));
        writeFile(outside, "created.md", "new outside\n");
      });
      await undo(store, run1, 1, 1);
      assert.equal(readFileSync(join(root, ".env"), "utf8"), "SECRET=1\n");
      assert.equal(readFileSync(join(outside, "notes.md"), "utf8"), "outside the root\n");
      assert.ok(!existsSync(join(outside, "created.md")));
    } finally {
      cleanup(root, base, outside);
    }
  });

  test(`${kind}: an ignored file first written in a later run is restored for an earlier run (not deleted)`, async () => {
    const { root, base, outside, store } = await setup(gitRoot);
    try {
      const run1 = await runWith(store, 1, () => writeFile(root, "src/a.ts", "run 1\n"));
      await runWith(store, 2, async (write) => {
        await write(join(root, ".env"));
        writeFile(root, ".env", "SECRET=from run 2\n");
      });
      await undo(store, run1, 1, 2);
      assert.equal(readFileSync(join(root, ".env"), "utf8"), "SECRET=1\n");
      assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "export const a = 1;\n");
    } finally {
      cleanup(root, base, outside);
    }
  });

  test(`${kind}: a file un-ignored by an edited .gitignore is kept, the .gitignore is restored`, async () => {
    const { root, base, outside, store } = await setup(gitRoot);
    try {
      const run1 = await runWith(store, 1, () => writeFile(root, ".gitignore", ".env\n"));
      await runWith(store, 2, () => writeFile(root, "src/a.ts", "run 2\n")); // debug.log is in this snapshot now
      const { plan } = await undo(store, run1, 1, 2);
      assert.ok(plan.kept.includes("debug.log"), "the restore knows debug.log was ignored at run 1");
      assert.equal(readFileSync(join(root, "debug.log"), "utf8"), "ignored, never touched\n");
      assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "*.log\n.env\n");
    } finally {
      cleanup(root, base, outside);
    }
  });

  test(`${kind}: type changes (file to directory, directory to file, file to symlink) restore`, async () => {
    const { root, base, outside, store } = await setup(gitRoot);
    try {
      const before = readTree(root);
      const run1 = await runWith(store, 1, () => {
        rmSync(join(root, "src/a.ts"));
        writeFile(root, "src/a.ts/inner.ts", "now a directory\n");
        rmSync(join(root, "bin"), { recursive: true });
        writeFile(root, "bin", "now a file\n");
        rmSync(join(root, "src/b.ts"));
        writeLink(root, "src/b.ts", "../.env");
      });
      await undo(store, run1, 1, 1);
      assert.equal(sameTree(before, readTree(root)), undefined);
    } finally {
      cleanup(root, base, outside);
    }
  });

  test(`${kind}: /undo pre-undo-<k> reverses an undo exactly, journaled paths included`, async () => {
    const { root, base, outside, store } = await setup(gitRoot);
    try {
      const run1 = await runWith(store, 1, async (write) => {
        writeFile(root, "src/a.ts", "agent work\n");
        writeFile(root, "src/added.ts", "added\n");
        await write(join(root, ".env"));
        writeFile(root, ".env", "SECRET=agent\n");
        await write(join(outside, "notes.md"));
        writeFile(outside, "notes.md", "agent outside\n");
      });
      const afterRun = { tree: readTree(root), outside: readTree(outside) };
      const { preUndo } = await undo(store, run1, 1, 1);
      assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "export const a = 1;\n");
      await undo(store, preUndo, 2, 1);
      assert.equal(sameTree(afterRun.tree, readTree(root)), undefined);
      assert.equal(sameTree(afterRun.outside, readTree(outside)), undefined);
    } finally {
      cleanup(root, base, outside);
    }
  });
}

test("refs live only in the private store, one per run; retention keeps the newest and prunes", async () => {
  const { root, base, outside, store } = await setup(true);
  try {
    const gitBefore = projectGitState(root);
    for (let n = 1; n <= 5; n++) await runWith(store, n, () => writeFile(root, "src/a.ts", `run ${n}\n`));
    const refs = (await runGit(store, ["for-each-ref", "--format=%(refname)"])).stdout.toString().trim().split("\n");
    assert.deepEqual(refs.sort(), [1, 2, 3, 4, 5].map((n) => `refs/runs/${SESSION}/${n}`).sort());
    assert.deepEqual(projectGitState(root), gitBefore);
    assert.equal(await retain(store, SESSION, 2), 3);
    const left = await listCheckpoints(store, SESSION);
    assert.deepEqual(left.filter((c) => c.commit).map((c) => (c as { n: number }).n), [4, 5]);
    assert.ok(store.dir.startsWith(base) && readFileSync(join(store.dir, "ROOT"), "utf8").trim() === root);
    if (process.platform !== "win32") assert.equal(statSync(store.dir).mode & 0o777, 0o700, "only the user can enter the store (it can hold copies of .env files)");
  } finally {
    cleanup(root, base, outside);
  }
});

test("retention keeps the journal of a dropped checkpoint while a kept, older checkpoint needs it", async () => {
  const { root, base, outside, store } = await setup(true);
  try {
    const run1 = await runWith(store, 1, async (write) => {
      await write(join(root, ".env"));
      writeFile(root, ".env", "SECRET=E1\n");
    });
    const run2 = await runWith(store, 2, () => writeFile(root, "src/a.ts", "run 2\n"));
    const { preUndo: pre1 } = await undo(store, run1, 1, 2); // journals .env=E1 in pre-undo-1
    assert.equal(readFileSync(join(root, ".env"), "utf8"), "SECRET=1\n");
    await undo(store, pre1, 2, 2); // redo: .env=E1, and pre-undo-2 journals .env=SECRET=1
    assert.equal(await retain(store, SESSION, 1), 2); // drops run 1 and pre-undo-1
    await undo(store, run2, 3, 2);
    assert.equal(readFileSync(join(root, ".env"), "utf8"), "SECRET=E1\n", "the state before run 2 needs pre-undo-1's journal record");
  } finally {
    cleanup(root, base, outside);
  }
});

test("index.lock: a lock held by another session fails the snapshot after the retries; a stale lock from a crashed git is cleared", async () => {
  const { root, base, outside, store } = await setup(true);
  try {
    const lock = join(store.dir, "index.lock");
    writeFileSync(lock, "");
    const started = Date.now();
    await assert.rejects(createCheckpoint(store, SESSION, { kind: "run", n: 1 }), /index\.lock/);
    assert.ok(Date.now() - started >= 1400, "five retries with 100 ms backoff");
    const { utimesSync } = await import("node:fs");
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(lock, old, old);
    await createCheckpoint(store, SESSION, { kind: "run", n: 1 });
    assert.ok(!existsSync(lock));
  } finally {
    cleanup(root, base, outside);
  }
});

test("roots: the home directory and large plain directories are refused; a git root never is", async () => {
  const { homedir } = await import("node:os");
  assert.match((await refuseRoot({ root: homedir(), git: false }, [])) ?? "", /home directory/);
  assert.match((await refuseRoot({ root: "/", git: false }, [])) ?? "", /file-system root/);
  const big = tempDir();
  try {
    mkdirSync(join(big, "d"));
    for (let i = 0; i < 20_001; i++) writeFileSync(join(big, "d", `${i}`), "");
    assert.match((await refuseRoot({ root: big, git: false }, [])) ?? "", /more than 20000 files/);
    assert.equal(await refuseRoot({ root: big, git: true }, []), undefined);
    mkdirSync(join(big, "node_modules"));
    rmSync(join(big, "d", "0"));
    assert.equal(await refuseRoot({ root: big, git: false }, []), undefined, "excluded directories do not count");
  } finally {
    cleanup(big);
  }
});

test("sweep: stores of deleted roots and stale stores go; the current store and unmounted roots stay", async () => {
  const base = tempDir();
  const parent = tempDir();
  try {
    const mk = async (root: string) => {
      mkdirSync(root, { recursive: true });
      return openStore(base, { root, git: false }, []);
    };
    const keep = await mk(join(parent, "keep"));
    const deleted = await mk(join(parent, "deleted"));
    const stale = await mk(join(parent, "stale"));
    const unmounted = await mk(join(parent, "volume", "project"));
    rmSync(join(parent, "deleted"), { recursive: true });
    rmSync(join(parent, "volume"), { recursive: true });
    const { utimesSync } = await import("node:fs");
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(join(stale.dir, "LAST_USED"), old, old);
    const removed = await sweepStores(base, 30, keep.dir);
    assert.deepEqual(removed.sort(), [deleted.dir, stale.dir].sort());
    assert.ok(existsSync(keep.dir) && existsSync(unmounted.dir));
    assert.equal(storeDir(base, join(parent, "keep")), keep.dir);
  } finally {
    cleanup(base, parent);
  }
});
