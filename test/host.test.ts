/**
 * The guard inside a real π session: π's SDK, its agent loop, its built-in
 * tools and its codemode extension, driven by pi-ai's faux provider (a
 * scripted model, no network). This proves π dispatches the hooks the way the
 * mock harness assumes, including codemode's nested calls, without a live
 * model. The live smoke test (test/e2e.ts) does the same with a real model.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import piEditGuard from "../index.ts";
import { repeatBlocked } from "../guard/loop.ts";
import { runGit, storeDir } from "../guard/snapshot.ts";
import { OBSERVATION_TYPE } from "../guard/state.ts";
import { cleanup, initRepo, projectGitState, tempDir, writeFile } from "./helpers.ts";

async function piSession(root: string, agentDir: string, responses: AssistantMessage[]) {
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.provider.id, "test");
  faux.setResponses(responses);
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, extensionFactories: [piEditGuard, createCodemodeExtension({ mode: "on" })] });
  await resourceLoader.reload();
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  settingsManager.applyOverrides({ defaultTools: ["+codemode"] });
  const sessionManager = SessionManager.inMemory(root);
  const { session } = await createAgentSession({ cwd: root, agentDir, model: faux.getModel(), thinkingLevel: "off", modelRuntime, resourceLoader, settingsManager, sessionManager });
  await session.bindExtensions({});
  return { session, sessionManager };
}

/** Tool results as the model saw them, in order. */
function results(sm: SessionManager): { tool: string; text: string; isError: boolean }[] {
  return sm
    .getBranch()
    .flatMap((e) => (e.type === "message" && e.message.role === "toolResult" ? [{ tool: e.message.toolName, text: e.message.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: e.message.isError }] : []));
}

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

test("inside π: real dispatch, built-in tools and codemode's nested calls all pass through the guard", { timeout: 120_000 }, async () => {
  const root = tempDir("peg-host-");
  const agentDir = tempDir("peg-host-agent-");
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    writeFile(root, "a.ts", "one\n");
    writeFile(root, "b.ts", "bee\n");
    writeFile(root, "c.ts", "sea\n");
    writeFile(root, "d.ts", "dee\n");
    initRepo(root);
    const gitBefore = projectGitState(root);
    const script = [
      "const seen = await tools.read({ path: 'c.ts' });",
      "await tools.edit({ path: 'c.ts', edits: [{ oldText: 'sea', newText: 'see' }] });",
      "let outcome = 'written';",
      "try { await tools.write({ path: 'b.ts', content: 'clobbered' }); } catch (e) { outcome = e.message; }",
      "text(outcome);",
    ].join("\n");
    const { session, sessionManager } = await piSession(root, agentDir, [
      call("read", { path: "a.ts" }),
      call("edit", { path: "a.ts", edits: [{ oldText: "one", newText: "two" }] }),
      call("bash", { command: "printf 'external\\n' > a.ts" }),
      call("edit", { path: "a.ts", edits: [{ oldText: "external", newText: "three" }] }),
      call("write", { path: "b.ts", content: "clobbered" }),
      call("codemode", { code: script }),
      fauxAssistantMessage([fauxToolCall("read", { path: "d.ts" }), fauxToolCall("read", { path: "d.ts" }), fauxToolCall("read", { path: "d.ts" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    await session.prompt("go");

    const seen = results(sessionManager);
    assert.deepEqual(seen.map((r) => r.tool), ["read", "edit", "bash", "edit", "write", "codemode", "read", "read", "read"]);
    assert.equal(seen[1]!.isError, false);
    assert.equal(seen[3]!.text, "edit-guard: a.ts changed since you read it (call #2). Read it again, then retry.");
    assert.equal(seen[4]!.text, "edit-guard: b.ts exists but was not read in this context. Read it, then retry.");
    assert.match(seen[5]!.text, /edit-guard: b\.ts exists but was not read in this context/, "codemode's nested write was blocked by the same handler");
    assert.equal(seen[8]!.text, repeatBlocked(3));
    assert.equal(seen[6]!.isError, false);

    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "external\n");
    assert.equal(readFileSync(join(root, "b.ts"), "utf8"), "bee\n");
    assert.equal(readFileSync(join(root, "c.ts"), "utf8"), "see\n", "codemode's nested read made its nested edit valid");

    const sid = sessionManager.getSessionId();
    const store = { dir: storeDir(join(agentDir, "pi-edit-guard"), root), root, git: true };
    assert.deepEqual((await runGit(store, ["for-each-ref", "--format=%(refname)"])).stdout.toString().trim().split("\n"), [`refs/runs/${sid}/1`]);
    assert.deepEqual(projectGitState(root), gitBefore);
    const observed = sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === OBSERVATION_TYPE);
    assert.ok(observed.length >= 4, `observation entries in the session: ${observed.length}`);

    // /undo through π's own command dispatch (no UI in the SDK: --yes)
    await session.prompt("/undo --yes");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "one\n");
    assert.equal(readFileSync(join(root, "c.ts"), "utf8"), "sea\n");
    session.dispose();
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    cleanup(root, agentDir);
  }
});
