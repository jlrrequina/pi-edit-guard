/**
 * Version planning for the release workflow.
 *
 *   node scripts/release.ts plan <patch|minor|major|X.Y.Z>   prints version=… and mode=new|resume
 *   node scripts/release.ts at-least <X.Y.Z> <minimum>       exit 1 when the version is lower
 *
 * "resume" means the tag vX.Y.Z already exists: an earlier run pushed it and
 * only publishing is left. Otherwise the version must be newer than package.json.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type Version = [number, number, number];

export function parseVersion(v: string): Version {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`not an X.Y.Z version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** The version a release spec asks for: a bump of the current version or an exact X.Y.Z. */
export function nextVersion(current: string, spec: string): string {
  const [major, minor, patch] = parseVersion(current);
  if (spec === "major") return `${major + 1}.0.0`;
  if (spec === "minor") return `${major}.${minor + 1}.0`;
  if (spec === "patch") return `${major}.${minor}.${patch + 1}`;
  parseVersion(spec);
  return spec;
}

export function planRelease(current: string, spec: string, tagged: (version: string) => boolean): { version: string; mode: "new" | "resume" } {
  const version = nextVersion(current, spec);
  if (tagged(version)) return { version, mode: "resume" };
  if (compareVersions(version, current) <= 0) throw new Error(`${version} is not newer than the current version ${current}`);
  return { version, mode: "new" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === "plan" && a) {
      const current = JSON.parse(readFileSync("package.json", "utf8")).version as string;
      const tagged = (v: string) => spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/v${v}`]).status === 0;
      const { version, mode } = planRelease(current, a, tagged);
      process.stdout.write(`version=${version}\nmode=${mode}\n`);
    } else if (cmd === "at-least" && a && b) {
      process.exit(compareVersions(a, b) >= 0 ? 0 : 1);
    } else {
      console.error("usage: release.ts plan <patch|minor|major|X.Y.Z> | at-least <X.Y.Z> <minimum>");
      process.exit(2);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
