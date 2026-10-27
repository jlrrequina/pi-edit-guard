/**
 * INV2 as a property (§13.1): for random trees, with and without git, and
 * random mutations over one or two runs, restoring a run gives back exactly
 * the files at its start (content, mode, symlink targets, ignored files the
 * agent did not write), outside-root files written through the journal path
 * too, without touching the project's own git state; the pre-undo checkpoint
 * then gives back exactly the state before the undo.
 *
 * Runs: PEG_PROPERTY_RUNS (default 300, split between git and plain roots).
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import { insideRoot, pathKey } from "../guard/paths.ts";
import { applyRestore, createCheckpoint, findRoot, journal, needsJournal, openStore, prepareRestore } from "../guard/snapshot.ts";
import type { Checkpoint, Plan, Store } from "../guard/snapshot.ts";
import { cleanup, initRepo, projectGitState, readTree, sameTree, tempDir, writeFile, writeLink } from "./helpers.ts";

const RUNS = Number(process.env.PEG_PROPERTY_RUNS ?? 300);
const SESSION = "prop";
const windows = process.platform === "win32";

const seg = fc.constantFrom("a", "b", "src", "x y", "dir");
const fname = fc.constantFrom("f.txt", "g.ts", "h", "\u00dc.md", "run.sh", "data.bin");
const relPath = fc.tuple(fc.array(seg, { maxLength: 2 }), fname).map(([dirs, f]) => [...dirs, f].join("/"));
const bytes = fc.oneof(
  fc.uint8Array({ maxLength: 48 }).map((b) => Buffer.from(b)),
  fc.constantFrom("line\r\nother\r\n", "x\n", "").map((s) => Buffer.from(s)),
);
type Spec = { kind: "file"; content: Buffer; exec: boolean } | { kind: "link"; target: string };
const node: fc.Arbitrary<Spec> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("file" as const), content: bytes, exec: fc.boolean() }) },
  { weight: windows ? 0 : 1, arbitrary: fc.record({ kind: fc.constant("link" as const), target: fc.constantFrom("f.txt", "../a/g.ts", "missing", "src") }) },
);
const tree = fc.dictionary(relPath, node, { maxKeys: 10 });

type Mut =
  | { op: "modify" | "delete" | "chmod" | "toDir"; pick: number; content: Buffer }
  | { op: "add"; path: string; content: Buffer; exec: boolean }
  | { op: "relink"; pick: number; target: string }
  | { op: "writeTool"; path: string; content: Buffer }
  | { op: "writeIgnored"; path: "keep.log" | "ignored/secret.txt" | "new.log"; content: Buffer }
  | { op: "writeOutside"; path: "o1.txt" | "o2.txt"; content: Buffer }
  | { op: "gitignore"; content: string }
  | { op: "recase"; pick: number; depth: number };

const mut: fc.Arbitrary<Mut> = fc.oneof(
  fc.record({ op: fc.constantFrom("modify" as const, "delete" as const, "chmod" as const, "toDir" as const), pick: fc.nat(), content: bytes }),
  fc.record({ op: fc.constant("add" as const), path: relPath, content: bytes, exec: fc.boolean() }),
  fc.record({ op: fc.constant("relink" as const), pick: fc.nat(), target: fc.constantFrom("g.ts", "nowhere", "..") }),
  fc.record({ op: fc.constant("writeTool" as const), path: relPath, content: bytes }),
  fc.record({ op: fc.constant("writeIgnored" as const), path: fc.constantFrom("keep.log" as const, "ignored/secret.txt" as const, "new.log" as const), content: bytes }),
  fc.record({ op: fc.constant("writeOutside" as const), path: fc.constantFrom("o1.txt" as const, "o2.txt" as const), content: bytes }),
  fc.record({ op: fc.constant("gitignore" as const), content: fc.constantFrom("", "*.log\n", "ignored/\n", "*.log\nignored/\n") }),
  fc.record({ op: fc.constant("recase" as const), pick: fc.nat(), depth: fc.nat() }),
);

const swapCase = (s: string) => [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");

const scenario = fc.record({
  tree,
  ignored: fc.record({ log: bytes, secret: bytes }),
  outside: bytes,
  runs: fc.array(fc.array(mut, { maxLength: 6 }), { minLength: 1, maxLength: 2 }),
  target: fc.nat(),
});
type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;

/**
 * Targets for shell-style mutations, in a stable order: files and links that
 * no ignore pattern of the scenario can match. Changes made by a shell to
 * paths outside the snapshot domain are not covered by design; ignored paths
 * change only through the write path (writeIgnored).
 */
