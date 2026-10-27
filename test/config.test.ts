/** Configuration: every key optional, bad keys reported and replaced by their defaults. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { configPath, DEFAULT_WRITE_TOOLS, loadConfig, parseConfig, withRegisteredWriteTools } from "../config.ts";
import { cleanup, tempDir } from "./helpers.ts";

test("defaults: all on, repeat limit 3, the documented tool classes", () => {
  const { config, errors } = parseConfig(undefined);
  assert.deepEqual(errors, []);
  assert.equal(config.freshness && config.snapshots && config.loop, true);
  assert.equal(config.repeatLimit, 3);
  assert.equal(config.keepRuns, 20);
  assert.equal(config.storeMaxAgeDays, 7);
  assert.deepEqual([...config.readTools], ["read"]);
  assert.deepEqual(Object.fromEntries(config.writeTools), DEFAULT_WRITE_TOOLS);
  for (const t of ["read", "grep", "find", "ls", "ffgrep", "fffind", "tool_search", "vcc_recall", "lsp_diagnostics"]) assert.ok(config.readOnlyTools.has(t), t);
  for (const t of ["bash", "interactive_shell", "agent_browser", "agent_browser_code", "web_search", "fetch_content", "codemode", "run_checks"]) assert.ok(config.volatileTools.has(t), t);
});

test("valid keys apply; writeTools accepts an argument name or { path, when, observes }", () => {
  const { config, errors } = parseConfig({ freshness: false, repeatLimit: 4, keepRuns: 5, storeMaxAgeDays: 7, exclude: ["big"], readTools: ["read", "view"], writeTools: { patch: "file", fix: { path: "path", when: "apply", observes: false } } });
  assert.deepEqual(errors, []);
  assert.equal(config.freshness, false);
  assert.equal(config.repeatLimit, 4);
  assert.deepEqual(config.exclude, ["big"]);
  assert.deepEqual(Object.fromEntries(config.writeTools), { patch: { path: "file", observes: true }, fix: { path: "path", when: "apply", observes: false } });
});

test("bad keys are reported and fall back to their defaults", () => {
  const { config, errors } = parseConfig({ loop: "yes", repeatLimit: 1, keepRuns: 0.5, readOnlyTools: "read", writeTools: { edit: 3 }, extra: 1 });
  assert.deepEqual(
    [...errors].sort(),
    [
      'unknown key "extra"',
      '"loop" must be true or false',
      '"repeatLimit" must be an integer >= 2',
      '"keepRuns" must be an integer >= 1',
      '"readOnlyTools" must be an array of non-empty strings',
      '"writeTools" must map tool names to an argument name or to { path, when?, observes? }',
    ].sort(),
  );
  assert.equal(config.loop, true);
  assert.equal(config.repeatLimit, 3);
  assert.ok(config.writeTools.has("edit") && config.writeTools.get("edit")!.path === "path");
  assert.deepEqual(parseConfig([1]).errors, ["the file must contain a JSON object"]);
  assert.match(parseConfig({ writeTools: { x: { path: "p", when: 1 } } }).errors[0]!, /writeTools/);
  assert.match(parseConfig({ writeTools: { x: { path: "p", observes: "no" } } }).errors[0]!, /writeTools/);
});

test("loadConfig: a missing file is the default; invalid JSON and unreadable files are reported", () => {
  const agent = tempDir();
  try {
    assert.deepEqual(loadConfig(agent).errors, []);
    mkdirSync(join(agent, "pi-edit-guard"));
    writeFileSync(configPath(agent), "{ not json");
    assert.match(loadConfig(agent).errors[0]!, /config\.json is not valid JSON/);
    writeFileSync(configPath(agent), JSON.stringify({ keepRuns: 3 }));
    assert.equal(loadConfig(agent).config.keepRuns, 3);
    const asDir = tempDir();
    mkdirSync(join(asDir, "pi-edit-guard", "config.json"), { recursive: true });
    assert.match(loadConfig(asDir).errors[0]!, /cannot read .*config\.json/);
    cleanup(asDir);
  } finally {
    cleanup(agent);
  }
});

test("lsp_fix joins the write tools when it is registered, unless writeTools is configured", () => {
  const registered = new Set(["read", "lsp_fix"]);
  assert.deepEqual(withRegisteredWriteTools(parseConfig({}), registered).writeTools.get("lsp_fix"), { path: "path", when: "write", observes: false });
  assert.equal(withRegisteredWriteTools(parseConfig({}), new Set(["read"])).writeTools.has("lsp_fix"), false);
  assert.equal(withRegisteredWriteTools(parseConfig({ writeTools: { edit: "path" } }), registered).writeTools.has("lsp_fix"), false);
});
