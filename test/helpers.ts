/** Test helpers: temp trees, a faithful tree reader, and plain git on test projects. */
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function tempDir(prefix = "peg-"): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

export function cleanup(...dirs: string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

export type Node = { kind: "file"; content: string; exec: boolean } | { kind: "link"; target: string };

/** Every file and symlink under `root` (relative path → node), skipping `.git` and the names in `skip`. */
export function readTree(root: string, skip: readonly string[] = []): Map<string, Node> {
  const out = new Map<string, Node>();
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.name === ".git" || skip.includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = join(root, r);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out.set(r, { kind: "link", target: readlinkSync(p) });
      else if (st.isDirectory()) walk(r);
      else out.set(r, { kind: "file", content: readFileSync(p).toString("base64"), exec: (st.mode & 0o100) !== 0 });
    }
  };
  walk("");
  return out;
}

export function writeFile(root: string, rel: string, content: string | Buffer, exec = false): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  rmSync(p, { force: true });
  writeFileSync(p, content);
  chmodSync(p, exec ? 0o755 : 0o644);
}

export function writeLink(root: string, rel: string, target: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  rmSync(p, { force: true });
  symlinkSync(target, p);
}

/** git on a test project, isolated from the user's config. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function initRepo(root: string): void {
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
}

/** What a project's own git state looks like, to prove the guard never touched it. */
export function projectGitState(root: string): { index: string; head: string; stash: string; refs: string } {
  return {
    index: readFileSync(join(root, ".git", "index")).toString("base64"),
    head: git(root, "rev-parse", "HEAD"),
    stash: git(root, "stash", "list"),
    refs: git(root, "for-each-ref"),
  };
}

// ---- transcripts: real π session entries, built the way the agent loop appends them

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export function userMessage(sm: SessionManager, text: string): string {
  return sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
}

/** An assistant message with one tool call per entry of `calls`; returns its entry id. */
export function assistantCalls(sm: SessionManager, calls: { id: string; name: string; args: ToolCall["arguments"] }[]): string {
  return sm.appendMessage(fauxAssistantMessage(calls.map((c) => fauxToolCall(c.name, c.args, { id: c.id })), { stopReason: "toolUse" }));
}

export function toolResult(sm: SessionManager, id: string, name: string, text: string, isError = false): string {
  return sm.appendMessage({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: Date.now() });
}

export function sameTree(a: Map<string, Node>, b: Map<string, Node>): string | undefined {
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w) return `missing ${k}`;
    if (JSON.stringify(v) !== JSON.stringify(w)) return `differs ${k}: ${JSON.stringify(v).slice(0, 80)} vs ${JSON.stringify(w).slice(0, 80)}`;
  }
  for (const k of b.keys()) if (!a.has(k)) return `extra ${k}`;
  return undefined;
}
