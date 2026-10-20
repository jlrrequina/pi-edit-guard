/**
 * Session state. The session transcript is the single source of truth; the
 * maps here are a cache that `rebuildObservations` recomputes from it.
 *
 * An observation is valid while the tool result that delivered it is in the
 * model's context: on the current branch, inside π's compaction-aware
 * projection, and not omitted or replaced by a `context_edit` entry. Each
 * observation entry names that tool result (`toolCallId`, the top-level call
 * for calls nested in codemode), so the projection decides validity exactly.
 */

export const OBSERVATION_TYPE = "edit-guard/observation";
export const RESTORE_TYPE = "edit-guard/restore";

export type Observation = { hash: string; seq: number; toolCallId: string };

/** Data of an `edit-guard/observation` entry. */
export type ObservationData = { path: string; hash: string; seq: number; toolCallId: string };

/** The parts of π's session entries the rebuild reads (structural, so this module needs no π import). */
export type EntryView = {
  type: string;
  id: string;
  customType?: string;
  data?: unknown;
  targetId?: string;
  message?: { role?: string; toolCallId?: string };
};

export type ProjectedView = { sourceEntry: EntryView };

export type Failure = { count: number; lastSeq: number };

export type LoopState = {
  /** seq of the last call that was not blocked to a possibly-mutating tool. */
  lastMutationSeq: number;
  lastSeen: Map<string, { seq: number; count: number }>;
  failures: Map<string, Failure>;
};

export type GuardState = LoopState & {
  observations: Map<string, Observation>;
  /** Increments on every tool_call seen. */
  seq: number;
};

export function createState(): GuardState {
  return { observations: new Map(), seq: 0, lastMutationSeq: 0, lastSeen: new Map(), failures: new Map() };
}

export function isObservationData(v: unknown): v is ObservationData {
  const d = v as ObservationData;
  return typeof d === "object" && d !== null && typeof d.path === "string" && typeof d.hash === "string" && Number.isInteger(d.seq) && typeof d.toolCallId === "string";
}

/**
 * Observations still in the model's context, from the current branch
 * (`branch`, root to leaf) and π's projection of it (`projected`). Entries
 * before the latest restore marker on the branch do not count: `/undo`
 * cleared them. `maxSeq` is the largest seq on the branch, so call numbers
 * stay unique after a resume.
 */
export function rebuildObservations(branch: readonly EntryView[], projected: readonly ProjectedView[]): { observations: Map<string, Observation>; maxSeq: number } {
  const edited = new Set<string>();
  for (const { sourceEntry: e } of projected) if (e.type === "context_edit" && e.targetId) edited.add(e.targetId);
  const visible = new Set<string>();
  for (const { sourceEntry: e } of projected) {
    if (e.type === "message" && e.message?.role === "toolResult" && e.message.toolCallId && !edited.has(e.id)) visible.add(e.message.toolCallId);
  }
  let lastRestore = -1;
  branch.forEach((e, i) => {
    if (e.type === "custom" && e.customType === RESTORE_TYPE) lastRestore = i;
  });
  const observations = new Map<string, Observation>();
  let maxSeq = 0;
  branch.forEach((e, i) => {
    if (e.type !== "custom" || e.customType !== OBSERVATION_TYPE || !isObservationData(e.data)) return;
    const d = e.data;
    maxSeq = Math.max(maxSeq, d.seq);
    if (i > lastRestore && visible.has(d.toolCallId)) observations.set(d.path, { hash: d.hash, seq: d.seq, toolCallId: d.toolCallId });
  });
  return { observations, maxSeq };
}
