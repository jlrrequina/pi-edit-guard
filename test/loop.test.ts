/** INV3 at the module level: tables of call sequences and the expected decisions. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { callKey, canonicalJSON, checkRepeat, failureNotice, recordFailure, recordMutation, recordSuccess, repeatBlocked, repeatNotice } from "../guard/loop.ts";
import { createState } from "../guard/state.ts";

const READ_ONLY = new Set(["read", "grep", "ls"]);
const WRITE = new Set(["edit", "write"]);

type Step = { tool: string; input?: unknown; blockedByOther?: boolean } | { compaction: true };
type Expect = "allow" | "block" | "flag";

/** Drive the R1 rules the way index.ts does: check, then record a mutation for calls that ran. */
function drive(steps: Step[], limit = 3): Expect[] {
  const state = createState();
  const out: Expect[] = [];
  for (const s of steps) {
    if ("compaction" in s) {
      recordMutation(state, ++state.seq); // as index.ts does on session_compact
      continue;
    }
    const seq = ++state.seq;
    const fileSystemOnly = READ_ONLY.has(s.tool) || WRITE.has(s.tool);
    const r = checkRepeat(state, callKey(s.tool, s.input ?? { path: "a.ts" }), seq, fileSystemOnly, limit);
    out.push(r.action);
    if (r.action !== "block" && !s.blockedByOther && !READ_ONLY.has(s.tool)) recordMutation(state, seq);
  }
  return out;
}

test("R1: read ×3 with nothing mutating between: the third is blocked", () => {
  assert.deepEqual(drive([{ tool: "read" }, { tool: "read" }, { tool: "read" }]), ["allow", "allow", "block"]);
});

test("R1: bash ×3 identical: the third is flagged, never blocked (external state)", () => {
  const bash = { tool: "bash", input: { command: "npm test" } };
  assert.deepEqual(drive([bash, bash, bash, bash]), ["allow", "allow", "flag", "flag"]);
});

test("R1: an edit between resets; a blocked edit does not", () => {
  const read = { tool: "read" };
  assert.deepEqual(drive([read, read, { tool: "edit", input: { path: "b.ts" } }, read, read]), ["allow", "allow", "allow", "allow", "allow"]);
  assert.deepEqual(drive([read, read, { tool: "edit", input: { path: "b.ts" }, blockedByOther: true }, read]), ["allow", "allow", "allow", "block"]);
});

test("R1: a read-only call does not reset; compaction does", () => {
  const read = { tool: "read" };
  assert.deepEqual(drive([read, read, { tool: "grep", input: { pattern: "x" } }, read]), ["allow", "allow", "allow", "block"]);
  assert.deepEqual(drive([read, read, { compaction: true }, read, read, read]), ["allow", "allow", "allow", "allow", "block"]);
});

test("R1: alternating loops are caught per key", () => {
  const a = { tool: "read", input: { path: "a.ts" } };
  const b = { tool: "read", input: { path: "b.ts" } };
  assert.deepEqual(drive([a, b, a, b, a, b]), ["allow", "allow", "allow", "allow", "block", "block"]);
});

test("R1: identical edits are blocked on the third (file-system only); unknown tools are flagged", () => {
  const edit = { tool: "edit", input: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] } };
  assert.deepEqual(drive([edit, edit, edit]), ["allow", "allow", "block"]);
  const ask = { tool: "ask_user_question", input: { q: "?" } };
  assert.deepEqual(drive([ask, ask, ask]), ["allow", "allow", "flag"]);
});

test("R1: the key ignores object key order and whitespace, not values", () => {
  assert.equal(callKey("read", { path: "a", offset: 1 }), callKey("read", { offset: 1, path: "a" }));
  assert.notEqual(callKey("read", { path: "a" }), callKey("read", { path: "b" }));
  assert.notEqual(callKey("read", { path: "a" }), callKey("grep", { path: "a" }));
  assert.equal(canonicalJSON({ b: [1, { d: 2, c: undefined }], a: "x" }), '{"a":"x","b":[1,{"d":2}]}');
});

test("R2: the same failing command after changes: notice from the second failure; reruns without change reset; success clears", () => {
  const state = createState();
  const key = callKey("bash", { command: "npm test" });
  const fail = (mutationBefore: number) => recordFailure(state, key, ++state.seq, mutationBefore);
  assert.equal(fail(0), 1); // first failure
  state.lastMutationSeq = ++state.seq; // an edit
  assert.equal(fail(state.lastMutationSeq), 2);
  state.lastMutationSeq = ++state.seq;
  assert.equal(fail(state.lastMutationSeq), 3);
  assert.equal(fail(state.lastMutationSeq), 1, "no change since the last failure: the count starts over");
  state.lastMutationSeq = ++state.seq;
  recordSuccess(state, key);
  assert.equal(fail(state.lastMutationSeq), 1, "a success ends the chain");
});

test("messages", () => {
  assert.equal(repeatBlocked(3), "edit-guard: identical call #3 with no change in between; the result would be identical. Change the input or the state first.");
  assert.equal(repeatNotice(4), "edit-guard: identical call #4 with no change in between.");
  assert.match(failureNotice(2), /^edit-guard: this command failed 2 times after changes\. Stop\. Re-read the relevant code top-down/);
});
