/**
 * Paths as π's tools resolve them, and the key that identifies a file.
 *
 * π does not export its resolver, so `toolPath` mirrors `resolveToCwd` and
 * `readPath` mirrors `resolveReadPath` (π's `core/tools/path-utils.js` and
 * `utils/paths.js`). test/paths.test.ts runs both against π's own functions,
 * so a change in π fails the test instead of opening a gap between the file
 * the guard checks and the file the tool writes.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

/** Git Bash, MSYS, Cygwin and WSL drive paths in a form native Windows APIs accept (π's normalizeWindowsShellPath). */
function windowsShellPath(p: string): string {
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return p;
  const m = p.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!m) return p;
  return `${m[1]!.toUpperCase()}:\\${m[2]?.replaceAll("/", "\\") ?? ""}`;
}

function normalize(input: string, toolInput: boolean): string {
  let p = input;
  if (toolInput) {
    p = p.replace(UNICODE_SPACES, " ");
    if (p.startsWith("@")) p = p.slice(1);
  }
  if (process.platform === "win32") p = windowsShellPath(p);
  const home = homedir();
  if (p === "~") return home;
  if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) return join(home, p.slice(2));
  if (/^file:\/\//.test(p)) return fileURLToPath(p);
  return p;
}

/** The absolute path `edit` and `write` operate on for `input` (π's resolveToCwd). */
export function toolPath(input: string, cwd: string): string {
  const p = normalize(input, true);
  return isAbsolute(p) ? resolve(p) : resolve(normalize(cwd, false), p);
}

/** The absolute path `read` reads for `input`: like toolPath, plus π's macOS file-name fallbacks (π's resolveReadPath). */
export function readPath(input: string, cwd: string): string {
  const resolved = toolPath(input, cwd);
  if (existsSync(resolved)) return resolved;
  const amPm = resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
  const nfd = resolved.normalize("NFD");
  const curly = resolved.replace(/'/g, "\u2019");
  const nfdCurly = nfd.replace(/'/g, "\u2019");
  for (const v of [amPm, nfd, curly, nfdCurly]) if (v !== resolved && existsSync(v)) return v;
  return resolved;
}

/** One key per file: symlinks resolved, and on case-insensitive file systems the stored case. Throws when the file does not exist. */
export function fileKey(abs: string): string {
  return realpathSync.native(abs);
}

/** Like fileKey for a path that may not exist yet: the nearest existing ancestor is resolved, the rest is kept. */
export function pathKey(abs: string): string {
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(pathKey(parent), basename(abs));
  }
}

/** `abs` relative to `root` with forward slashes, or undefined when it is not inside root. */
export function insideRoot(root: string, abs: string): string | undefined {
  const rel = relative(root, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return sep === "/" ? rel : rel.split(sep).join("/");
}
