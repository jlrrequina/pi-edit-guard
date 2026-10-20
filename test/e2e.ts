/**
 * Live smoke test (§13.5): a real `pi -p` with a real model, in a temp git
 * repository, with only this extension loaded. Opt-in: it needs credentials
 * and spends tokens.
 *
 *   PI_EDIT_GUARD_E2E_MODEL=anthropic/claude-haiku-4-5 npm run e2e
 *
 * Without the variable, π's default model is used. Sessions go to a temp
 * directory; the private store created under the agent directory for the
 * temp root is deleted at the end.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runGit, storeDir } from "../guard/snapshot.ts";
import { OBSERVATION_TYPE } from "../guard/state.ts";
import { cleanup, initRepo, projectGitState, tempDir, writeFile } from "./helpers.ts";

const extension = resolve(import.meta.dirname, "..", "index.ts");
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const model = process.env.PI_EDIT_GUARD_E2E_MODEL;

type Entry = { type: string; customType?: string; data?: any; message?: { role: string; content: { type: string; text?: string }[] } };

function pi(cwd: string, sessionDir: string, session: string, prompt: string): { status: number | null; out: string; ms: number } {
  const args = ["-p", "--no-extensions", "--no-skills", "--no-context-files", "-e", extension, "--session-dir", sessionDir, ...(session.includes("/") ? ["--session", session] : ["--session-id", session]), ...(model ? ["--model", model] : []), prompt];
  const started = Date.now();
  const r = spawnSync("pi", args, { cwd, encoding: "utf8", timeout: 300_000, env: { ...process.env, PI_EDIT_GUARD_DEBUG: "1" } });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, ms: Date.now() - started };
}

function sessionEntries(sessionDir: string): { file: string; entries: Entry[] } {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith(".jsonl")) files.push(join(d, e.name));
    }
  };
  walk(sessionDir);
  assert.equal(files.length, 1, `one session file in ${sessionDir}: ${files.join(", ")}`);
  return { file: files[0]!, entries: readFileSync(files[0]!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Entry) };
}

const toolTexts = (entries: Entry[]) => entries.flatMap((e) => (e.type === "message" && e.message?.role === "toolResult" ? [e.message.content.map((c) => c.text ?? "").join("")] : []));

test("live: pi -p reads and edits through the guard; one run ref per run; the project's .git untouched; observations in the session file", { timeout: 900_000 }, async () => {
  const root = tempDir("peg-e2e-");
  const sessionDir = tempDir("peg-e2e-sessions-");
  const sid = randomUUID();
  const store = { dir: storeDir(join(agentDir, "pi-edit-guard"), realpathSync.native(root)), root, git: true };
  try {
    writeFile(root, "greeting.txt", "hello world\n");
    writeFile(root, "notes.txt", "alpha\n");
    initRepo(root);
    const gitBefore = projectGitState(root);

    const first = pi(root, sessionDir, sid, "Read greeting.txt with the read tool, then use the edit tool to replace the word world with pi. Reply DONE.");
    console.log(`run 1: exit ${first.status}, ${first.ms} ms`);
    assert.equal(first.status, 0, first.out);
    assert.equal(readFileSync(join(root, "greeting.txt"), "utf8"), "hello pi\n");
    const { file, entries } = sessionEntries(sessionDir);
    const observed = entries.filter((e) => e.type === "custom" && e.customType === OBSERVATION_TYPE);
    assert.ok(observed.length >= 2, `observation entries in ${file}: ${observed.length}`);
    console.log(`observation entry: ${JSON.stringify(observed[0]!.data)}`);
    const refs1 = (await runGit(store, ["for-each-ref", "--format=%(refname)"])).stdout.toString().trim().split("\n");
    assert.deepEqual(refs1, [`refs/runs/${sid}/1`]);
    assert.deepEqual(projectGitState(root), gitBefore, "index, HEAD, refs and stash of the project are unchanged");

    const second = pi(
      root,
      sessionDir,
      file,
      "Do these steps in order, one tool call per step. 1) Read notes.txt with the read tool. 2) Run this bash command: printf 'gamma\\n' >> notes.txt 3) Without reading the file again, use the edit tool to replace alpha with ALPHA in notes.txt. 4) If a tool call is blocked or fails, follow its message and retry. Reply DONE.",
    );
    console.log(`run 2: exit ${second.status}, ${second.ms} ms`);
    assert.equal(second.status, 0, second.out);
    const texts = toolTexts(sessionEntries(sessionDir).entries);
    const blocked = texts.find((t) => t.startsWith("edit-guard: notes.txt changed since you read it"));
    console.log(`block seen by the model: ${blocked ?? "(none: the model re-read before editing)"}`);
    assert.ok(blocked, "the edit after the shell change was blocked");
    assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "ALPHA\ngamma\n", "after the block the model re-read and edited");
    const refs2 = (await runGit(store, ["for-each-ref", "--format=%(refname)"])).stdout.toString().trim().split("\n").sort();
    assert.deepEqual(refs2, [`refs/runs/${sid}/1`, `refs/runs/${sid}/2`]);
    assert.deepEqual(projectGitState(root), gitBefore);
  } finally {
    cleanup(root, sessionDir);
    if (existsSync(store.dir)) rmSync(store.dir, { recursive: true, force: true });
  }
});
