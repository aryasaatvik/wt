// Read-only removal checks: shared Scratchpad identity, environment drift, and Git cleanliness.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { scratchpadState, statIfPresent } from "./scratchpad.ts";
import { readProvenance } from "./create.ts";
import { isEnvFile, isExcluded, matchIgnorePatterns, readSyncConfig } from "./sync.ts";
import { runAsync } from "./term.ts";

export interface SafetyFlag {
  kind: "dirty" | "status-unreadable" | "scratchpad-conflict" | "env-drift";
  detail: string;
}

export interface SafetyResult {
  /** true when removal may proceed */
  ok: boolean;
  flags: SafetyFlag[];
  /** Retained in removal reports for existing consumers; shared storage never needs salvage. */
  salvaged: string[];
}

export interface SafetyOptions {
  /** Compatibility with existing callers; checks are always read-only. */
  dryRun?: boolean;
  /** Legacy archive date, no longer used. */
  date?: string;
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
      stat = lstatSync(full);
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
const WALK_SKIP = new Set([".scratchpad", ".git", "node_modules", ".next", ".turbo", "dist", ".cache", "build", ".build", "Pods", "DerivedData"]);

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


  // 1. dirty — fail closed if status is unreadable
  const status = await runAsync(["git", "-C", wtPath, "status", "--porcelain"]);
  if (!status.ok) {
    flags.push({ kind: "status-unreadable", detail: status.stderr.trim() });
  } else if (status.stdout.trim()) {
    const n = status.stdout.split("\n").filter(Boolean).length;
    flags.push({ kind: "dirty", detail: `${n} uncommitted change${n === 1 ? "" : "s"}` });
  }

  // Shared storage is checked by identity, never by scanning canonical contents.
  const scratchpad = scratchpadState(repoRoot, wtPath);
  if (scratchpad.kind === "invalid") flags.push({ kind: "scratchpad-conflict", detail: scratchpad.reason });
  if (scratchpad.kind === "legacy") {
    flags.push({ kind: "scratchpad-conflict", detail: "local .scratchpad requires reconciliation; preview with wt scratchpad <target> --json" });
  }
  const metadata = await runAsync(["git", "-C", wtPath, "rev-parse", "--absolute-git-dir"]);
  if (!metadata.ok) flags.push({ kind: "status-unreadable", detail: "cannot inspect Scratchpad migration recovery" });
  else if (statIfPresent(join(metadata.stdout.trim(), "wt-scratchpad-original")) || statIfPresent(join(metadata.stdout.trim(), "wt-scratchpad-migration.lock"))) {
    flags.push({ kind: "scratchpad-conflict", detail: "Scratchpad migration is incomplete; retain this worktree and resume conversion" });
  }

  // 3. env drift — prefer the provenance marker's synced list, fall back to a walk
  const marker = readProvenance(wtPath);
  let candidates = marker
    ? marker.syncedFiles.filter((path) => isEnvFile(path) && path !== ".scratchpad" && !path.startsWith(".scratchpad/"))
    : [...walkFiles(wtPath, wtPath, (name) => WALK_SKIP.has(name))].filter(isEnvFile);
  candidates = candidates.filter((path) => !isExcluded(path));
  const userExcludes = readSyncConfig().exclude;
  if (userExcludes.length > 0) {
    const userExcluded = await matchIgnorePatterns(candidates, userExcludes);
    candidates = candidates.filter((path) => !userExcluded.has(path));
  }
  for (const rel of new Set(candidates)) {
    const wtContent = readIfExists(join(wtPath, rel));
    if (wtContent === null) continue;
    const drift = describeEnvDrift(rel, wtContent, readIfExists(join(repoRoot, rel)));
    if (drift) flags.push({ kind: "env-drift", detail: drift });
  }

  return { ok: flags.length === 0, flags, salvaged };
}
