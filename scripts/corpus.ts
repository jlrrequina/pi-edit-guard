/**
 * Snapshot, mutate and restore real repositories, and measure the overhead.
 *
 *   node scripts/corpus.ts [--dir <dir>] [--only name,name] [--summary <file>]
 *
 * For each target: snapshot run 1 (first snapshot, cold store), snapshot run 2
 * with nothing changed (second snapshot), then about 100 changes during run 2
 * (shell-style modify, delete, chmod and add; a write-tool write to a path the
 * project ignores and to files outside the root, both journaled), then /undo of
 * run 2. The files must be exactly as before (content, mode, symlinks, the
 * ignored and outside files), the project's .git index, HEAD, refs and stash
 * unchanged. Also measured: the freshness check of one write to a file < 1 MB.
 * Targets: public repositories across ecosystems (shallow clones), a plain
 * directory (a repository without .git) and a generated 10,000-file tree.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { checkWrite, observeBefore } from "../guard/freshness.ts";
import { applyRestore, createCheckpoint, findRoot, journal, needsJournal, openStore, prepareRestore, refuseRoot, runGit } from "../guard/snapshot.ts";
import type { Checkpoint } from "../guard/snapshot.ts";
import type { Observation } from "../guard/state.ts";

const REPOS = [
  { name: "express", url: "https://github.com/expressjs/express", lang: "JavaScript" },
  { name: "flask", url: "https://github.com/pallets/flask", lang: "Python" },
  { name: "ripgrep", url: "https://github.com/BurntSushi/ripgrep", lang: "Rust" },
  { name: "cobra", url: "https://github.com/spf13/cobra", lang: "Go" },
  { name: "git", url: "https://github.com/git/git", lang: "C" },
  { name: "rails", url: "https://github.com/rails/rails", lang: "Ruby" },
  { name: "django", url: "https://github.com/django/django", lang: "Python" },
  { name: "react", url: "https://github.com/facebook/react", lang: "JavaScript" },
  { name: "symfony", url: "https://github.com/symfony/symfony", lang: "PHP" },
];

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const dir = arg("dir") ?? join(tmpdir(), "pi-edit-guard-corpus");
const only = arg("only")?.split(",");
const summary = arg("summary");
mkdirSync(dir, { recursive: true });

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "c", GIT_AUTHOR_EMAIL: "c@c", GIT_COMMITTER_NAME: "c", GIT_COMMITTER_EMAIL: "c@c" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", maxBuffer: 1 << 28 });

/** A deterministic random sequence per target. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

type Entry = { kind: "file"; sha: string; exec: boolean; size: number } | { kind: "link"; target: string };

/** Every file and symlink under root except .git, with a content hash. */
function manifest(root: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = join(root, r);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out.set(r, { kind: "link", target: readlinkSync(p) });
      else if (st.isDirectory()) walk(r);
      else out.set(r, { kind: "file", sha: createHash("sha256").update(readFileSync(p)).digest("hex"), exec: (st.mode & 0o100) !== 0, size: st.size });
    }
  };
  walk("");
  return out;
}

function diffManifests(a: Map<string, Entry>, b: Map<string, Entry>): string[] {
  const out: string[] = [];
  for (const [k, v] of a) if (JSON.stringify(v) !== JSON.stringify(b.get(k))) out.push(b.has(k) ? `changed ${k}` : `missing ${k}`);
  for (const k of b.keys()) if (!a.has(k)) out.push(`extra ${k}`);
  return out;
}

function projectState(root: string): string {
  return [readFileSync(join(root, ".git", "index")).toString("base64"), git(root, "rev-parse", "HEAD"), git(root, "stash", "list"), git(root, "for-each-ref")].join("\n");
}

type Row = { target: string; lang: string; files: number; first?: number; second?: number; restore?: number; changes?: number; freshness?: number; storeMb?: number; exact?: boolean; gitUntouched?: boolean; note?: string };

const ms = (start: number) => Math.round(performance.now() - start);

