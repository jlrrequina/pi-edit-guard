/** The release scripts the workflow runs: the Unreleased marker, the changelog move and version planning. */
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { pending, releaseChangelog, sectionBody } from "../scripts/changelog.ts";
import { compareVersions, nextVersion, planRelease } from "../scripts/release.ts";

const log = (heading: string, body = "- a change") => `# Changelog\n\n${heading}\n\n${body}\n\n## 0.1.0 — 2026-10-01\n\n- first\n`;

test("pending: the Unreleased heading's marker is the release spec; patch without one; empty means nothing to release", () => {
  assert.deepEqual(pending(log("## Unreleased")), { spec: "patch", body: "- a change" });
  assert.deepEqual(pending(log("## Unreleased (minor)")), { spec: "minor", body: "- a change" });
  assert.deepEqual(pending(log("## Unreleased (major)")), { spec: "major", body: "- a change" });
  assert.deepEqual(pending(log("## Unreleased (1.4.0)")), { spec: "1.4.0", body: "- a change" });
  assert.equal(pending(log("## Unreleased", ""))?.body, "");
  assert.equal(pending("# Changelog\n\n## 0.1.0 — x\n"), undefined);
  assert.throws(() => pending(log("## Unreleased (soon)")), /marker must be patch, minor, major or X\.Y\.Z/);
});

test("releaseChangelog: the marker goes away with the move; a fresh Unreleased stays on top", () => {
  const out = releaseChangelog(log("## Unreleased (minor)"), "0.2.0", "2026-10-20");
  assert.equal(out, "# Changelog\n\n## Unreleased\n\n## 0.2.0 — 2026-10-20\n\n- a change\n\n## 0.1.0 — 2026-10-01\n\n- first\n");
  assert.equal(sectionBody(out, "0.2.0"), "- a change");
  assert.deepEqual(pending(out), { spec: "patch", body: "" });
  assert.throws(() => releaseChangelog(log("## Unreleased", ""), "0.2.0", "x"), /nothing to release/);
  assert.throws(() => releaseChangelog(log("## Unreleased"), "0.1.0", "x"), /already has a "## 0\.1\.0" section/);
});

test("releaseChangelog keeps every entry and every older section (property)", () => {
  const line = fc.stringMatching(/^- [a-z]{1,10}( [a-z]{1,10}){0,2}$/);
  fc.assert(
    fc.property(fc.array(line, { minLength: 1, maxLength: 5 }), fc.constantFrom("", " (minor)", " (major)", " (9.9.9)"), (entries, marker) => {
      const text = log(`## Unreleased${marker}`, entries.join("\n"));
      const out = releaseChangelog(text, "1.0.0", "2026-10-20");
      assert.equal(sectionBody(out, "1.0.0"), entries.join("\n"));
      assert.equal(sectionBody(out, "0.1.0"), "- first");
      assert.equal(out.match(/^## Unreleased$/gm)?.length, 1);
    }),
  );
});

test("versions: bumps, exact versions, order, resume of a tagged release", () => {
  assert.equal(nextVersion("0.0.0", "minor"), "0.1.0");
  assert.equal(nextVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(nextVersion("1.2.3", "major"), "2.0.0");
  assert.equal(nextVersion("1.2.3", "1.4.0"), "1.4.0");
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.deepEqual(planRelease("1.2.3", "patch", () => false), { version: "1.2.4", mode: "new" });
  assert.deepEqual(planRelease("1.2.3", "1.2.3", (v) => v === "1.2.3"), { version: "1.2.3", mode: "resume" });
  assert.throws(() => planRelease("1.2.3", "1.2.0", () => false), /not newer/);
});