function entries(root: string): string[] {
  return [...readTree(root).keys()].filter((p) => p !== ".gitignore" && !p.endsWith(".log") && !p.startsWith("ignored/")).sort();
}

function blocked(root: string, rel: string): boolean {
  // a parent that is a file or symlink, or the path itself a directory: a bash `>` would fail too
  const parts = rel.split("/");
  for (let i = 1; i < parts.length; i++) {
    const p = join(root, ...parts.slice(0, i));
    if (existsSync(p) && !lstatSync(p).isDirectory()) return true;
  }
  return existsSync(join(root, rel)) && lstatSync(join(root, rel)).isDirectory();
}

async function apply(m: Mut, root: string, outside: string, write: (abs: string) => Promise<void>): Promise<void> {
  const list = entries(root);
  const at = (pick: number) => list[pick % list.length];
  switch (m.op) {
    case "modify": {
      const p = at(m.pick);
      if (p && !lstatSync(join(root, p)).isSymbolicLink()) writeFile(root, p, m.content, (statSync(join(root, p)).mode & 0o100) !== 0);
      return;
    }
    case "delete": {
      const p = at(m.pick);
      if (p) unlinkSync(join(root, p));
      return;
    }
    case "chmod": {
      const p = at(m.pick);
      if (p && !windows && !lstatSync(join(root, p)).isSymbolicLink()) chmodSync(join(root, p), (statSync(join(root, p)).mode & 0o100) !== 0 ? 0o644 : 0o755);
      return;
    }
    case "toDir": {
      const p = at(m.pick);
      if (!p) return;
      unlinkSync(join(root, p));
      writeFile(root, `${p}/inner.txt`, m.content);
      return;
    }
    case "relink": {
      const p = list.find((x) => lstatSync(join(root, x)).isSymbolicLink());
      if (p) writeLink(root, p, m.target);
      return;
    }
    case "add":
      if (!blocked(root, m.path)) writeFile(root, m.path, m.content, m.exec);
      return;
    case "writeTool":
    case "writeIgnored": {
      if (blocked(root, m.path)) return;
      const abs = join(root, m.path);
      await write(abs);
      const exec = existsSync(abs) && !lstatSync(abs).isSymbolicLink() && (statSync(abs).mode & 0o100) !== 0;
      if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) return; // the write tool follows links; out of scope here
      writeFile(root, m.path, m.content, exec);
      return;
    }
    case "writeOutside": {
      const abs = join(outside, m.path);
      await write(abs);
      writeFile(outside, m.path, m.content);
      return;
    }
    case "gitignore":
      writeFile(root, ".gitignore", m.content);
      return;
    case "recase": {
      // a shell renaming a file or one of its directories to another case (Foo.ts to foo.ts)
      const p = at(m.pick);
      if (!p) return;
      const parts = p.split("/");
      const i = m.depth % parts.length;
      const from = join(root, ...parts.slice(0, i + 1));
      const to = join(root, ...parts.slice(0, i), swapCase(parts[i]!));
      const other = lstatSync(to, { throwIfNoEntry: false });
      if (from === to || (other && other.ino !== lstatSync(from).ino)) return; // case-sensitive: another file has that name
      renameSync(from, to);
      return;
    }
  }
}

