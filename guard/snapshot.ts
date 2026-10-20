/**
 * INV2 Reversibility: a private git object store per project root, never the
 * project's own `.git`.
 *
 *   store   <base>/stores/<sha256(root)[0:16]>/   bare repository, ROOT, LAST_USED
 *   index   <store>/index                           private, persistent (stat cache)
 *   refs    refs/runs/<session>/<n>                 state before run n
 *           refs/pre-undo/<session>/<k>             state before undo k
 *   journal <store>/journal/<session>/<checkpoint>/ files a write tool changed that
 *                                                   the checkpoint's tree does not hold
 *
 * The snapshot domain of a checkpoint is its tree: git's view of the root
 * (tracked + untracked, not ignored; at a git root also the files the project
 * tracks even though they match an ignore rule). Write-tool targets outside
 * that tree (ignored files such as .env, paths outside the root) are copied to
 * the journal before the first write of the checkpoint. Restoring a
 * checkpoint applies its tree and, for every journaled path not in that tree,
 * the earliest journal record at or after it.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, rmdir, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse as parsePath, resolve, sep } from "node:path";
import { DEFAULT_EXCLUDES } from "../config.ts";
import { insideRoot } from "./paths.ts";

// ---------------------------------------------------------------------------
// git

export type Store = { dir: string; root: string; git: boolean };

export type GitOutput = { code: number; stdout: Buffer; stderr: string };

class GitError extends Error {
  readonly code: number;
  readonly stderr: string;
  constructor(command: string, out: GitOutput) {
    const first = out.stderr.split("\n").find((l) => l.startsWith("fatal:") || l.startsWith("error:")) ?? out.stderr.split("\n")[0] ?? "";
    super(`git ${command} failed (exit ${out.code})${first ? `: ${first.trim()}` : ""}`);
    this.code = out.code;
    this.stderr = out.stderr;
  }
}

/** Content stays byte-exact in the store whatever the project's attributes and the user's config say. */
const STORE_CONFIG = [
  ["core.autocrlf", "false"],
  ["core.safecrlf", "false"],
  ["core.fsmonitor", "false"],
  ["core.untrackedCache", "true"],
  ["core.quotePath", "false"],
  ["core.symlinks", "true"],
  ["core.fileMode", "true"],
  ["core.longpaths", "true"],
  // Stream every blob into a pack instead of one loose file per object: measured 2-4x faster first
  // snapshots and up to 7x smaller stores (10,000-file tree: 6.6 s → 1.5 s, 45 MB → 6.3 MB).
  ["core.bigFileThreshold", "1"],
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
  ["commit.gpgSign", "false"],
  ["advice.addEmbeddedRepo", "false"],
].flatMap(([k, v]) => ["-c", `${k}=${v}`]);

const IDENTITY = {
  GIT_AUTHOR_NAME: "pi-edit-guard",
  GIT_AUTHOR_EMAIL: "pi-edit-guard@localhost",
  GIT_COMMITTER_NAME: "pi-edit-guard",
  GIT_COMMITTER_EMAIL: "pi-edit-guard@localhost",
};

/** The caller's environment without GIT_* variables: GIT_DIR, GIT_INDEX_FILE or GIT_WORK_TREE from a hook must never redirect a call to the project's repository. */
function gitEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...extra };
}

function spawnGit(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, input: string | Buffer | undefined, ok: readonly number[]): Promise<GitOutput> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") };
      const sub = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c") ?? "";
      if (ok.includes(result.code)) resolvePromise(result);
      else reject(new GitError(sub, result));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

/** Every git call on a store: `git --git-dir=<store> --work-tree=<root>` with the private index. */
export function runGit(store: Store, args: readonly string[], opts: { input?: string | Buffer; ok?: readonly number[] } = {}): Promise<GitOutput> {
  return spawnGit([`--git-dir=${store.dir}`, `--work-tree=${store.root}`, ...STORE_CONFIG, ...args], store.root, gitEnv({ GIT_INDEX_FILE: join(store.dir, "index"), ...IDENTITY }), opts.input, opts.ok ?? [0]);
}

/** Read-only calls on the project's repository (rev-parse, ls-files): never writes its index. */
function projectGit(cwd: string, args: readonly string[], ok: readonly number[] = [0]): Promise<GitOutput> {
  return spawnGit(["-c", "core.fsmonitor=false", ...args], cwd, gitEnv({}), undefined, ok);
}

