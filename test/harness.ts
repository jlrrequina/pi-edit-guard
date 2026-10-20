/**
 * A mock π for integration tests: records what the extension registers and
 * dispatches events the way π's runner does (tool_call stops at the first
 * block; tool_result handlers compose). The session is π's real in-memory
 * SessionManager, and tool calls run π's real read/edit/write/bash tools.
 */
import { createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, SessionManager } from "@earendil-works/pi-coding-agent";
import piEditGuard from "../index.ts";
import { assistantCalls, toolResult } from "./helpers.ts";

type Handler = (event: any, ctx: any) => unknown;
type Content = { type: string; text?: string }[];
export type Outcome = { blocked?: string; text: string; isError: boolean; structuredContent?: unknown };

export class Harness {
  readonly root: string;
  sm: SessionManager;
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  readonly notes: { message: string; type?: string }[] = [];
  confirmAnswer = true;
  confirms: { title: string; message: string }[] = [];
  hasUI = true;
  idle = true;
  tools: string[];
  private calls = 0;
  private readonly defs: Record<string, any>;

  constructor(root: string, opts: { sm?: SessionManager; tools?: string[] } = {}) {
    this.root = root;
    this.sm = opts.sm ?? SessionManager.inMemory(root);
    this.tools = opts.tools ?? ["read", "edit", "write", "bash", "codemode", "grep"];
    this.defs = { read: createReadToolDefinition(root), edit: createEditToolDefinition(root), write: createWriteToolDefinition(root), bash: createBashToolDefinition(root) };
    piEditGuard(this.api() as any);
  }

  /** Extra handlers registered after the guard, as a later-loaded extension would. */
  on(event: string, handler: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  private api() {
    return {
      on: (event: string, handler: Handler) => {
        this.on(event, handler);
        return () => {};
      },
      registerCommand: (name: string, opts: { handler: (args: string, ctx: any) => Promise<void> }) => this.commands.set(name, opts.handler),
      appendEntry: (customType: string, data?: unknown) => this.sm.appendCustomEntry(customType, data),
      getAllTools: () => this.tools.map((name) => ({ name })),
    };
  }

  ctx() {
    return {
      cwd: this.root,
      mode: "tui",
      hasUI: this.hasUI,
      sessionManager: this.sm,
      isIdle: () => this.idle,
      ui: {
        notify: (message: string, type?: string) => this.notes.push({ message, type }),
        confirm: async (title: string, message: string) => {
          this.confirms.push({ title, message });
          return this.confirmAnswer;
        },
      },
    };
  }

  async emit(event: string, payload: Record<string, unknown> = {}): Promise<any> {
    const ctx = this.ctx();
    let result: any;
    const current: Record<string, any> = { type: event, ...payload };
    for (const h of this.handlers.get(event) ?? []) {
      const r: any = await h(current, ctx);
      if (!r) continue;
      if (event === "tool_call") {
        result = r;
        if (r.block) return r;
      } else if (event === "tool_result") {
        if (r.content !== undefined) {
          current.content = r.content;
          if (r.structuredContent === undefined) delete current.structuredContent;
        }
        if (r.structuredContent !== undefined) current.structuredContent = r.structuredContent;
        result = current;
      } else result = r;
    }
    return result;
  }

  async command(name: string, args = ""): Promise<string> {
    const before = this.notes.length;
    await this.commands.get(name)!(args, this.ctx());
    return this.notes.slice(before).map((n) => n.message).join("\n");
  }

  async startSession(reason = "startup"): Promise<void> {
    await this.emit("session_start", { reason });
  }

  async run<T>(body: () => Promise<T>): Promise<T> {
    this.sm.appendMessage({ role: "user", content: [{ type: "text", text: "task" }], timestamp: Date.now() });
    await this.emit("before_agent_start", { prompt: "task", messageType: "user" });
    await this.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    try {
      return await body();
    } finally {
      await this.emit("agent_end", { messages: [] });
    }
  }

  /**
   * One tool call through the guard: execution start, tool_call, the real
   * tool (or `exec`), tool_result, the transcript entries, execution end.
   * A nested call (parent set) adds no transcript entries, like codemode's.
   */
  async call(tool: string, input: Record<string, any>, opts: { parent?: string; exec?: () => Promise<{ content: Content; isError?: boolean; structuredContent?: unknown }> } = {}): Promise<Outcome & { id: string }> {
    const id = opts.parent ? `${opts.parent}/${++this.calls}` : `call-${++this.calls}`;
    const parent = opts.parent ? { parentToolCallId: opts.parent } : {};
    if (!opts.parent) assistantCalls(this.sm, [{ id, name: tool, args: input }]);
    await this.emit("tool_execution_start", { toolCallId: id, toolName: tool, args: input, ...parent });
    const gate = await this.emit("tool_call", { toolName: tool, toolCallId: id, input, ...parent });
    if (gate?.block) {
      if (!opts.parent) toolResult(this.sm, id, tool, gate.reason, true);
      await this.emit("tool_execution_end", { toolCallId: id, toolName: tool, isError: true, ...parent });
      return { id, blocked: gate.reason, text: gate.reason, isError: true };
    }
    let raw: { content: Content; isError?: boolean; structuredContent?: unknown };
    if (opts.exec) raw = await opts.exec();
    else {
      try {
        raw = await this.defs[tool].execute(id, input, undefined, undefined, undefined);
      } catch (err) {
        raw = { content: [{ type: "text", text: (err as Error).message }], isError: true };
      }
    }
    const isError = raw.isError === true;
    const final = (await this.emit("tool_result", { toolName: tool, toolCallId: id, input, content: raw.content, structuredContent: raw.structuredContent, isError, details: undefined, ...parent })) ?? { content: raw.content, structuredContent: raw.structuredContent };
    const text = (final.content as Content).map((c) => c.text ?? "").join("\n");
    if (!opts.parent) toolResult(this.sm, id, tool, text, isError);
    await this.emit("tool_execution_end", { toolCallId: id, toolName: tool, isError, ...parent });
    return { id, text, isError, structuredContent: final.structuredContent };
  }
}
