/**
 * CHANGELOG.md helpers for the release workflow.
 *
 *   node scripts/changelog.ts pending                       pending=true|false and spec=patch|minor|major|X.Y.Z
 *   node scripts/changelog.ts release <X.Y.Z> [YYYY-MM-DD]  move "## Unreleased" to "## X.Y.Z — date"
 *   node scripts/changelog.ts notes <X.Y.Z>                 print that version's section
 *
 * Entries accumulate under "## Unreleased". The heading may name the next
 * version: "## Unreleased" is a patch release, "## Unreleased (minor)",
 * "## Unreleased (major)" or "## Unreleased (1.4.0)" say otherwise. A release
 * turns the heading into the version and leaves a fresh "## Unreleased" above.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const UNRELEASED = /^## Unreleased(?: \(([^)]*)\))?[ \t]*$/m;

/** Body of a "## <title…>" section (without its heading), or undefined when absent. */
export function sectionBody(text: string, title: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `## ${title}` || l.startsWith(`## ${title} `));
  if (start === -1) return undefined;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

export type Pending = { spec: string; body: string };

/** What "## Unreleased" asks for: its entries and the release spec of its heading; undefined when there is no such section. */
export function pending(text: string): Pending | undefined {
  const m = UNRELEASED.exec(text);
  if (!m) return undefined;
  const spec = (m[1] ?? "patch").trim();
  if (!/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(spec)) throw new Error(`"## Unreleased (${spec})": the marker must be patch, minor, major or X.Y.Z`);
  return { spec, body: sectionBody(text, "Unreleased") ?? "" };
}

/** Turn "## Unreleased[ (marker)]" into "## <version> — <date>" and add a new empty "## Unreleased" above it. */
export function releaseChangelog(text: string, version: string, date: string): string {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a version: ${version}`);
  if (sectionBody(text, version) !== undefined) throw new Error(`CHANGELOG.md already has a "## ${version}" section`);
  const p = pending(text);
  if (!p) throw new Error('CHANGELOG.md has no "## Unreleased" section');
  if (!p.body) throw new Error('nothing to release: "## Unreleased" in CHANGELOG.md is empty');
  return text.replace(UNRELEASED, `## Unreleased\n\n## ${version} — ${date}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, version, date] = process.argv.slice(2);
  try {
    const text = readFileSync("CHANGELOG.md", "utf8");
    if (cmd === "pending") {
      const p = pending(text);
      process.stdout.write(`pending=${Boolean(p?.body)}\nspec=${p?.spec ?? "patch"}\n`);
    } else if (cmd === "release" && version) {
      writeFileSync("CHANGELOG.md", releaseChangelog(text, version, date ?? new Date().toISOString().slice(0, 10)));
    } else if (cmd === "notes" && version) {
      const body = sectionBody(text, version);
      if (!body) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
      process.stdout.write(`${body}\n`);
    } else {
      console.error("usage: changelog.ts pending | release <X.Y.Z> [YYYY-MM-DD] | notes <X.Y.Z>");
      process.exit(2);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