const text = (b: Buffer) => b.toString("utf8").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A lock this old in a private store was left by a git that crashed: no snapshot runs for minutes. */
const STALE_LOCK_MS = 10 * 60_000;

/** Retry while another session holds the store's index.lock (5 times, 100 ms backoff); then remove the lock only if it is stale. */
async function withLockRetry<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  let cleared = false;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof GitError) || !err.stderr.includes("index.lock")) throw err;
      if (attempt <= 5) {
        await sleep(100 * attempt);
        continue;
      }
      const lock = join(store.dir, "index.lock");
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (cleared || age < STALE_LOCK_MS) throw err;
      await rm(lock, { force: true });
      cleared = true;
    }
  }
}

// ---------------------------------------------------------------------------
// root and store

export type Root = { root: string; git: boolean };

/** The project root: the git top level when cwd is inside a work tree (not one rooted at the home directory), else cwd. */
export async function findRoot(cwd: string): Promise<Root> {
  const real = realpathSync.native(cwd);
  try {
    const out = await projectGit(real, ["rev-parse", "--show-toplevel"]);
    const top = realpathSync.native(text(out.stdout));
    if (top && top !== realpathSync.native(homedir())) return { root: top, git: true };
  } catch {
    // not a git work tree, or git is missing: a plain directory
  }
  return { root: real, git: false };
}

/** Refuse roots whose snapshot would copy far more than a project: the home directory, a file-system root, or a large directory outside git. */
const NON_GIT_LIMITS = { files: 20_000, bytes: 500 * 1024 * 1024 };

export async function refuseRoot(root: Root, exclude: readonly string[]): Promise<string | undefined> {
  if (root.root === parsePath(root.root).root) return `${root.root} is a file-system root`;
  if (root.git) return undefined;
  if (root.root === realpathSync.native(homedir())) return `${root.root} is the home directory`;
  const skip = new Set([...DEFAULT_EXCLUDES, ...exclude]);
  let files = 0;
  let bytes = 0;
  const stack = [root.root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (existsSync(join(p, ".git"))) continue; // nested repository: recorded as a gitlink only
        stack.push(p);
      } else {
        files++;
        if (e.isFile()) bytes += (await lstat(p).catch(() => ({ size: 0 }))).size;
        if (files > NON_GIT_LIMITS.files) return `${root.root} is not a git repository and has more than ${NON_GIT_LIMITS.files} files`;
        if (bytes > NON_GIT_LIMITS.bytes) return `${root.root} is not a git repository and holds more than ${NON_GIT_LIMITS.bytes / 1024 / 1024} MB`;
      }
    }
  }
  return undefined;
}

export function storeDir(base: string, root: string): string {
  return join(base, "stores", createHash("sha256").update(root).digest("hex").slice(0, 16));
}

/** Open (and on first use create) the store for a root. Rewrites the excludes and attributes each time, so config changes apply. */
export async function openStore(base: string, root: Root, exclude: readonly string[]): Promise<Store> {
  const dir = storeDir(base, root.root);
  const store: Store = { dir, root: root.root, git: root.git };
  if (!existsSync(join(dir, "HEAD"))) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await spawnGit(["init", "--bare", "--quiet", dir], dir, gitEnv({}), undefined, [0]);
  }
  await writeFile(join(dir, "ROOT"), `${root.root}\n`);
  await mkdir(join(dir, "info"), { recursive: true });
  // A git root keeps the project's own notion of content (.gitignore files, its info/exclude);
  // the default list only protects roots that are not git work trees.
  let projectExclude = "";
  if (root.git) {
    const common = await projectGit(root.root, ["rev-parse", "--git-common-dir"]).then((o) => resolve(root.root, text(o.stdout)), () => undefined);
    if (common) projectExclude = readFileIfExists(join(common, "info", "exclude"));
  }
  const patterns = [".git", ...(root.git ? [] : DEFAULT_EXCLUDES.filter((p) => p !== ".git")), ...exclude];
  await writeFile(join(dir, "info", "exclude"), `${patterns.join("\n")}\n${projectExclude}`);
  await writeFile(join(dir, "info", "attributes"), "* -text -filter -ident -working-tree-encoding !eol\n");
  await touch(join(dir, "LAST_USED"));
  return store;
}

function readFileIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function touch(path: string): Promise<void> {
  const now = new Date();
  await utimes(path, now, now).catch(() => writeFile(path, ""));
}

// ---------------------------------------------------------------------------
// checkpoints

export type CheckpointId = { kind: "run"; n: number } | { kind: "pre-undo"; k: number; afterRun: number };
export type Checkpoint = CheckpointId & { commit?: string; created?: number };

export const checkpointName = (c: CheckpointId) => (c.kind === "run" ? `run-${c.n}` : `pre-undo-${c.k}`);
export const refName = (session: string, c: CheckpointId) => (c.kind === "run" ? `refs/runs/${session}/${c.n}` : `refs/pre-undo/${session}/${c.k}`);
const orderOf = (c: CheckpointId): [number, number] => (c.kind === "run" ? [c.n, 0] : [c.afterRun, c.k]);
/** Checkpoints of a session in time order: run n, then the undos made after run n, then run n+1. */
function compareCheckpoints(a: CheckpointId, b: CheckpointId): number {
  const [x1, y1] = orderOf(a);
  const [x2, y2] = orderOf(b);
  return x1 - x2 || y1 - y2;
}

/** Session ids become ref and directory names; anything unusual is hashed. */
export function safeSession(id: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes("..") && !id.endsWith(".lock") ? id : createHash("sha256").update(id).digest("hex").slice(0, 32);
}

export type TreeResult = { tree: string; unreadable: string[] };

/** Stage the root in the private index and write its tree. Paths git cannot read are skipped and reported. */
export async function snapshotTree(store: Store): Promise<TreeResult> {
  return withLockRetry(store, async () => {
    const add = await runGit(store, ["add", "-A", "--ignore-errors"], { ok: [0, 1] });
    const unreadable = [...add.stderr.matchAll(/^error: unable to index file '(.*)'$/gm)].map((m) => m[1]!);
    if (add.code === 1 && unreadable.length === 0) throw new GitError("add", add);
    if (store.git) {
      // Files the project tracks although an ignore rule matches them are part of its content.
      const tracked = await projectGit(store.root, ["ls-files", "-z", "-c", "-i", "--exclude-standard"]);
      if (tracked.stdout.length) await runGit(store, ["add", "-f", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: tracked.stdout, ok: [0, 1] });
    }
    const tree = text((await runGit(store, ["write-tree"])).stdout);
    return { tree, unreadable };
  });
}

/** Snapshot the root and keep it under the checkpoint's ref. */
export async function createCheckpoint(store: Store, session: string, c: CheckpointId): Promise<{ commit: string; unreadable: string[] }> {
  const { tree, unreadable } = await snapshotTree(store);
  const subject = c.kind === "run" ? `pi-edit-guard session ${session} run ${c.n}` : `pi-edit-guard session ${session} pre-undo ${c.k} after run ${c.afterRun}`;
  const commit = text((await runGit(store, ["commit-tree", "--no-gpg-sign", tree, "-m", subject])).stdout);
  await runGit(store, ["update-ref", refName(session, c), commit]);
  await touch(join(store.dir, "LAST_USED"));
  return { commit, unreadable };
}

