/**
 * §13.4 Integration: index.ts against a mock π (test/harness.ts) with π's real
 * session manager and tools, on temp projects. The agent dir is a temp
 * directory, so ~/.pi is untouched.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { repeatBlocked, repeatNotice } from "../guard/loop.ts";
import { runGit, storeDir } from "../guard/snapshot.ts";
import type { Store } from "../guard/snapshot.ts";
import { OBSERVATION_TYPE } from "../guard/state.ts";
import { Harness } from "./harness.ts";
import { cleanup, initRepo, projectGitState, readTree, tempDir, writeFile } from "./helpers.ts";

function project(git = true) {
  const root = tempDir("peg-proj-");
  const agent = tempDir("peg-agent-");
  process.env.PI_CODING_AGENT_DIR = agent;
  writeFile(root, "a.ts", "one\n");
  writeFile(root, "b.ts", "bee\n");
  writeFile(root, "c.ts", "sea\n");
  writeFile(root, ".gitignore", "*.log\n");
  if (git) initRepo(root);
  const store: Store = { dir: storeDir(join(agent, "pi-edit-guard"), root), root, git };
  const refs = async () =>
    existsSync(store.dir)
      ? (await runGit(store, ["for-each-ref", "--format=%(refname)"])).stdout.toString().split("\n").filter(Boolean)
      : [];
  return { root, agent, store, refs, done: () => cleanup(root, agent) };
}

const edit = (path: string, oldText: string, newText: string) => ({ path, edits: [{ oldText, newText }] });

test("a run: read→edit allowed, stale or unread writes blocked, one run ref in the private store, the project untouched", async () => {
  const p = project();
  try {
    const h = new Harness(p.root);
    await h.startSession();
    const gitBefore = projectGitState(p.root);
    const treeBefore = readTree(p.root);
    const sid = h.sm.getSessionId();
    await h.run(async () => {
      assert.equal((await h.call("read", { path: "a.ts" })).blocked, undefined);
      assert.match((await h.call("edit", edit("a.ts", "one", "two"))).text, /Successfully replaced/);
      assert.equal((await h.call("edit", edit("a.ts", "two", "three"))).blocked, undefined, "edit→edit: the agent's own write is an observation");
      assert.equal((await h.call("write", { path: "new.ts", content: "x\n" })).blocked, undefined, "a new file needs no read");
      assert.equal((await h.call("write", { path: "b.ts", content: "y\n" })).blocked, "edit-guard: b.ts exists but was not read in this context. Read it, then retry.");
      writeFileSync(join(p.root, "a.ts"), "changed by someone else\n");
      assert.equal((await h.call("edit", edit("a.ts", "three", "four"))).blocked, "edit-guard: a.ts changed since you read it (call #3). Read it again, then retry.");
      await h.call("read", { path: "./a.ts" });
      assert.equal((await h.call("edit", edit("a.ts", "someone", "nobody"))).blocked, undefined, "after a re-read (any spelling of the path) the edit goes through");
    });
    assert.deepEqual(await p.refs(), [`refs/runs/${sid}/1`]);
    assert.deepEqual(projectGitState(p.root), gitBefore, "the project's index, HEAD, refs and stash are untouched");
    const added = [...readTree(p.root).keys()].filter((k) => !treeBefore.has(k));
    assert.deepEqual(added, ["new.ts"], "nothing but the agent's own file is new in the project");
    const observations = h.sm.getEntries().filter((e) => e.type === "custom" && e.customType === OBSERVATION_TYPE);
    assert.ok(observations.length >= 4, "observations are persisted in the session");
  } finally {
    p.done();
  }
});

test("/undo: preview and scripted confirm, pre-undo checkpoint, cancel changes nothing, /undo pre-undo-1 reverses, no UI needs --yes", async () => {
  const p = project();
  try {
    const h = new Harness(p.root);
    await h.startSession();
    const before = readTree(p.root);
    await h.run(async () => {
      await h.call("read", { path: "a.ts" });
      await h.call("edit", edit("a.ts", "one", "two"));
      await h.call("write", { path: "made.ts", content: "new\n" });
      await h.call("bash", { command: "rm b.ts" });
    });
    const afterRun = readTree(p.root);

    h.confirmAnswer = false;
    assert.match(await h.command("undo"), /undo cancelled; nothing changed/);
    assert.equal(h.confirms.length, 1);
    assert.match(h.confirms[0]!.message, /^3 paths change: 2 restored, 1 deleted\.\n {2}restore a\.ts\n {2}restore b\.ts\n {2}delete  made\.ts$/);
    assert.deepEqual(readTree(p.root), afterRun);
    assert.ok(!(await p.refs()).some((r) => r.includes("pre-undo")), "a cancelled undo leaves no checkpoint");

    h.confirmAnswer = true;
    assert.match(await h.command("undo"), /restored the state before run 1: 2 written, 1 deleted\. \/undo pre-undo-1 reverses this\./);
    assert.deepEqual(readTree(p.root), before);
    assert.ok((await p.refs()).includes(`refs/pre-undo/${h.sm.getSessionId()}/1`));

    await h.run(async () => {
      assert.match((await h.call("edit", edit("a.ts", "one", "x"))).blocked ?? "", /not read in this context/, "after /undo, files must be read again");
    });

    assert.match(await h.command("undo", "pre-undo-1 --yes"), /restored the state before pre-undo-1/);
    assert.deepEqual(readTree(p.root), afterRun);

    h.hasUI = false;
    assert.match(await h.command("undo", "1"), /without a UI to confirm, \/undo needs --yes/);
    h.idle = false;
    assert.match(await h.command("undo", "1 --yes"), /wait until the agent finishes/);
  } finally {
    p.done();
  }
});

test("loop: read ×3 blocked, bash ×3 flagged, an edit resets, a blocked edit does not, a failing command after edits gets the notice", async () => {
  const p = project();
  try {
    const h = new Harness(p.root);
    await h.startSession();
    await h.run(async () => {
      await h.call("read", { path: "a.ts" });
      await h.call("read", { path: "a.ts" });
      assert.equal((await h.call("read", { path: "a.ts" })).blocked, repeatBlocked(3));

      for (let i = 0; i < 2; i++) assert.ok(!(await h.call("bash", { command: "true" })).text.includes("edit-guard"));
      const third = await h.call("bash", { command: "true" });
      assert.equal(third.blocked, undefined);
      assert.ok(third.text.endsWith(repeatNotice(3)));
      assert.equal((third.structuredContent as { exit_code?: number })?.exit_code, 0, "structuredContent survives the notice");

      await h.call("read", { path: "b.ts" });
      await h.call("read", { path: "b.ts" });
      await h.call("edit", edit("a.ts", "one", "two"));
      assert.equal((await h.call("read", { path: "b.ts" })).blocked, undefined, "the edit reset the count");

      await h.call("read", { path: "c.ts" });
      await h.call("read", { path: "c.ts" });
      assert.equal((await h.call("write", { path: "b.ts", content: "bee two\n" })).blocked, undefined, "b.ts was read above");
      assert.equal((await h.call("read", { path: "c.ts" })).blocked, undefined, "the write was a mutation");

      const fail = () => h.call("bash", { command: "echo failing; exit 1" });
      assert.ok(!(await fail()).text.includes("failed 1"));
      await h.call("edit", edit("a.ts", "two", "three"));
      assert.match((await fail()).text, /edit-guard: this command failed 2 times after changes\. Stop\./);
    });
  } finally {
    p.done();
  }
});

test("loop: a call blocked by the guard itself or by a later extension is not a mutation", async () => {
  const p = project();
  try {
    const h = new Harness(p.root);
    h.on("tool_call", (e: any) => (e.toolName === "bash" && e.input.command === "deny" ? { block: true, reason: "denied by another extension" } : undefined));
    await h.startSession();
    await h.run(async () => {
      await h.call("read", { path: "a.ts" });
      await h.call("read", { path: "a.ts" });
      assert.match((await h.call("write", { path: "b.ts", content: "x" })).blocked ?? "", /not read/);
      assert.equal((await h.call("bash", { command: "deny" })).blocked, "denied by another extension");
      assert.equal((await h.call("read", { path: "a.ts" })).blocked, repeatBlocked(3));
    });
  } finally {
    p.done();
  }
});

test("codemode: nested calls go through the same handlers (observations, freshness, loop), and persist through the parent's result", async () => {
  const p = project();
  try {
    const h = new Harness(p.root);
    await h.startSession();
    await h.run(async () => {
      const top = await h.call("codemode", { code: "script" }, {
        exec: async () => {
          const id = `call-1`;
          assert.equal((await h.call("read", { path: "a.ts" }, { parent: id })).blocked, undefined);
          assert.match((await h.call("write", { path: "b.ts", content: "x" }, { parent: id })).blocked ?? "", /b\.ts exists but was not read/);
          writeFileSync(join(p.root, "a.ts"), "external\n");
          assert.match((await h.call("edit", edit("a.ts", "external", "y"), { parent: id })).blocked ?? "", /a\.ts changed since you read it/);
          await h.call("read", { path: "c.ts" }, { parent: id });
          await h.call("read", { path: "c.ts" }, { parent: id });
          assert.equal((await h.call("read", { path: "c.ts" }, { parent: id })).blocked, repeatBlocked(3));
          return { content: [{ type: "text", text: "script done" }] };
        },
      });
      assert.equal(top.id, "call-1");
    });
    // a resumed session finds the nested read of c.ts through codemode's result
    const resumed = new Harness(p.root, { sm: h.sm });
    await resumed.startSession("resume");
    await resumed.run(async () => {
      assert.equal((await resumed.call("edit", edit("c.ts", "sea", "see"))).blocked, undefined);
    });
  } finally {
    p.done();
  }
});

test("compaction: files whose read was summarized need a re-read; reads kept verbatim stay valid", async () => {
  const p = project();
  try {
    const h = new Harness(p.root);
    await h.startSession();
    await h.run(async () => {
      await h.call("read", { path: "a.ts" });
    });
    const kept = h.sm.appendMessage({ role: "user", content: [{ type: "text", text: "next" }], timestamp: Date.now() });
    await h.run(async () => {
      await h.call("read", { path: "b.ts" });
    });
    await h.run(async () => {
      await h.call("read", { path: "c.ts" });
      await h.call("read", { path: "c.ts" });
    });
    h.sm.appendCompaction("summary of the session", kept, 5000);
    await h.emit("session_compact", { compactionEntry: {}, fromExtension: false, reason: "manual", willRetry: false });
    await h.run(async () => {
      assert.equal((await h.call("read", { path: "c.ts" })).blocked, undefined, "re-reading after compaction is not a repeat");
      assert.match((await h.call("edit", edit("a.ts", "one", "x"))).blocked ?? "", /a\.ts exists but was not read/);
      assert.equal((await h.call("edit", edit("b.ts", "bee", "x"))).blocked, undefined);
    });
  } finally {
    p.done();
  }
});

test("a context_edit appended mid-session (between turns) removes the read it omits from the observations", async () => {
  const p = project();
  try {
    const h = new Harness(p.root);
    await h.startSession();
    await h.run(async () => {
      await h.call("read", { path: "a.ts" });
      await h.call("read", { path: "b.ts" });
      const readB = h.sm.getLeafId()!; // b.ts's tool result
      h.sm.appendContextEdit(readB, null); // e.g. an extension pruning old tool output at turn_end
      await h.emit("turn_start", { turnIndex: 1, timestamp: Date.now() });
      assert.equal((await h.call("edit", edit("a.ts", "one", "uno"))).blocked, undefined);
      assert.match((await h.call("edit", edit("b.ts", "bee", "x"))).blocked ?? "", /b\.ts exists but was not read/);
    });
  } finally {
    p.done();
  }
});

test("resume and fork rebuild observations exactly from the transcript", async () => {
  const p = project();
  try {
    const h = new Harness(p.root);
    await h.startSession();
    let afterA = "";
    await h.run(async () => {
      await h.call("read", { path: "a.ts" });
      afterA = h.sm.getLeafId()!;
      await h.call("read", { path: "b.ts" });
    });
    writeFileSync(join(p.root, "b.ts"), "changed while the session was closed\n");
    const resumed = new Harness(p.root, { sm: h.sm });
    await resumed.startSession("resume");
    await resumed.run(async () => {
      assert.equal((await resumed.call("edit", edit("a.ts", "one", "uno"))).blocked, undefined, "unchanged since the read: no re-read needed");
      assert.match((await resumed.call("edit", edit("b.ts", "closed", "open"))).blocked ?? "", /b\.ts changed since you read it/);
    });
    // /tree to the point after the read of a.ts: b.ts was never read on that branch
    resumed.sm.branch(afterA);
    await resumed.emit("session_tree", { newLeafId: afterA, oldLeafId: null });
    await resumed.run(async () => {
      assert.match((await resumed.call("edit", edit("b.ts", "closed", "open"))).blocked ?? "", /b\.ts exists but was not read/, "on this branch b.ts was never read");
    });
    // a fork is a new session holding the branch's entries
    const header = { type: "session" as const, version: 3, id: "forked", timestamp: new Date().toISOString(), cwd: p.root };
    const forked = new Harness(p.root, { sm: SessionManager.inMemory(p.root, undefined, [header, ...h.sm.getBranch(afterA)]) });
    await forked.startSession("fork");
    await forked.run(async () => {
      assert.match((await forked.call("edit", edit("a.ts", "uno", "one"))).blocked ?? "", /a\.ts changed since you read it/, "a.ts changed after the fork point");
      assert.match((await forked.call("edit", edit("b.ts", "closed", "open"))).blocked ?? "", /b\.ts exists but was not read/);
    });
    writeFileSync(join(p.root, "a.ts"), "one\n"); // the content the fork's read saw
    await forked.run(async () => {
      assert.equal((await forked.call("edit", edit("a.ts", "one", "uno"))).blocked, undefined, "the fork's own observation of a.ts is valid again");
    });
  } finally {
    p.done();
  }
});

test("retention: keepRuns from config.json keeps the newest runs of the session", async () => {
  const p = project();
  try {
    mkdirSync(join(p.agent, "pi-edit-guard"), { recursive: true });
    writeFileSync(join(p.agent, "pi-edit-guard", "config.json"), JSON.stringify({ keepRuns: 2 }));
    const h = new Harness(p.root);
    await h.startSession();
    for (let i = 0; i < 4; i++) await h.run(() => h.call("bash", { command: `echo ${i} > n.txt` }));
    const sid = h.sm.getSessionId();
    for (let i = 0; i < 50 && (await p.refs()).length > 2; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual((await p.refs()).sort(), [`refs/runs/${sid}/3`, `refs/runs/${sid}/4`]);
  } finally {
    p.done();
  }
});

test("snapshot failure: the call runs, one warning per run, and /undo refuses the run", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const p = project();
  try {
    const h = new Harness(p.root);
    await h.startSession();
    await h.run(() => h.call("bash", { command: "echo 1 > n.txt" }));
    chmodSync(join(p.store.dir, "objects"), 0o500);
    try {
      await h.run(async () => {
        assert.equal((await h.call("bash", { command: "echo 2 > n.txt" })).blocked, undefined);
        assert.equal((await h.call("bash", { command: "echo 3 > m.txt" })).blocked, undefined);
      });
    } finally {
      chmodSync(join(p.store.dir, "objects"), 0o700);
    }
    const warnings = h.notes.filter((n) => n.message.startsWith("edit-guard: snapshot failed"));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, /; this run cannot be undone\.$/);
    assert.match(await h.command("undo", "--yes"), /run 2 is not covered \(.*\)\. \/undo 1 restores the state before run 1\./);
    assert.match(await h.command("guard"), /run 2: not covered/);
  } finally {
    p.done();
  }
});

test("lsp_fix, when installed, is a write tool only with write: true, and its result is not an observation", async () => {
  const p = project();
  try {
    const h = new Harness(p.root, { tools: ["read", "edit", "lsp_fix"] });
    await h.startSession();
    const fix = (content?: string) => async () => {
      if (content) writeFileSync(join(p.root, "a.ts"), content);
      return { content: [{ type: "text", text: "fixed" }] };
    };
    await h.run(async () => {
      assert.equal((await h.call("lsp_fix", { path: "a.ts" }, { exec: fix() })).blocked, undefined, "a preview does not write");
      assert.match((await h.call("lsp_fix", { path: "a.ts", write: true }, { exec: fix() })).blocked ?? "", /not read/);
      await h.call("read", { path: "a.ts" });
      assert.equal((await h.call("lsp_fix", { path: "a.ts", write: true }, { exec: fix("one;\n") })).blocked, undefined);
      assert.match((await h.call("edit", edit("a.ts", "one;", "two;"))).blocked ?? "", /changed since you read it/, "the agent has not seen what lsp_fix wrote");
    });
  } finally {
    p.done();
  }
});

test("/guard toggles and status, /checkpoints, config errors, and the debug log", async () => {
  const p = project();
  const tmp = tempDir("peg-tmp-");
  const prevTmp = process.env.TMPDIR;
  try {
    mkdirSync(join(p.agent, "pi-edit-guard"), { recursive: true });
    writeFileSync(join(p.agent, "pi-edit-guard", "config.json"), JSON.stringify({ repeatLimit: 1, bogus: true }));
    process.env.TMPDIR = tmp;
    process.env.PI_EDIT_GUARD_DEBUG = "1";
    const h = new Harness(p.root);
    await h.startSession();
    assert.match(h.notes[0]!.message, /config\.json: unknown key "bogus"; "repeatLimit" must be an integer >= 2\. Defaults apply to those keys\./);
    await h.run(async () => {
      assert.match((await h.call("write", { path: "a.ts", content: "x" })).blocked ?? "", /not read/);
      await h.command("guard", "freshness off");
      assert.equal((await h.call("write", { path: "a.ts", content: "x\n" })).blocked, undefined);
      await h.command("guard", "off");
      for (let i = 0; i < 4; i++) assert.equal((await h.call("read", { path: "b.ts" })).blocked, undefined);
    });
    const status = await h.command("guard", "status");
    assert.match(status, /^edit-guard: freshness off · snapshots off · loop off \(repeat limit 3\)/);
    assert.match(status, new RegExp(`root: ${p.root} \\(git work tree\\)`));
    assert.match(status, /run 1: covered \(refs\/runs\/.*\/1\)/);
    assert.match(status, /never covered: changes made by shell commands outside/);
    assert.match(await h.command("guard", "loop sideways"), /usage: \/guard/);
    assert.match(await h.command("checkpoints"), /Checkpoints \(root .*\):\n {2}run 1 {2}.* {2}1 paths differ/);
    const log = readFileSync(join(tmp, "pi-edit-guard", "debug.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(log.some((l) => l.event === "block-freshness" && l.tool === "write"));
    assert.ok(log.some((l) => l.event === "snapshot" && l.run === 1));
  } finally {
    delete process.env.PI_EDIT_GUARD_DEBUG;
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
    cleanup(tmp);
    p.done();
  }
});