async function exercise(target: string, lang: string, root: string, seed: number): Promise<Row> {
  const isGit = existsSync(join(root, ".git"));
  const before = manifest(root);
  const row: Row = { target, lang, files: before.size };
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "peg-corpus-store-")));
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "peg-corpus-out-")));
  try {
    writeFileSync(join(outside, "notes.txt"), "outside the root\n");
    const outsideBefore = manifest(outside);
    const gitBefore = isGit ? projectState(root) : "";
    const r = await findRoot(root);
    const refused = await refuseRoot(r, []);
    if (refused) return { ...row, note: `refused: ${refused}` };
    const store = await openStore(base, r, []);

    let t = performance.now();
    await createCheckpoint(store, "corpus", { kind: "run", n: 1 });
    row.first = ms(t);
    t = performance.now();
    const run2: Checkpoint = { kind: "run", n: 2, commit: (await createCheckpoint(store, "corpus", { kind: "run", n: 2 })).commit };
    row.second = ms(t);
    const write = async (abs: string) => {
      if (await needsJournal(store, run2.commit, abs)) await journal(store, "corpus", run2, abs);
    };

    // A write tool writes a path the project ignores, and files outside the root (journaled) ...
    const candidates = [".env", "node_modules/edit-guard.js", "target/edit-guard", "build/edit-guard", "dist/edit-guard", "vendor/edit-guard", "tmp/edit-guard", "edit-guard.log", ".venv/edit-guard", "__pycache__/edit-guard.pyc"];
    const ignored = (await runGit(store, ["check-ignore", "--no-index", "-z", "--stdin"], { input: candidates.join("\0"), ok: [0, 1] })).stdout.toString().split("\0").filter(Boolean);
    const writes = [...(ignored[0] ? [join(root, ignored[0])] : []), join(outside, "notes.txt"), join(outside, "created.txt")];
    for (const abs of writes) {
      await write(abs);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, "written by a write tool\n");
    }
    if (!ignored[0]) row.note = "no ignored path to write";

    // ... then ~100 shell-style changes (they may hit .gitignore files too)
    const random = rng(seed);
    const files = [...before.entries()].filter(([, e]) => e.kind === "file").map(([p]) => p);
    const picked = new Set<string>();
    while (picked.size < Math.min(90, files.length)) picked.add(files[Math.floor(random() * files.length)]!);
    const list = [...picked];
    list.slice(0, 60).forEach((p, i) => appendFileSync(join(root, p), `\nedit-guard corpus change ${i}\n`));
    list.slice(60, 80).forEach((p) => unlinkSync(join(root, p)));
    list.slice(80, 90).forEach((p) => chmodSync(join(root, p), statSync(join(root, p)).mode ^ 0o111));
    for (let i = 0; i < 10; i++) {
      const p = join(root, dirname(list[i % list.length]!), `edit-guard-corpus-${i}.txt`);
      writeFileSync(p, `added ${i}\n`);
    }

    t = performance.now();
    const { plan } = await prepareRestore(store, "corpus", run2, { kind: "pre-undo", k: 1, afterRun: 2 });
    const applied = await applyRestore(store, plan);
    row.restore = ms(t);
    row.changes = plan.changes.length;
    const problems = [...applied.errors, ...diffManifests(before, manifest(root)), ...diffManifests(outsideBefore, manifest(outside)).map((d) => `outside: ${d}`)];
    row.exact = problems.length === 0;
    if (problems.length) row.note = `${problems.length} differences: ${problems.slice(0, 3).join("; ")}`;
    row.gitUntouched = isGit ? projectState(root) === gitBefore : undefined;

    // freshness: one check of a write to a file < 1 MB (median-sized), averaged
    const sized = [...before.entries()].filter((e): e is [string, Extract<Entry, { kind: "file" }>] => e[1].kind === "file" && e[1].size < 1 << 20).sort((a, b) => a[1].size - b[1].size);
    const probe = sized[Math.floor(sized.length / 2)];
    if (probe && existsSync(join(root, probe[0]))) {
      const seen = (await observeBefore(join(root, probe[0])))!;
      const obs = new Map<string, Observation>([[seen.key, { hash: seen.hash, seq: 1, toolCallId: "t" }]]);
      const n = 200;
      t = performance.now();
      for (let i = 0; i < n; i++) if (!(await checkWrite(obs, join(root, probe[0]), probe[0])).allow) throw new Error("freshness check blocked an unchanged file");
      row.freshness = Math.round(((performance.now() - t) / n) * 1000) / 1000;
    }
    row.storeMb = Math.round(Number(execFileSync("du", ["-sk", store.dir], { encoding: "utf8" }).split("\t")[0]) / 102.4) / 10;
    return row;
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

