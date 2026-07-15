// Removal safety pipeline, adopted from the 2026-07-15 cleanup that removed
// 100 worktrees without losing data: salvage unique scratchpad notes, refuse
// on env drift (reporting key NAMES only, never values), refuse dirty trees.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { readProvenance } from "./create.ts";
import { runAsync } from "./term.ts";

export interface SafetyFlag {
  kind: "dirty" | "status-unreadable" | "scratchpad-conflict" | "env-drift";
  detail: string;
}

export interface SafetyResult {
  /** true when removal may proceed */
  ok: boolean;
  flags: SafetyFlag[];
  /** repo-relative scratchpad files copied into the primary's salvage archive */
  salvaged: string[];
}

export interface SafetyOptions {
  /** evaluate only — report what WOULD be salvaged without copying */
  dryRun?: boolean;
  /** date stamp for the salvage archive dir (tests pin it) */
  date?: string;
}

const ENV_BASENAME = /^(\.env(\..+)?|\.dev\.vars)$/;

/** Env file = .env, .env.*, .dev.vars — but never *.example. */
export function isEnvFile(rel: string): boolean {
  const name = basename(rel);
  if (name.endsWith(".example")) return false;
  return ENV_BASENAME.test(name);
}

/** Key NAMES of KEY=... lines. Values never leave this function. */
export function envKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const line of content.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) keys.add(m[1]!);
  }
  return keys;
}

/**
 * Compare an env file across worktree and primary; returns a names-only
 * description of the drift, or null when contents are byte-identical.
 */
export function describeEnvDrift(rel: string, wtContent: string, primaryContent: string | null): string | null {
  if (primaryContent !== null && wtContent === primaryContent) return null;
  if (primaryContent === null) {
    return `${rel}: missing in primary (${envKeys(wtContent).size} keys)`;
  }
  const wt = envKeys(wtContent);
  const pri = envKeys(primaryContent);
  const added = [...wt].filter((k) => !pri.has(k));
  const removed = [...pri].filter((k) => !wt.has(k));
  const parts: string[] = [];
  if (added.length) parts.push(`keys only in worktree: ${added.join(", ")}`);
  if (removed.length) parts.push(`keys only in primary: ${removed.join(", ")}`);
  if (!parts.length) parts.push("values differ");
  return `${rel}: ${parts.join("; ")}`;
}

function* walkFiles(
  dir: string,
  base: string = dir,
  skipDir?: (name: string) => boolean,
): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (!skipDir?.(name)) yield* walkFiles(full, base, skipDir);
    } else {
      yield relative(base, full);
    }
  }
}

// The no-provenance env fallback walks the whole worktree; skip .git and the
// heavy artifact dirs so the walk stays cheap.
const WALK_SKIP = new Set([".git", "node_modules", ".next", ".turbo", "dist", ".cache", "build", ".build", "Pods", "DerivedData"]);

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export async function runSafetyPipeline(
  wtPath: string,
  repoRoot: string,
  opts: SafetyOptions = {},
): Promise<SafetyResult> {
  const flags: SafetyFlag[] = [];
  const salvaged: string[] = [];
  const date = opts.date ?? new Date().toISOString().slice(0, 10);

  // 1. dirty — fail closed if status is unreadable
  const status = await runAsync(["git", "-C", wtPath, "status", "--porcelain"]);
  if (!status.ok) {
    flags.push({ kind: "status-unreadable", detail: status.stderr.trim() });
  } else if (status.stdout.trim()) {
    const n = status.stdout.split("\n").filter(Boolean).length;
    flags.push({ kind: "dirty", detail: `${n} uncommitted change${n === 1 ? "" : "s"}` });
  }

  // 2. scratchpad salvage — unique or worktree-older notes are archived;
  //    a worktree-NEWER conflicting note blocks removal
  const scratchDir = join(wtPath, ".scratchpad");
  const salvageRoot = join(repoRoot, ".scratchpad", "archive", `${date}-worktree-salvage`, basename(wtPath));
  if (existsSync(scratchDir)) {
    for (const rel of walkFiles(scratchDir)) {
      if (!rel.endsWith(".md")) continue;
      const wtFile = join(scratchDir, rel);
      const priFile = join(repoRoot, ".scratchpad", rel);
      const wtContent = readIfExists(wtFile);
      if (wtContent === null) continue;
      const priContent = readIfExists(priFile);
      if (priContent === wtContent) continue;
      if (priContent !== null) {
        const wtNewer = statSync(wtFile).mtimeMs > statSync(priFile).mtimeMs;
        if (wtNewer) {
          flags.push({ kind: "scratchpad-conflict", detail: `.scratchpad/${rel} is newer than primary's copy` });
          continue;
        }
      }
      if (!opts.dryRun) {
        const dest = join(salvageRoot, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(wtFile, dest);
      }
      salvaged.push(`.scratchpad/${rel}`);
    }
  }

  // 3. env drift — prefer the provenance marker's synced list, fall back to a walk
  const marker = readProvenance(wtPath);
  const candidates = marker
    ? marker.syncedFiles.filter(isEnvFile)
    : [...walkFiles(wtPath, wtPath, (name) => WALK_SKIP.has(name))].filter(isEnvFile);
  for (const rel of new Set(candidates)) {
    const wtContent = readIfExists(join(wtPath, rel));
    if (wtContent === null) continue;
    const drift = describeEnvDrift(rel, wtContent, readIfExists(join(repoRoot, rel)));
    if (drift) flags.push({ kind: "env-drift", detail: drift });
  }

  return { ok: flags.length === 0, flags, salvaged };
}
