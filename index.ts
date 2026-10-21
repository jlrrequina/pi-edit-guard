/**
 * pi-edit-guard: wiring. Subscriptions, commands and the failure policy of
 * each invariant; the decisions live in guard/*.
 *
 *   INV1 freshness  cannot verify → block (one read repairs it)
 *   INV2 snapshots  cannot snapshot → allow, warn once per run, run not covered
 *   INV3 loop       detector fails → allow
 *
 * No handler lets an exception escape.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configPath, loadConfig, withRegisteredWriteTools } from "./config.ts";
import type { Config, WriteTool } from "./config.ts";
import { checkWrite, hashFile, observeBefore } from "./guard/freshness.ts";
import { callKey, checkRepeat, failureNotice, recordFailure, recordMutation, recordSuccess, repeatBlocked, repeatNotice } from "./guard/loop.ts";
import { fileKey, insideRoot, pathKey, readPath, toolPath } from "./guard/paths.ts";
import {
  applyRestore,
  checkpointName,
  countDiff,
  createCheckpoint,
  describePlan,
  dropCheckpoint,
  findRoot,
  journal,
  listCheckpoints,
  needsJournal,
  openStore,
  prepareRestore,
  refName,
  refuseRoot,
  retain,
  safeSession,
  snapshotTree,
  storeDir,
  sweepStores,
} from "./guard/snapshot.ts";
import type { Checkpoint, Store } from "./guard/snapshot.ts";
import { createState, OBSERVATION_TYPE, RESTORE_TYPE, rebuildObservations } from "./guard/state.ts";
import type { GuardState, ObservationData } from "./guard/state.ts";

type Run = {
  n?: number;
  commit?: string;
  covered: boolean;
  reason?: string;
  warned: boolean;
  ready?: Promise<void>;
  /** First write per path in this run: the journal record, if one was needed. */
  journaled: Map<string, Promise<void>>;
  /** Journal writes of this run, one at a time (they share a manifest). */
  queue: Promise<void>;
  outside: number;
  unreadable: string[];
};

type Call = {
  seq: number;
  tool: string;
  /** Top-level tool call whose result carries this call's output (itself, unless nested in codemode). */
  top: string;
  key?: string;
  mutating: boolean;
  /** lastMutationSeq before this call. */
  mutationBefore: number;
  read?: { key: string; hash: string };
  write?: { abs: string; spec: WriteTool };
  flag?: number;
  resulted?: boolean;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function debug(event: string, data: Record<string, unknown>): void {
  if (process.env.PI_EDIT_GUARD_DEBUG !== "1") return;
  try {
    const dir = join(tmpdir(), "pi-edit-guard");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "debug.jsonl"), `${JSON.stringify({ t: new Date().toISOString(), event, ...data })}\n`);
  } catch {
    // debugging must never affect a decision
  }
}

