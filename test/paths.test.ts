/**
 * The guard must check the file the tool will touch. π does not export its
 * resolver, so guard/paths.ts mirrors it; these tests run both on the same
 * inputs, against the π version installed for development.
 */
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { fileKey, insideRoot, pathKey, readPath, toolPath } from "../guard/paths.ts";
import { cleanup, tempDir } from "./helpers.ts";

const piTools = await import(pathToFileURL(resolve(import.meta.dirname, "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js")).href);

test("toolPath equals π's resolveToCwd (property)", () => {
  const cwd = tempDir();
  try {
    const piece = fc.constantFrom("a", "b c", "..", ".", "~", "@x", "\u00A0", "\u202F", "\u3000", "file://", "/", "src", "é", "e\u0301", "'", "AM.", " PM.png");
    const input = fc.array(piece, { minLength: 1, maxLength: 6 }).map((parts) => parts.join(""));
    fc.assert(
      fc.property(input, fc.constantFrom("", "@", "~/", "/tmp/", "./"), (s, prefix) => {
        const p = prefix + s;
        let expected: string;
        try {
          expected = piTools.resolveToCwd(p, cwd);
        } catch {
          return true; // π throws (an invalid file:// URL): the tool fails too
        }
        assert.equal(toolPath(p, cwd), expected, JSON.stringify(p));
        return true;
      }),
      { numRuns: 1000 },
    );
    assert.equal(toolPath("~", cwd), homedir());
    assert.equal(toolPath(`file://${cwd}/x`, "/elsewhere"), join(cwd, "x"));
  } finally {
    cleanup(cwd);
  }
});

test("readPath equals π's resolveReadPath, including the macOS file-name fallbacks", () => {
  const cwd = tempDir();
  try {
    const names = ["Screenshot 2026-10-20 at 9.41.07\u202FAM.png", "Capture d\u2019\u00e9cran.png".normalize("NFD"), "caf\u00e9.txt".normalize("NFD"), "plain.txt"];
    for (const n of names) writeFileSync(join(cwd, n), "x");
    const asked = ["Screenshot 2026-10-20 at 9.41.07 AM.png", "Capture d'\u00e9cran.png", "caf\u00e9.txt", "plain.txt", "missing.txt", "@plain.txt"];
    for (const a of asked) assert.equal(readPath(a, cwd), piTools.resolveReadPath(a, cwd), a);
  } finally {
    cleanup(cwd);
  }
});

test("fileKey: a symlink and its target are one key; so are two spellings on a case-insensitive file system", () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "File.ts"), "x");
    symlinkSync(join(dir, "real"), join(dir, "link"));
    assert.equal(fileKey(join(dir, "link", "File.ts")), fileKey(join(dir, "real", "File.ts")));
    let caseInsensitive = false;
    try {
      fileKey(join(dir, "real", "file.ts"));
      caseInsensitive = true;
    } catch {
      // case-sensitive file system: different spellings are different files
    }
    if (caseInsensitive) assert.equal(fileKey(join(dir, "real", "file.ts")), fileKey(join(dir, "real", "File.ts")));
    assert.equal(pathKey(join(dir, "link", "new", "x.ts")), join(dir, "real", "new", "x.ts"));
  } finally {
    cleanup(dir);
  }
});

test("insideRoot", () => {
  assert.equal(insideRoot("/r", "/r/a/b"), "a/b");
  assert.equal(insideRoot("/r", "/r"), undefined);
  assert.equal(insideRoot("/r", "/rx/a"), undefined);
  assert.equal(insideRoot("/r", "/a"), undefined);
});
