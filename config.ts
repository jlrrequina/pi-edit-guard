/**
 * Configuration: `<agentDir>/pi-edit-guard/config.json`, every key optional.
 * A bad key is reported and replaced by its default; it never disables the guard.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A tool that mutates exactly one known path. */
export type WriteTool = {
  /** Input argument that holds the path. */
  path: string;
  /** Only calls whose input has this argument set to a truthy value write (lsp_fix writes only with `write: true`). */
  when?: string;
  /** Whether the result tells the agent the new content, so the file counts as observed after the write. */
  observes: boolean;
};

export type Config = {
  freshness: boolean;
  snapshots: boolean;
  loop: boolean;
  repeatLimit: number;
  readTools: ReadonlySet<string>;
  writeTools: ReadonlyMap<string, WriteTool>;
  readOnlyTools: ReadonlySet<string>;
  volatileTools: ReadonlySet<string>;
  exclude: readonly string[];
  keepRuns: number;
  storeMaxAgeDays: number;
};

export const DEFAULT_WRITE_TOOLS: Readonly<Record<string, WriteTool>> = {
  edit: { path: "path", observes: true },
  write: { path: "path", observes: true },
};

/** Added when a tool of this name is registered and `writeTools` is not configured: it writes only with `write: true`, and its result does not contain the new text. */
export const OPTIONAL_WRITE_TOOLS: Readonly<Record<string, WriteTool>> = {
  lsp_fix: { path: "path", when: "write", observes: false },
};

export const DEFAULTS = {
  freshness: true,
  snapshots: true,
  loop: true,
  repeatLimit: 3,
  readTools: ["read"],
  readOnlyTools: ["read", "grep", "find", "ls", "ffgrep", "fffind", "tool_search", "vcc_recall", "lsp_diagnostics"],
  volatileTools: ["bash", "powershell", "interactive_shell", "agent_browser", "agent_browser_code", "web_search", "fetch_content", "codemode", "run_checks"],
  exclude: [] as string[],
  keepRuns: 20,
  storeMaxAgeDays: 30,
};

/** Store excludes for roots that are not git work trees; a git root uses the project's own ignore rules. */
export const DEFAULT_EXCLUDES = [".git", "node_modules", ".pnpm-store", "dist", "build", "out", "target", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".cache", "coverage", ".DS_Store"];

export type LoadedConfig = { config: Config; errors: string[]; writeToolsConfigured: boolean };

export function configPath(agentDir: string): string {
  return join(agentDir, "pi-edit-guard", "config.json");
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);

function writeToolsFrom(v: unknown): Map<string, WriteTool> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out = new Map<string, WriteTool>();
  for (const [name, spec] of Object.entries(v)) {
    if (typeof spec === "string" && spec) out.set(name, { path: spec, observes: true });
    else if (typeof spec === "object" && spec !== null && typeof (spec as WriteTool).path === "string") {
      const s = spec as Partial<WriteTool>;
      if (s.when !== undefined && typeof s.when !== "string") return undefined;
      if (s.observes !== undefined && typeof s.observes !== "boolean") return undefined;
      out.set(name, { path: s.path!, ...(s.when ? { when: s.when } : {}), observes: s.observes ?? true });
    } else return undefined;
  }
  return out;
}

/** Validate a parsed config object. Unknown keys and wrong types are errors; their defaults apply. */
export function parseConfig(raw: unknown): LoadedConfig {
  const errors: string[] = [];
  const obj = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (raw !== undefined && obj !== raw) errors.push("the file must contain a JSON object");
  const known = new Set(["freshness", "snapshots", "loop", "repeatLimit", "readTools", "writeTools", "readOnlyTools", "volatileTools", "exclude", "keepRuns", "storeMaxAgeDays"]);
  for (const k of Object.keys(obj)) if (!known.has(k)) errors.push(`unknown key "${k}"`);

  const bool = (k: "freshness" | "snapshots" | "loop"): boolean => {
    if (obj[k] === undefined) return DEFAULTS[k];
    if (typeof obj[k] === "boolean") return obj[k] as boolean;
    errors.push(`"${k}" must be true or false`);
    return DEFAULTS[k];
  };
  const int = (k: "repeatLimit" | "keepRuns" | "storeMaxAgeDays", min: number): number => {
    const v = obj[k];
    if (v === undefined) return DEFAULTS[k];
    if (typeof v === "number" && Number.isInteger(v) && v >= min) return v;
    errors.push(`"${k}" must be an integer >= ${min}`);
    return DEFAULTS[k];
  };
  const list = (k: "readTools" | "readOnlyTools" | "volatileTools" | "exclude"): string[] => {
    const v = obj[k];
    if (v === undefined) return DEFAULTS[k];
    if (isStringArray(v)) return v;
    errors.push(`"${k}" must be an array of non-empty strings`);
    return DEFAULTS[k];
  };

  let writeTools = new Map(Object.entries(DEFAULT_WRITE_TOOLS));
  const writeToolsConfigured = obj.writeTools !== undefined;
  if (writeToolsConfigured) {
    const parsed = writeToolsFrom(obj.writeTools);
    if (parsed) writeTools = parsed;
    else errors.push(`"writeTools" must map tool names to an argument name or to { path, when?, observes? }`);
  }

  return {
    config: {
      freshness: bool("freshness"),
      snapshots: bool("snapshots"),
      loop: bool("loop"),
      repeatLimit: int("repeatLimit", 2),
      readTools: new Set(list("readTools")),
      writeTools,
      readOnlyTools: new Set(list("readOnlyTools")),
      volatileTools: new Set(list("volatileTools")),
      exclude: list("exclude"),
      keepRuns: int("keepRuns", 1),
      storeMaxAgeDays: int("storeMaxAgeDays", 1),
    },
    errors,
    writeToolsConfigured,
  };
}

/** Read the config file. A missing file is the default config; an unreadable or invalid one is reported. */
export function loadConfig(agentDir: string): LoadedConfig {
  const path = configPath(agentDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return parseConfig(undefined);
    const loaded = parseConfig(undefined);
    loaded.errors.push(`cannot read ${path}: ${(err as Error).message}`);
    return loaded;
  }
  try {
    return parseConfig(JSON.parse(text));
  } catch (err) {
    const loaded = parseConfig(undefined);
    loaded.errors.push(`${path} is not valid JSON: ${(err as Error).message}`);
    return loaded;
  }
}

/** Add optional write tools (lsp_fix) that are registered in this session, unless writeTools is configured. */
export function withRegisteredWriteTools(loaded: LoadedConfig, registered: ReadonlySet<string>): Config {
  if (loaded.writeToolsConfigured) return loaded.config;
  const writeTools = new Map(loaded.config.writeTools);
  for (const [name, spec] of Object.entries(OPTIONAL_WRITE_TOOLS)) if (registered.has(name)) writeTools.set(name, spec);
  return { ...loaded.config, writeTools };
}