export default function piEditGuard(pi: ExtensionAPI): void {
  let config: Config = withRegisteredWriteTools(loadConfig(getAgentDir()), new Set());
  let toggles = { freshness: config.freshness, snapshots: config.snapshots, loop: config.loop };
  let state: GuardState = createState();
  let session = "";
  let storePromise: Promise<Store> | undefined;
  let runCounter: number | undefined;
  let run: Run | undefined;
  let lastRun: Run | undefined;
  /** Runs of this runtime whose snapshot failed, for /undo's answer. */
  const uncovered = new Map<number, string>();
  const calls = new Map<string, Call>();
  const topOf = new Map<string, string>();
  let syncedLeaf: string | null | undefined;
  /** The latest background snapshot of the root. It holds the private index lock, so every snapshot waits for it. */
  let warmUp: Promise<void> = Promise.resolve();
  let warmed = false;

  const base = () => join(getAgentDir(), "pi-edit-guard");

  function getStore(ctx: ExtensionContext): Promise<Store> {
    storePromise ??= (async () => {
      const root = await findRoot(ctx.cwd);
      const refused = await refuseRoot(root, config.exclude);
      if (refused) throw new Error(`no snapshots for ${refused}`);
      return openStore(base(), root, config.exclude);
    })();
    return storePromise;
  }

  /** The store, once the warm-up has finished. */
  async function readyStore(ctx: ExtensionContext): Promise<Store> {
    await warmUp;
    return getStore(ctx);
  }

  function newRun(): Run {
    return { covered: false, warned: false, journaled: new Map(), queue: Promise.resolve(), outside: 0, unreadable: [] };
  }

  function rebuild(ctx: ExtensionContext): void {
    try {
      const sm = ctx.sessionManager;
      const { observations, maxSeq } = rebuildObservations(sm.getBranch(), sm.buildSessionProjection().entries);
      state.observations = observations;
      state.seq = Math.max(state.seq, maxSeq);
      syncedLeaf = sm.getLeafId();
    } catch (err) {
      // The projection cannot be read: no observation is known to be in context.
      state.observations = new Map();
      syncedLeaf = undefined;
      debug("rebuild-failed", { error: message(err) });
    }
  }

  // ---- INV2: the run's checkpoint, before its first possibly-mutating call

  function uncover(ctx: ExtensionContext, r: Run, err: unknown): void {
    r.covered = false;
    r.reason ??= message(err);
    if (r.n !== undefined) uncovered.set(r.n, r.reason);
    debug("uncovered", { run: r.n, reason: r.reason });
    if (r.warned) return;
    r.warned = true;
    ctx.ui.notify(`edit-guard: snapshot failed (${r.reason}); this run cannot be undone.`, "warning");
  }

  async function protect(ctx: ExtensionContext, call: Call): Promise<void> {
    const r = (run ??= newRun());
    r.ready ??= (async () => {
      try {
        const store = await readyStore(ctx);
        if (runCounter === undefined) {
          const known = await listCheckpoints(store, session);
          runCounter = Math.max(0, ...known.flatMap((c) => (c.kind === "run" ? [c.n] : [])));
        }
        r.n = ++runCounter;
        const { commit, unreadable } = await createCheckpoint(store, session, { kind: "run", n: r.n });
        r.commit = commit;
        r.covered = true;
        r.unreadable = unreadable;
        debug("snapshot", { run: r.n, ref: refName(session, { kind: "run", n: r.n }), unreadable: unreadable.length });
        void retain(store, session, config.keepRuns).catch((err) => debug("retain-failed", { error: message(err) }));
      } catch (err) {
        uncover(ctx, r, err);
      }
    })();
    await r.ready;
    if (!call.write || r.n === undefined) return;
    const n = r.n;
    const key = pathKey(call.write.abs);
    let pending = r.journaled.get(key);
    if (!pending) {
      pending = r.queue = r.queue.then(async () => {
        try {
          const store = await getStore(ctx);
          if (!(await needsJournal(store, r.commit, key))) return;
          await journal(store, session, { kind: "run", n }, key);
          if (insideRoot(store.root, key) === undefined) r.outside++;
          debug("journal", { run: n, path: key });
        } catch (err) {
          uncover(ctx, r, err);
        }
      });
      r.journaled.set(key, pending);
    }
    await pending;
  }

  // ---- INV1: observations

  function observe(key: string, hash: string, call: Call): void {
    state.observations.set(key, { hash, seq: call.seq, toolCallId: call.top });
    const data: ObservationData = { path: key, hash, seq: call.seq, toolCallId: call.top };
    pi.appendEntry(OBSERVATION_TYPE, data);
  }

  function writeTool(tool: string, input: Record<string, unknown>): WriteTool | undefined {
    const spec = config.writeTools.get(tool);
    if (!spec || typeof input[spec.path] !== "string") return undefined;
    if (spec.when !== undefined && !input[spec.when]) return undefined;
    return spec;
  }

  // ---- events

  pi.on("session_start", (_event, ctx) => {
    try {
      const loaded = loadConfig(getAgentDir());
      config = withRegisteredWriteTools(loaded, new Set(pi.getAllTools().map((t) => t.name)));
      toggles = { freshness: config.freshness, snapshots: config.snapshots, loop: config.loop };
      if (loaded.errors.length) ctx.ui.notify(`edit-guard: ${configPath(getAgentDir())}: ${loaded.errors.join("; ")}. Defaults apply to those keys.`, "warning");
    } catch (err) {
      debug("config-failed", { error: message(err) });
    }
    state = createState();
    storePromise = undefined;
    warmed = false;
    runCounter = undefined;
    run = lastRun = undefined;
    uncovered.clear();
    calls.clear();
    topOf.clear();
    try {
      session = safeSession(ctx.sessionManager.getSessionId());
    } catch {
      session = "unknown";
    }
    rebuild(ctx);
    // Stores of deleted projects and stores unused for storeMaxAgeDays go, in the background.
    void findRoot(ctx.cwd)
      .then((root) => sweepStores(base(), config.storeMaxAgeDays, storeDir(base(), root.root)))
      .then(
        (removed) => removed.length && debug("sweep", { removed }),
        (err) => debug("sweep-failed", { error: message(err) }),
      );
  });

  // Re-reading after compaction or a branch switch is legitimate: both count as a change, at a seq of their own
  // so they fall strictly between the calls before and after them.
  pi.on("session_compact", (_event, ctx) => {
    rebuild(ctx);
    recordMutation(state, ++state.seq);
  });

  pi.on("session_tree", (_event, ctx) => {
    rebuild(ctx);
    recordMutation(state, ++state.seq);
  });

  pi.on("turn_start", (_event, ctx) => {
    // A context_edit appended since the last check may have removed a read result from context.
    try {
      const sm = ctx.sessionManager;
      const leaf = sm.getLeafId();
      if (leaf === syncedLeaf) return;
      let id: string | null | undefined = leaf;
      let edited = false;
      for (let steps = 0; id && id !== syncedLeaf && steps < 100_000; steps++) {
        const entry = sm.getEntry(id);
        if (!entry) break;
        if (entry.type === "context_edit") edited = true;
        id = entry.parentId;
      }
      if (edited || id !== syncedLeaf) rebuild(ctx);
      else syncedLeaf = leaf;
    } catch (err) {
      debug("sync-failed", { error: message(err) });
      rebuild(ctx);
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    run = newRun();
    // The first snapshot of a root writes every file into the store: seconds on a large project. Take it
    // while the model works on the first prompt; the snapshot before the run's first change is then incremental.
    if (toggles.snapshots && !warmed) {
      warmed = true;
      warmUp = warmUp
        .then(async () => {
          const started = Date.now();
          await snapshotTree(await getStore(ctx));
          debug("warm-up", { ms: Date.now() - started });
        })
        .catch((err) => debug("warm-up-failed", { error: message(err) }));
    }
  });

  pi.on("agent_end", () => {
    if (run?.ready) lastRun = run;
    run = undefined;
    topOf.clear();
  });

  pi.on("session_shutdown", () => {
    run = undefined;
    calls.clear();
    topOf.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    const input = (event.input ?? {}) as Record<string, unknown>;
    const tool = event.toolName;
    const seq = ++state.seq;
    const top = event.parentToolCallId ? (topOf.get(event.parentToolCallId) ?? event.parentToolCallId) : event.toolCallId;
    if (event.parentToolCallId) topOf.set(event.toolCallId, top);
    const call: Call = { seq, tool, top, mutating: !config.readOnlyTools.has(tool), mutationBefore: state.lastMutationSeq };

    // INV1: block when freshness cannot be verified
    try {
      const spec = writeTool(tool, input);
      if (spec) {
        const shownPath = input[spec.path] as string;
        const abs = toolPath(shownPath, ctx.cwd);
        call.write = { abs, spec };
        if (toggles.freshness) {
          const verdict = await checkWrite(state.observations, abs, shownPath);
          if (!verdict.allow) {
            debug("block-freshness", { tool, seq, path: abs, reason: verdict.reason });
            return { block: true, reason: verdict.reason };
          }
        }
      }
    } catch (err) {
      return { block: true, reason: `edit-guard: cannot verify the write (${message(err)}). Read the file, then retry.` };
    }

    // INV3 R1: allow when the detector fails
    if (toggles.loop) {
      try {
        call.key = callKey(tool, input);
        const fileSystemOnly = config.readOnlyTools.has(tool) || config.writeTools.has(tool);
        const repeat = checkRepeat(state, call.key, seq, fileSystemOnly, config.repeatLimit);
        if (repeat.action === "block") {
          debug("block-repeat", { tool, seq, count: repeat.count });
          return { block: true, reason: repeatBlocked(repeat.count) };
        }
        if (repeat.action === "flag") call.flag = repeat.count;
      } catch (err) {
        debug("loop-failed", { error: message(err) });
      }
    }

    // INV2: allow when the snapshot fails (protect never throws)
    if (call.mutating) {
      if (toggles.snapshots) {
        try {
          await protect(ctx, call);
        } catch (err) {
          debug("protect-failed", { error: message(err) });
        }
      }
      recordMutation(state, seq);
    }

    // INV1: hash before the read runs; a change in between can only cause a false block
    if (config.readTools.has(tool) && typeof input.path === "string") {
      try {
        call.read = await observeBefore(readPath(input.path, ctx.cwd));
      } catch {
        // no observation: a later write blocks until the next read
      }
    }
    calls.set(event.toolCallId, call);
    debug("allow", { tool, seq, mutating: call.mutating, ...(call.flag ? { repeat: call.flag } : {}), ...(call.read ? { observed: call.read.key } : {}) });
    return undefined;
  });

  pi.on("tool_result", async (event) => {
    const call = calls.get(event.toolCallId);
    if (!call) return undefined;
    call.resulted = true;
    const notes: string[] = [];
    try {
      if (!event.isError && call.read) observe(call.read.key, call.read.hash, call);
      else if (!event.isError && call.write?.spec.observes) {
        const key = fileKey(call.write.abs);
        observe(key, await hashFile(key), call);
      }
    } catch (err) {
      debug("observe-failed", { error: message(err) });
    }
    if (toggles.loop && call.key) {
      try {
        if (call.flag) notes.push(repeatNotice(call.flag));
        if (config.volatileTools.has(call.tool)) {
          const exitCode = (event.structuredContent as { exit_code?: unknown } | undefined)?.exit_code;
          if (event.isError || (typeof exitCode === "number" && exitCode !== 0)) {
            const count = recordFailure(state, call.key, call.seq, call.mutationBefore);
            if (count >= 2) notes.push(failureNotice(count));
          } else recordSuccess(state, call.key);
        }
      } catch (err) {
        debug("loop-failed", { error: message(err) });
      }
    }
    if (!notes.length) return undefined;
    debug("notice", { tool: call.tool, seq: call.seq, notes });
    return {
      content: [...event.content, { type: "text" as const, text: notes.join("\n") }],
      ...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
    };
  });

  pi.on("tool_execution_end", (event) => {
    const call = calls.get(event.toolCallId);
    calls.delete(event.toolCallId);
    // No tool_result: a later handler blocked the call or it was aborted. A call that did not run changed nothing.
    if (call && !call.resulted && call.mutating && state.lastMutationSeq === call.seq) state.lastMutationSeq = call.mutationBefore;
  });

  // ---- commands

  async function latestRun(store: Store): Promise<{ all: Checkpoint[]; latest: number }> {
    const all = await listCheckpoints(store, session);
    const latest = Math.max(0, runCounter ?? 0, ...all.flatMap((c) => (c.kind === "run" ? [c.n] : [])));
    return { all, latest };
  }

  pi.registerCommand("undo", {
    description: "Restore the files to the state before a run: /undo [n | pre-undo-<k>] [--yes]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        if (!ctx.isIdle()) {
          ctx.ui.notify("edit-guard: wait until the agent finishes, then /undo.", "warning");
          return;
        }
        const words = args.split(/\s+/).filter(Boolean);
        const yes = words.includes("--yes");
        const spec = words.find((w) => w !== "--yes");
        const store = await readyStore(ctx);
        const { all, latest } = await latestRun(store);
        let target: Checkpoint | undefined;
        let name: string;
        if (!spec || /^\d+$/.test(spec)) {
          const n = spec ? Number(spec) : latest;
          name = `run ${n}`;
          if (n === 0) {
            ctx.ui.notify("edit-guard: no run of this session changed anything yet.", "info");
            return;
          }
          if (n > latest) {
            ctx.ui.notify(`edit-guard: ${name} does not exist; the latest run of this session is run ${latest}.`, "warning");
            return;
          }
          target = all.find((c) => c.kind === "run" && c.n === n);
          if (!target?.commit) {
            const why = uncovered.get(n) ?? (target ? "its snapshot failed" : "no snapshot exists");
            ctx.ui.notify(`edit-guard: ${name} is not covered (${why}).${n > 1 ? ` /undo ${n - 1} restores the state before run ${n - 1}.` : ""}`, "warning");
            return;
          }
        } else {
          const m = spec.match(/^pre-undo-(\d+)$/);
          if (!m) {
            ctx.ui.notify("edit-guard: usage: /undo [n | pre-undo-<k>] [--yes]", "warning");
            return;
          }
          name = spec;
          target = all.find((c) => c.kind === "pre-undo" && c.k === Number(m[1]));
          if (!target?.commit) {
            ctx.ui.notify(`edit-guard: ${spec} does not exist.`, "warning");
            return;
          }
        }
        if (!yes && !ctx.hasUI) {
          ctx.ui.notify("edit-guard: without a UI to confirm, /undo needs --yes.", "warning");
          return;
        }
        const k = 1 + Math.max(0, ...all.flatMap((c) => (c.kind === "pre-undo" ? [c.k] : [])));
        const pre = { kind: "pre-undo" as const, k, afterRun: latest };
        const { plan } = await prepareRestore(store, session, target, pre);
        if (!plan.changes.length) {
          await dropCheckpoint(store, session, pre);
          ctx.ui.notify(`edit-guard: nothing to restore; the files already match the state before ${name}.`, "info");
          return;
        }
        const preview = describePlan(store, plan);
        if (!yes && !(await ctx.ui.confirm(`Restore the state before ${name}?`, preview))) {
          await dropCheckpoint(store, session, pre);
          ctx.ui.notify("edit-guard: undo cancelled; nothing changed.", "info");
          return;
        }
        const applied = await applyRestore(store, plan);
        state.observations.clear();
        pi.appendEntry(RESTORE_TYPE, { seq: state.seq });
        recordMutation(state, ++state.seq);
        debug("undo", { target: checkpointName(target), pre: checkpointName(pre), ...applied });
        const errors = applied.errors.length ? ` ${applied.errors.length} failed: ${applied.errors.slice(0, 3).join("; ")}.` : "";
        ctx.ui.notify(`edit-guard: restored the state before ${name}: ${applied.written} written, ${applied.deleted} deleted.${errors} /undo pre-undo-${k} reverses this.`, applied.errors.length ? "warning" : "info");
      } catch (err) {
        ctx.ui.notify(`edit-guard: undo failed: ${message(err)}`, "error");
      }
    },
  });

  pi.registerCommand("checkpoints", {
    description: "List this session's checkpoints and how many paths differ from now",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        const store = await readyStore(ctx);
        const { all } = await latestRun(store);
        if (!all.length) {
          ctx.ui.notify("edit-guard: no checkpoints in this session yet.", "info");
          return;
        }
        const { tree } = await snapshotTree(store);
        const lines = [`Checkpoints (root ${store.root}):`];
        for (const c of [...all].reverse()) {
          const label = c.kind === "run" ? `run ${c.n}` : `pre-undo-${c.k} (after run ${c.afterRun})`;
          if (!c.commit) {
            lines.push(`  ${label}  not covered`);
            continue;
          }
          const when = c.created ? new Date(c.created).toLocaleString() : "";
          lines.push(`  ${label}  ${when}  ${await countDiff(store, c.commit, tree)} paths differ`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err) {
        ctx.ui.notify(`edit-guard: ${message(err)}`, "error");
      }
    },
  });

  pi.registerCommand("guard", {
    description: "edit-guard status and session toggles: /guard [status|on|off|freshness on|off|snapshots on|off|loop on|off]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const words = args.split(/\s+/).filter(Boolean);
      const set = (value: string | undefined) => (value === "on" ? true : value === "off" ? false : undefined);
      if (words.length === 1 && set(words[0]) !== undefined) toggles = { freshness: set(words[0])!, snapshots: set(words[0])!, loop: set(words[0])! };
      else if (words.length === 2 && (words[0] === "freshness" || words[0] === "snapshots" || words[0] === "loop") && set(words[1]) !== undefined) toggles[words[0]] = set(words[1])!;
      else if (words.length && words[0] !== "status") {
        ctx.ui.notify("edit-guard: usage: /guard [status|on|off|freshness on|off|snapshots on|off|loop on|off]", "warning");
        return;
      }
      const onOff = (b: boolean) => (b ? "on" : "off");
      const lines = [`edit-guard: freshness ${onOff(toggles.freshness)} · snapshots ${onOff(toggles.snapshots)} · loop ${onOff(toggles.loop)} (repeat limit ${config.repeatLimit})`];
      try {
        const store = await getStore(ctx);
        lines.push(`root: ${store.root} (${store.git ? "git work tree" : "not a git repository"}) · store: ${store.dir}`);
        const r = run?.ready ? run : lastRun;
        if (r?.n !== undefined) {
          const journaled = r.journaled.size ? `; ${r.journaled.size} write targets checked, ${r.outside} journaled outside the root` : "";
          lines.push(r.covered ? `run ${r.n}: covered (${refName(session, { kind: "run", n: r.n })})${journaled}` : `run ${r.n}: not covered (${r.reason ?? "unknown"})`);
          if (r.unreadable.length) lines.push(`  ${r.unreadable.length} paths git could not read are not covered: ${r.unreadable.slice(0, 5).join(", ")}`);
        } else lines.push("no run of this session has changed anything yet");
        lines.push(`never covered: changes made by shell commands outside ${store.root}, nested git repositories, directories behind a link (Windows junctions), empty directories`);
      } catch (err) {
        lines.push(`snapshots unavailable: ${message(err)}`);
      }
      lines.push(`observations in context: ${state.observations.size}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
