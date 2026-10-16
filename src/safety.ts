// Read-only removal checks: shared Scratchpad identity, environment drift, and Git cleanliness.

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { scratchpadState, statIfPresent } from "./scratchpad.ts";
import { readProvenance } from "./create.ts";
import {
  GENERATED_DIRS,
  isEnvFile,
  isExcluded,
  isGeneratedPath,
  matchIgnorePatterns,
  readSyncConfig,
  selectedByManifest,
} from "./sync.ts";
import { runAsync } from "./term.ts";

export interface SafetyFlag {
  kind: "dirty" | "status-unreadable" | "scratchpad-conflict" | "env-drift";
  detail: string;
}

export interface SafetyResult {
  /** true when removal may proceed */
  ok: boolean;
  flags: SafetyFlag[];
}

export interface SafetyOptions {
  /** Environment used to resolve the user's sync config; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
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
export function describeEnvDrift(
  rel: string,
  wtContent: string,
  primaryContent: string | null,
): string | null {
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

export interface EnvAssignments {
  map: Map<string, string>;
  /** true when a non-blank, non-comment line is not a KEY=value assignment */
  unparsed: boolean;
}

/** Parse `KEY=value` assignments; blank lines and `#` comments are ignored. */
export function parseEnvAssignments(content: string): EnvAssignments {
  const map = new Map<string, string>();
  let unparsed = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) {
      unparsed = true;
      continue;
    }
    const value = m[2]!.trim();
    const quoted = /^(?:"([^"\\$]*)"|'([^'\\$]*)')$/.exec(value);
    map.set(m[1]!, quoted ? (quoted[1] ?? quoted[2]!) : value);
  }
  return { map, unparsed };
}

/**
 * True when dropping the worktree's env file would lose configuration the
 * primary does not already hold: a lane `KEY=value` missing from the primary
 * or carrying a different value, a file absent from the primary, or content
 * this parser cannot classify. Extra primary keys, comment/ordering changes,
 * and other byte differences alone are lossless to discard.
 */
export function envDriftLosesContent(wtContent: string, primaryContent: string | null): boolean {
  if (primaryContent === null) return wtContent.trim().length > 0;
  const lane = parseEnvAssignments(wtContent);
  if (lane.unparsed) return true;
  const primary = parseEnvAssignments(primaryContent).map;
  for (const [key, value] of lane.map) {
    if (!primary.has(key) || primary.get(key) !== value) return true;
  }
  return false;
}

/** Single-quote a value for a copyable shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Guidance printed when an env-drift flag blocks removal. Both directions
 * clear the gate; the operator decides which side is authoritative. `lane` is
 * the lane's branch, or its path for a detached worktree.
 */