/** Checkpoints of a session: refs, plus runs whose snapshot failed but that journaled files. */
export async function listCheckpoints(store: Store, session: string): Promise<Checkpoint[]> {
  const out = await runGit(store, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(creatordate:unix)%00%(subject)", `refs/runs/${session}/`, `refs/pre-undo/${session}/`]);
  const found = new Map<string, Checkpoint>();
  for (const line of text(out.stdout).split("\n")) {
    if (!line) continue;
    const [, commit, created, subject] = line.split("\0");
    const run = subject?.match(/ run (\d+)$/);
    const undo = subject?.match(/ pre-undo (\d+) after run (\d+)$/);
    const c: CheckpointId | undefined = undo ? { kind: "pre-undo", k: Number(undo[1]), afterRun: Number(undo[2]) } : run ? { kind: "run", n: Number(run[1]) } : undefined;
    if (c) found.set(checkpointName(c), { ...c, commit, created: Number(created) * 1000 });
  }
  for (const m of await readManifests(store, session)) if (!found.has(checkpointName(m.checkpoint))) found.set(checkpointName(m.checkpoint), { ...m.checkpoint });
  return [...found.values()].sort(compareCheckpoints);
}

/** The paths among `rels` that are a file or symlink in the checkpoint's tree. */
async function treeHas(store: Store, commit: string, rels: readonly string[]): Promise<Set<string>> {
  const asked = rels.filter((r) => !r.includes("\n")); // the batch protocol is line-based; such a path counts as absent, so it is journaled
  if (!asked.length) return new Set();
  const out = await runGit(store, ["cat-file", "--batch-check=%(objecttype)"], { input: asked.map((r) => `${commit}:${r}\n`).join("") });
  const lines = out.stdout.toString("utf8").split("\n");
  return new Set(asked.filter((_, i) => lines[i] === "blob"));
}

// ---------------------------------------------------------------------------
// journal

export type JournalEntry =
  | { path: string; kind: "absent" }
  | { path: string; kind: "file"; mode: number; file: string }
  | { path: string; kind: "symlink"; target: string };

export type Manifest = { checkpoint: CheckpointId; entries: JournalEntry[] };

const journalDir = (store: Store, session: string, c: CheckpointId) => join(store.dir, "journal", session, checkpointName(c));

async function readManifests(store: Store, session: string): Promise<Manifest[]> {
  const base = join(store.dir, "journal", session);
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return [];
  }
  const out: Manifest[] = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(await readFile(join(base, name, "manifest.json"), "utf8")) as Manifest);
    } catch {
      // an unreadable manifest is a missing journal: its paths are not restored
    }
  }
  return out;
}

/** Whether the target of a write is in the checkpoint's tree; when it is not, journal it. */
export async function needsJournal(store: Store, commit: string | undefined, abs: string): Promise<boolean> {
  const rel = insideRoot(store.root, abs);
  if (!rel || !commit) return true;
  return !(await treeHas(store, commit, [rel])).has(rel);
}

/**
 * Record the current state of `abs` in the checkpoint's journal, once per
 * checkpoint and path. Callers serialize calls per checkpoint.
 */
