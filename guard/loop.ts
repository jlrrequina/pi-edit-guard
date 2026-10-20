/**
 * INV3 Progress.
 *
 * R1: an identical call with no mutating call in between returns the same
 * result for a tool that depends only on the file system, so it is blocked;
 * any other tool may depend on external state, so the result is flagged.
 * R2: a command that keeps failing after edits gets a notice; it is never
 * blocked, so tests stay runnable.
 *
 * Failure direction: when the detector fails, allow.
 */
import { createHash } from "node:crypto";
import type { LoopState } from "./state.ts";

/** JSON with sorted object keys and no whitespace. */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJSON(v))).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`).join(",")}}`;
}

export function callKey(toolName: string, input: unknown): string {
  return createHash("sha256").update(`${toolName}\0${canonicalJSON(input)}`).digest("hex");
}

export type Repeat = { count: number; action: "allow" | "flag" | "block" };

/**
 * Count identical calls since the last mutation and decide. A mutation counts
 * only strictly between the previous identical call and this one: the
 * previous call's own mutation does not reset its count, or a repeated
 * `bash` command (itself possibly mutating) could never be counted.
 */
export function checkRepeat(state: LoopState, key: string, seq: number, fileSystemOnly: boolean, limit: number): Repeat {
  const prev = state.lastSeen.get(key);
  const count = prev && state.lastMutationSeq <= prev.seq ? prev.count + 1 : 1;
  state.lastSeen.set(key, { seq, count });
  if (count < limit) return { count, action: "allow" };
  return { count, action: fileSystemOnly ? "block" : "flag" };
}

/**
 * Record a mutation at `seq`. Repeat counts older than the previous mutation
 * are dropped: they could only restart at 1, even if this mutation is rolled
 * back because a later handler blocked the call.
 */
export function recordMutation(state: LoopState, seq: number): void {
  if (seq <= state.lastMutationSeq) return;
  for (const [key, seen] of state.lastSeen) if (seen.seq < state.lastMutationSeq) state.lastSeen.delete(key);
  state.lastMutationSeq = seq;
}

/**
 * Count a failed result of a volatile call. `mutationBefore` is the last
 * mutation before this call started (not the call itself): the count grows
 * only when something changed since the previous failure of the same call.
 */
export function recordFailure(state: LoopState, key: string, seq: number, mutationBefore: number): number {
  const prev = state.failures.get(key);
  const count = prev && mutationBefore > prev.lastSeq ? prev.count + 1 : 1;
  state.failures.set(key, { count, lastSeq: seq });
  return count;
}

export function recordSuccess(state: LoopState, key: string): void {
  state.failures.delete(key);
}

export const repeatBlocked = (count: number) => `edit-guard: identical call #${count} with no change in between; the result would be identical. Change the input or the state first.`;
export const repeatNotice = (count: number) => `edit-guard: identical call #${count} with no change in between.`;
export const failureNotice = (count: number) =>
  `edit-guard: this command failed ${count} times after changes. Stop. Re-read the relevant code top-down, state which assumption was wrong, and choose a different approach before the next edit.`;
