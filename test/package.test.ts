/**
 * Package metadata and documentation that regress silently: what npm and the
 * π catalog show, what the README promises, and what trusted publishing needs.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DEFAULTS, DEFAULT_EXCLUDES, parseConfig } from "../config.ts";
import { failureNotice, repeatBlocked, repeatNotice } from "../guard/loop.ts";
import { pending } from "../scripts/changelog.ts";

const root = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const pkg = JSON.parse(read("package.json"));
const readme = read("README.md").replaceAll("\\|", "|"); // pipes are escaped inside markdown tables

test("package.json: description within npm's limit, catalog keyword, manifest and published files exist", () => {
  assert.ok(pkg.description.length <= 250, `description is ${pkg.description.length} chars`);
  assert.match(pkg.description, /^Pi \(\u03c0\) coding-agent extension: .*\.$/);
  assert.ok(pkg.keywords.includes("pi-package"), "pi-package makes the package eligible for the π catalog");
  assert.equal(new Set(pkg.keywords).size, pkg.keywords.length);
  for (const k of pkg.keywords) assert.match(k, /^[a-z0-9.-]+$/);
  for (const p of pkg.pi.extensions) assert.ok(existsSync(join(root, p)), p);
  for (const f of pkg.files) assert.ok(existsSync(join(root, f)), `${f} is published and exists`);
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], "no runtime dependencies");
  assert.match(pkg.peerDependencies["@earendil-works/pi-coding-agent"], /^>=1\.2\.0$/);
});

test("trusted publishing: repository.url, the workflow's repository guard and the npm environment agree", () => {
  assert.equal(pkg.repository.url, "git+https://github.com/jlrrequina/pi-edit-guard.git");
  const release = read(".github/workflows/release.yml");
  assert.equal(release.match(/github\.repository == 'jlrrequina\/pi-edit-guard'/g)?.length, 2);
  assert.match(release, /environment:\n\s+name: npm/);
  assert.match(release, /id-token: write/);
  assert.match(release, /npm publish "\.\/\$FILE" --provenance --access public/);
});

test("CHANGELOG.md: the Unreleased heading parses, so a push to main can release", () => {
  const p = pending(read("CHANGELOG.md"));
  assert.ok(p, 'CHANGELOG.md has a "## Unreleased" section');
});

test("README: install command first, every command, config key, default list and message documented", () => {
  assert.ok(readme.startsWith("# pi-edit-guard\n"));
  assert.ok(readme.indexOf("pi install npm:@lenard9191/pi-edit-guard") < 1500, "install command above the fold");
  for (const c of ["/undo", "/undo <n>", "/undo pre-undo-<k>", "--yes", "/checkpoints", "/guard", "/guard on", "/guard freshness on|off", "/guard snapshots on|off", "/guard loop on|off"]) assert.ok(readme.includes(c), `README documents ${c}`);
  const keys = Object.keys(parseConfig({}).config);
  for (const k of keys) assert.ok(readme.includes(`\`${k}\``), `README documents config key ${k}`);
  for (const t of [...DEFAULTS.readOnlyTools, ...DEFAULTS.volatileTools, ...DEFAULT_EXCLUDES]) assert.ok(readme.includes(`\`${t}\``), `README lists the default ${t}`);
  for (const m of [repeatBlocked(3), repeatNotice(3), failureNotice(2), "exists but was not read in this context. Read it, then retry.", "changed since you read it (call #12). Read it again, then retry."]) assert.ok(readme.includes(m), `README shows: ${m}`);
  for (const s of ["## Decided out", "## Secrets", "## Coverage", "PI_EDIT_GUARD_DEBUG=1"]) assert.ok(readme.includes(s), s);
  assert.ok(!readme.includes("PERFORMANCE_TABLE"), "the measured table is filled in");
});