async function check(gitRoot: boolean, s: Scenario): Promise<void> {
  const root = tempDir("peg-prop-");
  const outside = tempDir("peg-prop-out-");
  const base = tempDir("peg-prop-base-");
  try {
    for (const [p, spec] of Object.entries(s.tree)) {
      if (blocked(root, p)) continue;
      if (spec.kind === "file") writeFile(root, p, spec.content, !windows && spec.exec);
      else writeLink(root, p, spec.target);
    }
    writeFile(root, ".gitignore", "*.log\nignored/\n");
    writeFile(root, "keep.log", s.ignored.log);
    writeFile(root, "ignored/secret.txt", s.ignored.secret);
    writeFile(outside, "o1.txt", s.outside);
    if (gitRoot) initRepo(root);
    const gitBefore = gitRoot ? projectGitState(root) : undefined;
    const store: Store = await openStore(base, await findRoot(root), []);

    const states: { tree: ReturnType<typeof readTree>; outside: ReturnType<typeof readTree> }[] = [];
    const checkpoints: Checkpoint[] = [];
    for (let i = 0; i < s.runs.length; i++) {
      states.push({ tree: readTree(root), outside: readTree(outside) });
      const c = { kind: "run" as const, n: i + 1 };
      const { commit } = await createCheckpoint(store, SESSION, c);
      checkpoints.push({ ...c, commit });
      const write = async (abs: string) => {
        const key = pathKey(abs); // as index.ts keys write targets: the names on disk
        if (await needsJournal(store, commit, key)) await journal(store, SESSION, c, key);
      };
      for (const m of s.runs[i]!) await apply(m, root, outside, write);
    }
    const final = { tree: readTree(root), outside: readTree(outside) };

    const t = s.target % checkpoints.length;
    // /undo writes only the paths that differ between the state now and the state it restores (a wrong delete fails the exactness checks)
    const onlyDiffering = (p: Plan) => {
      for (const c of p.changes) {
        if (c.op === "delete") continue;
        const inRoot = insideRoot(root, c.path);
        const side = inRoot !== undefined ? "tree" : "outside";
        const rel = inRoot ?? insideRoot(outside, c.path)!;
        assert.notDeepEqual(final[side].get(rel), states[t]![side].get(rel), `${c.op} ${rel}: the same in both states`);
      }
    };
    const { plan, preUndo } = await prepareRestore(store, SESSION, checkpoints[t]!, { kind: "pre-undo", k: 1, afterRun: checkpoints.length });
    onlyDiffering(plan);
    const applied = await applyRestore(store, plan);
    assert.deepEqual(applied.errors, []);
    assert.equal(sameTree(states[t]!.tree, readTree(root)), undefined, "root after restore");
    assert.equal(sameTree(states[t]!.outside, readTree(outside)), undefined, "outside after restore");
    if (gitBefore) assert.deepEqual(projectGitState(root), gitBefore, "project git state");

    const redo = await prepareRestore(store, SESSION, preUndo, { kind: "pre-undo", k: 2, afterRun: checkpoints.length });
    onlyDiffering(redo.plan);
    assert.deepEqual((await applyRestore(store, redo.plan)).errors, []);
    assert.equal(sameTree(final.tree, readTree(root)), undefined, "root after redo");
    assert.equal(sameTree(final.outside, readTree(outside)), undefined, "outside after redo");
    if (gitBefore) assert.deepEqual(projectGitState(root), gitBefore, "project git state after redo");
  } finally {
    cleanup(root, outside, base);
  }
}

for (const gitRoot of [true, false]) {
  test(`restore is exact (${gitRoot ? "git root" : "plain directory"}, ${Math.ceil(RUNS / 2)} cases)`, { timeout: 30 * 60_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(scenario, (s) => check(gitRoot, s)),
      { numRuns: Math.ceil(RUNS / 2), endOnFailure: true },
    );
  });
}

