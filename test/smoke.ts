/**
 * Package smoke test: run against the *extracted tarball*, not the repository.
 * Proves the published file list is self-contained (every module index.ts
 * needs is packed, nothing from the development side is) and that the packed
 * extension registers against a π-shaped API.
 *
 *   node test/smoke.ts <extracted-package-dir>
 *
 * π provides its own packages to extensions at runtime: link a node_modules
 * next to the extracted directory.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = resolve(process.argv[2] ?? "");
const fail = (msg: string): never => {
  console.error(`smoke: ${msg}`);
  process.exit(1);
};
if (!existsSync(join(dir, "package.json"))) fail(`no package.json in ${dir}`);

const packed: string[] = [];
const walk = (rel = "") => {
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (r !== "node_modules") walk(r);
    } else packed.push(r);
  }
};
walk();
const expected = ["index.ts", "config.ts", "guard/paths.ts", "guard/state.ts", "guard/freshness.ts", "guard/snapshot.ts", "guard/loop.ts", "skills/edit-guard/SKILL.md", "llms.txt", "package.json", "README.md", "CHANGELOG.md", "LICENSE"];
const missing = expected.filter((f) => !packed.includes(f));
const unexpected = packed.filter((f) => !expected.includes(f));
if (missing.length || unexpected.length) fail(`packed files — missing: ${JSON.stringify(missing)}, unexpected: ${JSON.stringify(unexpected)}`);

const mod = await import(pathToFileURL(join(dir, "index.ts")).href);
if (typeof mod.default !== "function") fail("index.ts has no default export function");
const events = new Set<string>();
const commands: string[] = [];
mod.default({
  on: (e: string) => {
    events.add(e);
    return () => {};
  },
  registerCommand: (name: string) => commands.push(name),
  appendEntry: () => {},
  getAllTools: () => [],
});
for (const c of ["undo", "checkpoints", "guard"]) if (!commands.includes(c)) fail(`command /${c} not registered`);
for (const e of ["session_start", "session_compact", "session_tree", "turn_start", "before_agent_start", "agent_end", "tool_call", "tool_result", "tool_execution_end"]) if (!events.has(e)) fail(`no ${e} handler`);
console.log(`smoke: ok — ${packed.length} packed files, ${commands.length} commands, ${events.size} events`);
