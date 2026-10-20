/**
 * INV1 Freshness: a write to an existing file is valid only if the file's
 * content hash now equals the hash recorded at the agent's last observation
 * of that file that is still in the model's context.
 *
 * Failure direction: when freshness cannot be verified, block. One `read`
 * repairs it.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileKey } from "./paths.ts";
import type { Observation } from "./state.ts";

export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export type Verdict =
  | { allow: true; absent: true }
  | { allow: true; absent: false; key: string }
  | { allow: false; reason: string };

const code = (err: unknown) => (err as NodeJS.ErrnoException)?.code;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The gate for one write tool call. `abs` is the path the tool will write
 * (π's resolution), `shown` the path as the agent wrote it.
 */
export async function checkWrite(observations: ReadonlyMap<string, Observation>, abs: string, shown: string): Promise<Verdict> {
  try {
    await stat(abs);
  } catch (err) {
    if (code(err) === "ENOENT" || code(err) === "ENOTDIR") return { allow: true, absent: true };
    return { allow: false, reason: `edit-guard: cannot verify ${shown} (${message(err)}). Read it, then retry.` };
  }
  let key: string;
  let hash: string;
  try {
    key = fileKey(abs);
    const seen = observations.get(key);
    if (!seen) return { allow: false, reason: `edit-guard: ${shown} exists but was not read in this context. Read it, then retry.` };
    hash = await hashFile(key);
    if (hash !== seen.hash) return { allow: false, reason: `edit-guard: ${shown} changed since you read it (call #${seen.seq}). Read it again, then retry.` };
  } catch (err) {
    return { allow: false, reason: `edit-guard: cannot verify ${shown} (${message(err)}). Read it, then retry.` };
  }
  return { allow: true, absent: false, key };
}

/** The key and hash of the file a read will deliver, taken before the read runs; undefined when there is no such file. */
export async function observeBefore(abs: string): Promise<{ key: string; hash: string } | undefined> {
  try {
    const key = fileKey(abs);
    return { key, hash: await hashFile(key) };
  } catch {
    return undefined;
  }
}