export function envDriftResolution(lane: string): string[] {
  const ref = shellQuote(lane);
  return [
    "env-drift blocks removal: the lane's env is not covered by the primary.",
    "Reconcile, then rerun; wt never forces. wt sync moves every selected ignored",
    "file, not only env, so preview the exact direction before applying:",
    `  primary -> lane: wt sync --dry-run --from primary --to ${ref}`,
    `  lane -> primary: wt sync --dry-run --from ${ref} --to primary`,
    `  overwrite the lane env: wt sync --from primary --to ${ref} --force`,
    `  adopt the lane env:     wt sync --from ${ref} --to primary --force`,
    "A lane-only env file has nothing to pull from the primary: adopt it into the",
    "primary or remove it from the lane; a primary->lane sync will not delete it.",
  ];
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

// Explicit selections are checked separately, so discovery can prune heavy artifact trees.
const WALK_SKIP = new Set<string>([".scratchpad", ".git", ...GENERATED_DIRS]);

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function inspectHiddenTrackedEnv(
  wtPath: string,
  path: string,
  mode: string,
  blob: string,
  skipWorktree: boolean,
): Promise<SafetyFlag | null> {
  const unreadable: SafetyFlag = {
    kind: "status-unreadable",
    detail: `cannot inspect saved tracked env: ${path}`,
  };
  const saved = await runAsync(["git", "-C", wtPath, "cat-file", "-e", `${blob}^{blob}`]);
  if (!saved.ok) return unreadable;
  try {
    const stat = statIfPresent(join(wtPath, path));
    // Sparse checkout can intentionally omit skip-worktree entries entirely.
    if (!stat) return skipWorktree ? null : unreadable;
    let hash: string;
    if (mode === "120000" && stat.isSymbolicLink()) {
      const result = Bun.spawnSync(["git", "-C", wtPath, "hash-object", "--stdin"], {
        stdin: Buffer.from(readlinkSync(join(wtPath, path))),
        stdout: "pipe",
        stderr: "pipe",
      });
      if (!result.success) return unreadable;
      hash = result.stdout.toString().trim();
    } else if ((mode === "100644" || mode === "100755" || mode === "120000") && stat.isFile()) {
      let conversion = ["--path", path];
      if (mode === "120000") {
        const symlinks = await runAsync([
          "git",
          "-C",
          wtPath,
          "config",
          "--type=bool",
          "--get",
          "core.symlinks",
        ]);
        if (symlinks.ok && symlinks.stdout.trim() === "false") conversion = ["--no-filters"];
        else if (symlinks.code === 1 || (symlinks.ok && symlinks.stdout.trim() === "true")) {
          return { kind: "dirty", detail: `tracked env type differs from index: ${path}` };
        } else return unreadable;
      }
      // Regular blobs use Git's clean conversion; emulated links contain raw link text.
      const result = await runAsync([
        "git",
        "-C",
        wtPath,
        "hash-object",
        ...conversion,
        "--",
        path,
      ]);
      if (!result.ok) return unreadable;
      hash = result.stdout.trim();
    } else {
      return { kind: "dirty", detail: `tracked env type differs from index: ${path}` };
    }
    return hash === blob
      ? null
      : { kind: "dirty", detail: `tracked env differs from index: ${path}` };
  } catch {
    return unreadable;
  }
}

export async function runSafetyPipeline(
  wtPath: string,
  repoRoot: string,
  opts: SafetyOptions = {},
): Promise<SafetyResult> {
  const flags: SafetyFlag[] = [];

  // 1. dirty — fail closed if status is unreadable
  const status = await runAsync([
    "git",
    "--no-optional-locks",
    "-C",
    wtPath,
    "status",
    "--porcelain",
  ]);
  if (!status.ok) {
    flags.push({ kind: "status-unreadable", detail: status.stderr.trim() });
  } else if (status.stdout.trim()) {
    const n = status.stdout.split("\n").filter(Boolean).length;
    flags.push({ kind: "dirty", detail: `${n} uncommitted change${n === 1 ? "" : "s"}` });
  }

  // Shared storage is checked by identity, never by scanning canonical contents.
  const scratchpad = scratchpadState(repoRoot, wtPath);
  if (scratchpad.kind === "invalid")
    flags.push({ kind: "scratchpad-conflict", detail: scratchpad.reason });
  if (scratchpad.kind === "legacy") {
    flags.push({
      kind: "scratchpad-conflict",
      detail:
        "local .scratchpad requires reconciliation; preview with wt scratchpad <target> --json",
    });
  }
  const metadata = await runAsync(["git", "-C", wtPath, "rev-parse", "--absolute-git-dir"]);
  if (!metadata.ok)
    flags.push({
      kind: "status-unreadable",
      detail: "cannot inspect Scratchpad migration recovery",
    });
  else if (
    statIfPresent(join(metadata.stdout.trim(), "wt-scratchpad-original")) ||
    statIfPresent(join(metadata.stdout.trim(), "wt-scratchpad-migration.lock"))
  ) {
    flags.push({
      kind: "scratchpad-conflict",
      detail: "Scratchpad migration is incomplete; retain this worktree and resume conversion",
    });
  }

  // Source env created after setup still needs protection, even when nothing was synced.
  const config = readSyncConfig(opts.env);
  const marker = readProvenance(wtPath);
  let candidates = [...walkFiles(wtPath, wtPath, (name) => WALK_SKIP.has(name))].filter(isEnvFile);
  if (marker) {
    candidates.push(...marker.syncedFiles.filter(isEnvFile));
    // Older markers cannot prove whether a generated path was deliberately selected.
    if (marker.sync?.mode === "legacy")
      candidates = candidates.filter((path) => !isGeneratedPath(path));
  }
  // Sync can adopt a new manifest after creation. Check both current policies
  // against lane files so even selections now absent from the primary survive.
  for (const root of new Set([repoRoot, wtPath])) {
    const manifestPath = join(root, ".worktreeinclude");
    if (existsSync(manifestPath))
      candidates.push(...(await selectedByManifest(wtPath, manifestPath)).filter(isEnvFile));
  }
  // Index flags can hide local edits from status. Compare those paths with the
  // saved blob without refreshing the index or changing its flags.
  const tracked = await runAsync([
    "git",
    "-C",
    wtPath,
    "ls-files",
    "--cached",
    "--stage",
    "-v",
    "-z",
  ]);
  if (!tracked.ok)
    flags.push({ kind: "status-unreadable", detail: "cannot inspect tracked env ownership" });
  else {
    const trackedPaths = new Set<string>();
    for (const entry of tracked.stdout.split("\0").filter(Boolean)) {
      const match = /^([A-Za-z]) ([0-7]{6}) ([0-9a-f]{40,64}) [0-3]\t([\s\S]*)$/.exec(entry);
      if (!match) {
        flags.push({ kind: "status-unreadable", detail: "cannot parse tracked env ownership" });
        continue;
      }
      const tag = match[1]!;
      const mode = match[2]!;
      const blob = match[3]!;
      const path = match[4]!;
      trackedPaths.add(path);
      if (isEnvFile(path) && (tag === "S" || tag !== tag.toUpperCase())) {
        const hidden = await inspectHiddenTrackedEnv(
          wtPath,
          path,
          mode,
          blob,
          tag.toUpperCase() === "S",
        );
        if (hidden) flags.push(hidden);
      }
    }
    candidates = candidates.filter((path) => !trackedPaths.has(path));
  }
  candidates = candidates.filter((path) => !isExcluded(path));
  const userExcludes = config.exclude;
  if (userExcludes.length > 0) {
    const userExcluded = await matchIgnorePatterns(candidates, userExcludes);
    candidates = candidates.filter((path) => !userExcluded.has(path));
  }
  for (const rel of new Set(candidates)) {
    const wtContent = readIfExists(join(wtPath, rel));
    if (wtContent === null) continue;
    const primaryContent = readIfExists(join(repoRoot, rel));
    const drift = describeEnvDrift(rel, wtContent, primaryContent);
    // Only block when removal would lose env content the primary lacks;
    // primary-superset drift is lossless to discard.
    if (drift && envDriftLosesContent(wtContent, primaryContent)) {
      flags.push({ kind: "env-drift", detail: drift });
    }
  }

  return { ok: flags.length === 0, flags };
}