function synthetic(root: string, files: number): void {
  const random = rng(42);
  for (let i = 0; i < files; i++) {
    const p = join(root, `pkg${i % 100}`, `mod${Math.floor(i / 100) % 10}`, `file${i}.ts`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `export const v${i} = ${random()};\n`.repeat(1 + Math.floor(random() * 60)));
  }
}

const rows: Row[] = [];
const targets: { name: string; lang: string; prepare: () => string }[] = [
  ...REPOS.map((r) => ({
    name: r.name,
    lang: r.lang,
    prepare: () => {
      const p = join(dir, r.name);
      if (!existsSync(join(p, ".git"))) execFileSync("git", ["clone", "--quiet", "--depth", "1", "--single-branch", "--no-tags", r.url, p], { env: ENV, stdio: "inherit" });
      else git(p, "checkout", "--quiet", "--force", "HEAD");
      git(p, "clean", "-fdxq");
      return p;
    },
  })),
  {
    name: "flask (plain directory)",
    lang: "Python",
    prepare: () => {
      const p = join(dir, "flask-plain");
      rmSync(p, { recursive: true, force: true });
      cpSync(join(dir, "flask"), p, { recursive: true, filter: (src) => !src.split(/[\\/]/).includes(".git") });
      return p;
    },
  },
  ...[true, false].map((withGit) => ({
    name: `generated 10,000 files${withGit ? " (git)" : " (plain)"}`,
    lang: "-",
    prepare: () => {
      const p = join(dir, withGit ? "generated-git" : "generated-plain");
      rmSync(p, { recursive: true, force: true });
      mkdirSync(p);
      synthetic(p, 10_000);
      if (withGit) {
        git(p, "init", "-q", "-b", "main");
        git(p, "add", "-A");
        git(p, "commit", "-q", "-m", "generated");
      }
      return p;
    },
  })),
];

let seed = 1;
for (const t of targets) {
  if (only && !only.some((o) => t.name.startsWith(o))) continue;
  try {
    const root = realpathSync.native(t.prepare());
    const row = await exercise(t.name, t.lang, root, seed++);
    rows.push(row);
    console.log(JSON.stringify(row));
  } catch (err) {
    rows.push({ target: t.name, lang: t.lang, files: 0, exact: false, note: `error: ${(err as Error).message.split("\n")[0]}` });
    console.log(JSON.stringify(rows.at(-1)));
  }
}

const table = [
  "| target | language | files | first snapshot | second snapshot | restore (paths) | freshness check | store | exact | .git untouched |",
  "|---|---|--:|--:|--:|--:|--:|--:|:-:|:-:|",
  ...rows.map((r) =>
    `| ${r.target} | ${r.lang} | ${r.files} | ${r.first ?? "-"} ms | ${r.second ?? "-"} ms | ${r.restore ?? "-"} ms (${r.changes ?? "-"}) | ${r.freshness ?? "-"} ms | ${r.storeMb ?? "-"} MB | ${r.exact ? "yes" : "NO"} | ${r.gitUntouched === undefined ? "n/a" : r.gitUntouched ? "yes" : "NO"} |`,
  ),
  ...rows.filter((r) => r.note).map((r) => `\n- ${r.target}: ${r.note}`),
].join("\n");
console.log(`\n${table}`);
if (summary) appendFileSync(summary, `## Public repositories\n\n${table}\n`);
if (rows.some((r) => !r.exact || r.gitUntouched === false)) process.exit(1);
