/** INV1 at the module level: the gate, and the rebuild of observations from π's real projection. */
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { checkWrite, hashFile, observeBefore } from "../guard/freshness.ts";
import { OBSERVATION_TYPE, RESTORE_TYPE, rebuildObservations } from "../guard/state.ts";
import type { Observation } from "../guard/state.ts";
import { assistantCalls, cleanup, tempDir, toolResult, userMessage } from "./helpers.ts";

test("gate: absent file allowed; unread blocked; changed blocked with the call number; unchanged allowed; unverifiable blocked", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "a.ts");
    const obs = new Map<string, Observation>();
    assert.deepEqual(await checkWrite(obs, join(dir, "new.ts"), "new.ts"), { allow: true, absent: true });
    assert.deepEqual(await checkWrite(obs, join(dir, "missing-dir", "x.ts"), "missing-dir/x.ts"), { allow: true, absent: true });
    writeFileSync(file, "one\n");
    const unread = await checkWrite(obs, file, "a.ts");
    assert.equal(unread.allow, false);
    assert.equal(!unread.allow && unread.reason, "edit-guard: a.ts exists but was not read in this context. Read it, then retry.");
    const seen = (await observeBefore(file))!;
    obs.set(seen.key, { hash: seen.hash, seq: 7, toolCallId: "t1" });
    assert.equal((await checkWrite(obs, file, "a.ts")).allow, true);
    writeFileSync(file, "two\n");
    const stale = await checkWrite(obs, file, "a.ts");
    assert.equal(!stale.allow && stale.reason, "edit-guard: a.ts changed since you read it (call #7). Read it again, then retry.");
    obs.set(seen.key, { hash: await hashFile(file), seq: 9, toolCallId: "t2" });
    assert.equal((await checkWrite(obs, file, "a.ts")).allow, true);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      chmodSync(file, 0o000);
      const unreadable = await checkWrite(obs, file, "a.ts");
      assert.match(!unreadable.allow ? unreadable.reason : "", /^edit-guard: cannot verify a\.ts \(.*EACCES.*\)\. Read it, then retry\.$/);
      chmodSync(file, 0o644);
    }
  } finally {
    cleanup(dir);
  }
});

function observation(sm: SessionManager, path: string, hash: string, seq: number, toolCallId: string): void {
  sm.appendCustomEntry(OBSERVATION_TYPE, { path, hash, seq, toolCallId });
}

/** One read of `path` the way the agent loop records it: call, observation entry, result. */
function read(sm: SessionManager, id: string, path: string, hash: string, seq: number): { call: string; result: string } {
  const call = assistantCalls(sm, [{ id, name: "read", args: { path } }]);
  observation(sm, path, hash, seq, id);
  return { call, result: toolResult(sm, id, "read", "content") };
}

const rebuild = (sm: SessionManager) => rebuildObservations(sm.getBranch(), sm.buildSessionProjection().entries);

test("rebuild: an observation counts while its read result is in π's projection", () => {
  const sm = SessionManager.inMemory("/p");
  userMessage(sm, "go");
  read(sm, "r1", "/p/a.ts", "h1", 1);
  read(sm, "r2", "/p/b.ts", "h2", 2);
  read(sm, "r3", "/p/a.ts", "h3", 3); // the last observation of a file wins
  const { observations, maxSeq } = rebuild(sm);
  assert.deepEqual(Object.fromEntries(observations), { "/p/a.ts": { hash: "h3", seq: 3, toolCallId: "r3" }, "/p/b.ts": { hash: "h2", seq: 2, toolCallId: "r2" } });
  assert.equal(maxSeq, 3);
});

test("rebuild: compaction drops reads before the kept boundary and keeps the ones after it", () => {
  const sm = SessionManager.inMemory("/p");
  userMessage(sm, "first");
  read(sm, "r1", "/p/old.ts", "h1", 1);
  const kept = userMessage(sm, "second");
  read(sm, "r2", "/p/new.ts", "h2", 2);
  sm.appendCompaction("summary", kept, 1000);
  const { observations, maxSeq } = rebuild(sm);
  assert.deepEqual([...observations.keys()], ["/p/new.ts"]);
  assert.equal(maxSeq, 2, "seq continues past compacted observations");
});

test("rebuild: a context_edit that omits or replaces a read result ends its observation", () => {
  const sm = SessionManager.inMemory("/p");
  userMessage(sm, "go");
  const a = read(sm, "r1", "/p/a.ts", "h1", 1);
  const b = read(sm, "r2", "/p/b.ts", "h2", 2);
  sm.appendContextEdit(a.result, null);
  sm.appendContextEdit(b.result, { content: "[pruned]" });
  assert.equal(rebuild(sm).observations.size, 0);
});

test("rebuild: a fork or /tree branch sees only its own branch's observations", () => {
  const sm = SessionManager.inMemory("/p");
  userMessage(sm, "go");
  const shared = read(sm, "r1", "/p/a.ts", "h1", 1);
  read(sm, "r2", "/p/b.ts", "h2", 2);
  sm.branch(shared.result);
  read(sm, "r3", "/p/c.ts", "h3", 3);
  assert.deepEqual([...rebuild(sm).observations.keys()].sort(), ["/p/a.ts", "/p/c.ts"]);
});

test("rebuild: observations before an /undo marker do not count; nested codemode reads count through their parent's result", () => {
  const sm = SessionManager.inMemory("/p");
  userMessage(sm, "go");
  read(sm, "r1", "/p/a.ts", "h1", 1);
  sm.appendCustomEntry(RESTORE_TYPE, { seq: 1 });
  assert.equal(rebuild(sm).observations.size, 0);
  assistantCalls(sm, [{ id: "cm", name: "codemode", args: { code: "..." } }]);
  observation(sm, "/p/n.ts", "hn", 2, "cm"); // nested read cm/1 records its top-level parent
  assert.equal(rebuild(sm).observations.size, 0, "not yet in context: codemode's result is missing");
  toolResult(sm, "cm", "codemode", "script output");
  assert.deepEqual([...rebuild(sm).observations.keys()], ["/p/n.ts"]);
});