export async function journal(store: Store, session: string, c: CheckpointId, abs: string): Promise<void> {
  const dir = journalDir(store, session, c);
  const manifestPath = join(dir, "manifest.json");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  } catch {
    manifest = { checkpoint: c, entries: [] };
  }
  if (manifest.entries.some((e) => e.path === abs)) return;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let entry: JournalEntry;
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) entry = { path: abs, kind: "symlink", target: await readlink(abs) };
    else if (st.isFile()) {
      const file = `${manifest.entries.length}.bin`;
      await copyFile(abs, join(dir, file));
      entry = { path: abs, kind: "file", mode: st.mode & 0o7777, file };
    } else return; // a directory: the write tool cannot replace it
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    entry = { path: abs, kind: "absent" };
  }
  manifest.entries.push(entry);
  const tmp = `${manifestPath}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(manifest));
  await rename(tmp, manifestPath);
}

// ---------------------------------------------------------------------------
// restore

export type Change =
  | { op: "delete"; path: string }
  | { op: "blob"; path: string; oid: string; mode: string }
  | { op: "copy"; path: string; src: string; mode: number }
  | { op: "link"; path: string; target: string };

export type Plan = {
  changes: Change[];
  /** Paths added since the checkpoint that its ignore rules matched: their state then is unknown, so they stay. */
  kept: string[];
  /** Nested repositories (gitlinks): not covered. */
  skipped: string[];
  /** Paths the restore changes that the pre-undo tree does not hold, to journal before applying. */
  outsideTree: string[];
};

type RawDiff = { srcMode: string; dstMode: string; srcOid: string; status: string; rel: string };

function parseRawDiff(out: Buffer): RawDiff[] {
  const parts = out.toString("utf8").split("\0");
  const items: RawDiff[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!;
    if (!meta.startsWith(":")) continue;
    const [srcMode, dstMode, srcOid, , status] = meta.slice(1).split(" ");
    items.push({ srcMode: srcMode!, dstMode: dstMode!, srcOid: srcOid!, status: status!, rel: parts[i + 1]! });
  }
  return items;
}

/**
 * Paths among `rels` (inside the root, not in the checkpoint's tree) that
 * were outside the checkpoint's domain: under one of its nested repositories,
 * or matched by its ignore rules (its .gitignore files, the store excludes,
 * the user's excludes file). Any other such path did not exist then.
 */
async function outsideDomain(store: Store, commit: string, rels: readonly string[]): Promise<Set<string>> {
  if (!rels.length) return new Set();
  const gitlinks: string[] = [];
  const ignoreFiles: { oid: string; rel: string }[] = [];
  for (const rec of (await runGit(store, ["ls-tree", "-r", "-z", "--full-tree", commit])).stdout.toString("utf8").split("\0")) {
    const m = rec.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s);
    if (!m) continue;
    if (m[1] === "160000") gitlinks.push(m[4]!);
    else if (m[2] === "blob" && (m[4] === ".gitignore" || m[4]!.endsWith("/.gitignore"))) ignoreFiles.push({ oid: m[3]!, rel: m[4]! });
  }
  const outside = new Set(rels.filter((r) => gitlinks.some((g) => r.startsWith(`${g}/`))));
  const rest = rels.filter((r) => !outside.has(r));
  if (!rest.length) return outside;
  const shadow = await mkdtemp(join(tmpdir(), "pi-edit-guard-ignore-"));
  try {
    const blobs = await readBlobs(store, ignoreFiles.map((f) => f.oid));
    for (const f of ignoreFiles) {
      await mkdir(dirname(join(shadow, f.rel)), { recursive: true });
      await writeFile(join(shadow, f.rel), blobs.get(f.oid)!);
    }
    const out = await runGit({ ...store, root: shadow }, ["check-ignore", "--no-index", "-z", "--stdin"], { input: rest.join("\0"), ok: [0, 1] });
    for (const r of out.stdout.toString("utf8").split("\0")) if (r) outside.add(r);
  } finally {
    await rm(shadow, { recursive: true, force: true });
  }
  return outside;
}

const exists = (path: string) => lstat(path).then(() => true, () => false);

/** The change a journal record asks for, or undefined when the path is already in that state. */
async function fromRecord(path: string, entry: JournalEntry, dir: string): Promise<Change | undefined> {
  if (entry.kind === "absent") return (await exists(path)) ? { op: "delete", path } : undefined;
  if (entry.kind === "symlink") return (await readlink(path).catch(() => undefined)) === entry.target ? undefined : { op: "link", path, target: entry.target };
  const src = join(dir, entry.file);
  try {
    const [now, then, st] = await Promise.all([readFile(path), readFile(src), lstat(path)]);
    if (st.isFile() && (st.mode & 0o7777) === entry.mode && now.equals(then)) return undefined;
  } catch {
    // missing or unreadable: restore it
  }
  return { op: "copy", path, src, mode: entry.mode };
}

/** rel \u2192 { mode, oid } of every entry of a checkpoint's tree. */
async function listTree(store: Store, commit: string): Promise<Map<string, { mode: string; oid: string }>> {
  const out = new Map<string, { mode: string; oid: string }>();
  for (const rec of (await runGit(store, ["ls-tree", "-r", "-z", "--full-tree", commit])).stdout.toString("utf8").split("\0")) {
    const m = rec.match(/^(\d+) \w+ ([0-9a-f]+)\t(.*)$/s);
    if (m) out.set(m[3]!, { mode: m[1]!, oid: m[2]! });
  }
  return out;
}

/**
 * The changes that bring the files back to checkpoint `target`, given `cur`,
 * a checkpoint of the state now.
 *
 *   in the target's tree                     the tree is the record
 *   inside the root, in the target's domain  not in its tree: it did not exist then
 *   inside the root, outside its domain      the earliest record at or after the target:
 *                                            a journal entry, or a later checkpoint's
 *                                            tree once the path entered the domain
 *   outside the root                         the earliest journal entry, if any
 */
async function planRestore(store: Store, session: string, target: Checkpoint, cur: string): Promise<Plan> {
  if (!target.commit) throw new Error(`${checkpointName(target)} has no snapshot`);
  const diff = parseRawDiff((await runGit(store, ["diff-tree", "-r", "-z", "--no-renames", "--no-abbrev", "--raw", target.commit, cur])).stdout);
  const later = (await listCheckpoints(store, session)).filter((c) => c.commit && compareCheckpoints(c, target) > 0);

  const records = new Map<string, { entry: JournalEntry; dir: string; checkpoint: CheckpointId }>();
  const manifests = (await readManifests(store, session)).filter((m) => compareCheckpoints(m.checkpoint, target) >= 0).sort((a, b) => compareCheckpoints(a.checkpoint, b.checkpoint));
  for (const m of manifests) for (const entry of m.entries) if (!records.has(entry.path)) records.set(entry.path, { entry, dir: journalDir(store, session, m.checkpoint), checkpoint: m.checkpoint });
  const recordRel = new Map<string, string>();
  for (const p of records.keys()) {
    const rel = insideRoot(store.root, p);
    if (rel !== undefined) recordRel.set(p, rel);
  }
  const inTarget = await treeHas(store, target.commit, [...recordRel.values()]);

  const changes: Change[] = [];
  const skipped: string[] = [];
  const outsideTree: string[] = [];
  const kept: string[] = [];
  const candidates = new Set<string>();
  for (const d of diff) {
    if (d.srcMode === "160000" || d.dstMode === "160000") skipped.push(d.rel);
    else if (d.status === "A") candidates.add(d.rel);
    else {
      const path = join(store.root, d.rel);
      if (d.status === "D") outsideTree.push(path);
      changes.push({ op: "blob", path, oid: d.srcOid, mode: d.srcMode });
    }
  }
  for (const rel of recordRel.values()) if (!inTarget.has(rel)) candidates.add(rel);
  const outside = await outsideDomain(store, target.commit, [...candidates]);
  const inCur = await treeHas(store, cur, [...candidates]);

  // The first later checkpoint whose tree holds an out-of-domain path recorded its state then.
  const treeRecord = new Map<string, Checkpoint>();
  let open = [...candidates].filter((r) => outside.has(r));
  for (const c of later) {
    if (!open.length) break;
    const has = await treeHas(store, c.commit!, open);
    for (const r of has) treeRecord.set(r, c);
    open = open.filter((r) => !has.has(r));
  }
  const listings = new Map<string, Promise<Map<string, { mode: string; oid: string }>>>();
  const entryIn = async (commit: string, rel: string) => {
    if (!listings.has(commit)) listings.set(commit, listTree(store, commit));
    return (await listings.get(commit)!).get(rel);
  };

  for (const rel of candidates) {
    const path = join(store.root, rel);
    let change: Change | undefined;
    if (!outside.has(rel)) change = (await exists(path)) ? { op: "delete", path } : undefined;
    else {
      const record = records.get(path);
      const tree = treeRecord.get(rel);
      if (record && (!tree || compareCheckpoints(record.checkpoint, tree) < 0)) change = await fromRecord(path, record.entry, record.dir);
      else if (tree) {
        const then = (await entryIn(tree.commit!, rel))!;
        const now = inCur.has(rel) ? await entryIn(cur, rel) : undefined;
        if (!now || now.oid !== then.oid || now.mode !== then.mode) change = { op: "blob", path, oid: then.oid, mode: then.mode };
      }
      if (!change && (await exists(path))) kept.push(rel);
    }
    if (!change) continue;
    changes.push(change);
    if (!inCur.has(rel)) outsideTree.push(path);
  }
  for (const [path, record] of records) {
    if (recordRel.has(path)) continue;
    const change = await fromRecord(path, record.entry, record.dir);
    if (!change) continue;
    changes.push(change);
    outsideTree.push(path);
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { changes, kept, skipped, outsideTree };
}

/**
 * A restore is itself a mutation: snapshot the state now as pre-undo
 * checkpoint `pre`, plan the restore against it, and journal what the plan
 * changes outside that snapshot's tree, so `/undo pre-undo-<k>` reverses it
 * exactly.
 */
export async function prepareRestore(store: Store, session: string, target: Checkpoint, pre: CheckpointId): Promise<{ plan: Plan; preUndo: Checkpoint }> {
  const { commit } = await createCheckpoint(store, session, pre);
  try {
    const plan = await planRestore(store, session, target, commit);
    for (const path of plan.outsideTree) await journal(store, session, pre, path);
    return { plan, preUndo: { ...pre, commit } };
  } catch (err) {
    await dropCheckpoint(store, session, pre);
    throw err;
  }
}

async function readBlobs(store: Store, oids: readonly string[]): Promise<Map<string, Buffer>> {
  const unique = [...new Set(oids)];
  const blobs = new Map<string, Buffer>();
  if (!unique.length) return blobs;
  const out = (await runGit(store, ["cat-file", "--batch"], { input: unique.map((o) => `${o}\n`).join("") })).stdout;
  let pos = 0;
  for (const oid of unique) {
    const nl = out.indexOf(10, pos);
    const header = out.subarray(pos, nl).toString("utf8").split(" ");
    if (header[1] !== "blob") throw new Error(`object ${oid} is missing from the store`);
    const size = Number(header[2]);
    blobs.set(oid, out.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return blobs;
}

/** Make the parent directories of `path` real directories, never following a symlink inside the root. */
async function ensureParent(root: string, path: string): Promise<void> {
  const rel = insideRoot(root, path);
  if (rel === undefined) {
    await mkdir(dirname(path), { recursive: true });
    return;
  }
  let dir = root;
  for (const part of rel.split("/").slice(0, -1)) {
    dir = join(dir, part);
    const st = await lstat(dir).catch(() => undefined);
    if (st?.isDirectory()) continue;
    if (st) await unlink(dir);
    await mkdir(dir);
  }
}

/** An empty directory where a file goes is removed (git does not record empty directories); one with content is an error. */
async function clearDirectory(path: string): Promise<void> {
  const st = await lstat(path).catch(() => undefined);
  if (st?.isDirectory()) await rmdir(path).catch(() => Promise.reject(new Error("a directory with other content is in the way")));
}

async function replaceFile(path: string, data: Buffer | { copyFrom: string }, mode: (current: number) => number): Promise<void> {
  await clearDirectory(path);
  const tmp = join(dirname(path), `.${parsePath(path).base}.pi-edit-guard-${randomBytes(4).toString("hex")}`);
  try {
    if (Buffer.isBuffer(data)) await writeFile(tmp, data);
    else await copyFile(data.copyFrom, tmp);
    const prev = await lstat(path).catch(() => undefined);
    const base = prev?.isFile() ? prev.mode & 0o777 : (await stat(tmp)).mode & 0o777;
    await chmod(tmp, mode(base));
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export type Applied = { deleted: number; written: number; errors: string[] };

/** Apply a plan: deletions first (and the directories they leave empty), then writes. */
export async function applyRestore(store: Store, plan: Plan): Promise<Applied> {
  const blobs = await readBlobs(store, plan.changes.flatMap((c) => (c.op === "blob" ? [c.oid] : [])));
  for (const c of plan.changes) if (c.op === "copy" && !existsSync(c.src)) throw new Error(`journal file ${c.src} is missing`);
  const errors: string[] = [];
  let deleted = 0;
  let written = 0;
  // Deepest first, pruning the directories a deletion leaves empty, so a path that became a directory is gone before its turn.
  const deletions = plan.changes.filter((c) => c.op === "delete").sort((a, b) => b.path.split(sep).length - a.path.split(sep).length || (a.path < b.path ? 1 : -1));
  for (const c of deletions) {
    try {
      const st = await lstat(c.path).catch(() => undefined);
      if (!st) continue;
      if (st.isDirectory()) await rmdir(c.path).catch(() => Promise.reject(new Error("a directory with other content is in the way")));
      else await unlink(c.path);
      deleted++;
      for (let dir = dirname(c.path); insideRoot(store.root, dir); dir = dirname(dir)) {
        if (!(await rmdir(dir).then(() => true, () => false))) break;
      }
    } catch (err) {
      errors.push(`${c.path}: ${(err as Error).message}`);
    }
  }
  for (const c of plan.changes) {
    if (c.op === "delete") continue;
    try {
      await ensureParent(store.root, c.path);
      if (c.op === "blob" && c.mode === "120000") await replaceLink(c.path, blobs.get(c.oid)!.toString("utf8"));
      else if (c.op === "blob") {
        const exec = c.mode === "100755";
        await replaceFile(c.path, blobs.get(c.oid)!, (base) => (exec ? base | ((base & 0o444) >> 2) : base & ~0o111));
      } else if (c.op === "copy") await replaceFile(c.path, { copyFrom: c.src }, () => c.mode);
      else await replaceLink(c.path, c.target);
      written++;
    } catch (err) {
      errors.push(`${c.path}: ${(err as Error).message}`);
    }
  }
  return { deleted, written, errors };
}

async function replaceLink(path: string, target: string): Promise<void> {
  await clearDirectory(path);
  if (await exists(path)) await unlink(path);
  await symlink(target, path);
}

/** Drop a checkpoint: its ref and its journal. */
export async function dropCheckpoint(store: Store, session: string, c: CheckpointId): Promise<void> {
  await runGit(store, ["update-ref", "-d", refName(session, c)], { ok: [0, 1] });
  await rm(journalDir(store, session, c), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// retention

/**
 * Keep the newest `keep` run checkpoints and the newest `keep` pre-undo
 * checkpoints of a session; drop the refs of the rest, then free their
 * objects: `repack -a -d` rewrites the packs without unreachable objects
 * (objects in the private index, which another session may have just
 * written, count as reachable), and `prune` removes unreachable loose objects
 * older than an hour (a commit another session has written but not yet
 * referenced is younger). A dropped checkpoint's journal stays while a kept
 * checkpoint is older than it: restoring that one needs the records made
 * after it. Packs are also consolidated once there are many: every snapshot
 * that adds content writes one.
 */
export async function retain(store: Store, session: string, keep: number): Promise<number> {
  const all = await listCheckpoints(store, session);
  const runs = all.filter((c) => c.kind === "run").reverse();
  const undos = all.filter((c) => c.kind === "pre-undo").reverse();
  const kept = [...runs.slice(0, keep), ...undos.slice(0, keep)].sort(compareCheckpoints);
  const oldestKept = kept[0];
  const drop = [...runs.slice(keep), ...undos.slice(keep)];
  let dropped = 0;
  for (const c of drop) {
    if (c.commit) {
      await runGit(store, ["update-ref", "-d", refName(session, c)]);
      dropped++;
    }
    if (!oldestKept || compareCheckpoints(c, oldestKept) < 0) await rm(journalDir(store, session, c), { recursive: true, force: true });
  }
  const packs = (await readdir(join(store.dir, "objects", "pack")).catch(() => [] as string[])).filter((f) => f.endsWith(".pack")).length;
  if (dropped || packs > 25) {
    await runGit(store, ["repack", "-a", "-d", "-q"]);
    await runGit(store, ["prune", "--expire=1.hour.ago"]);
  }
  return dropped;
}

/**
 * Delete stores not used for `maxAgeDays`, and stores whose root was deleted
 * (its parent still exists, so an unmounted volume does not count).
 */
export async function sweepStores(base: string, maxAgeDays: number, keepDir: string, now = Date.now()): Promise<string[]> {
  const dir = join(base, "stores");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const store = join(dir, name);
    if (!/^[0-9a-f]{16}$/.test(name) || store === keepDir) continue;
    const used = await stat(join(store, "LAST_USED")).then((s) => s.mtimeMs, () => undefined);
    const root = readFileIfExists(join(store, "ROOT")).trim();
    const gone = root !== "" && !existsSync(root) && existsSync(dirname(root));
    if ((used !== undefined && now - used > maxAgeDays * 86_400_000) || gone) {
      await rm(store, { recursive: true, force: true });
      removed.push(store);
    }
  }
  return removed;
}

/** For display: a path relative to the root when inside it. */
function shown(store: Store, path: string): string {
  return insideRoot(store.root, path) ?? path;
}

/** The restore preview: counts and the first `max` paths. */
export function describePlan(store: Store, plan: Plan, max = 20): string {
  const deletes = plan.changes.filter((c) => c.op === "delete").length;
  const lines = [`${plan.changes.length} paths change: ${plan.changes.length - deletes} restored, ${deletes} deleted.`];
  for (const c of plan.changes.slice(0, max)) lines.push(`  ${c.op === "delete" ? "delete " : "restore"} ${shown(store, c.path)}`);
  if (plan.changes.length > max) lines.push(`  … ${plan.changes.length - max} more`);
  if (plan.kept.length) lines.push(`${plan.kept.length} paths created since then match an ignore rule of that state and stay.`);
  if (plan.skipped.length) lines.push(`${plan.skipped.length} nested repositories are not covered and stay.`);
  return lines.join("\n");
}

/** How many paths differ between a checkpoint and a tree of the state now. */
export async function countDiff(store: Store, commit: string, tree: string): Promise<number> {
  const out = await runGit(store, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", commit, tree]);
  return out.stdout.toString("utf8").split("\0").filter(Boolean).length;
}
