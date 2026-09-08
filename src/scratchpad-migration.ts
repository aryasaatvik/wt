import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { resolvePrimaryRepo } from "./git.ts";
import { resolveTarget } from "./rm.ts";
import { assertUntrackedScratchpad, ensureSharedScratchpad, scratchpadState, statIfPresent } from "./scratchpad.ts";
import { runAsync } from "./term.ts";

interface Entry {
  path: string;
  kind: "file" | "directory" | "symlink";
  hash: string | null;
  mode: number;
}

export interface Resolution {
  path: string;
  sourceHash: string;
  disposition: "integrated" | "superseded" | "preserved";
  reason: string;
  /** A regular document or artifact under canonical Scratchpad, never an external path. */
  evidence: { path: string; hash: string };
}

export interface MigrationPlan {
  version: 1;
  primary: string;
  worktree: string;
  head: string;
  state: "absent" | "shared" | "legacy";
  sourceHash: string;
  entries: Array<Entry & { status: "identical" | "directory" | "review" }>;
  resolutions: Resolution[];
}

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Every entry type participates in the fingerprint; symlinks are read, never followed. */
function inventory(root: string): Entry[] {
  if (!statIfPresent(root)) return [];
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error(`expected real directory: ${root}`);
  const entries: Entry[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const base = { path: relative(root, path), mode: stat.mode & 0o777 };
      if (stat.isSymbolicLink()) entries.push({ ...base, kind: "symlink", hash: digest(readlinkSync(path)) });
      else if (stat.isDirectory()) { entries.push({ ...base, kind: "directory", hash: null }); walk(path); }
      else if (stat.isFile()) entries.push({ ...base, kind: "file", hash: digest(readFileSync(path)) });
      else throw new Error(`unsupported Scratchpad entry: ${base.path}`);
    }
  }
  walk(root);
  return entries;
}

/** Evidence paths cannot escape canonical storage through traversal or ancestor links. */
function regularEvidence(root: string, path: string): { hash: string; mode: number } | null {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).some((p) => p === ".." || p === "." || p === "")) {
    throw new Error(`invalid canonical evidence path: ${path}`);
  }
  let current = root;
  if (!statIfPresent(root)) return null;
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("canonical Scratchpad is not a real directory");
  const parts = path.split(sep);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    const stat = statIfPresent(current);
    if (!stat) return null;
    if (stat.isSymbolicLink()) return null;
    if (i < parts.length - 1 && !stat.isDirectory()) return null;
    if (i === parts.length - 1) return stat.isFile() ? { hash: digest(readFileSync(current)), mode: stat.mode & 0o777 } : null;
  }
  return null;
}

async function context(cwd: string, target: string) {
  const primary = resolvePrimaryRepo(cwd);
  const wt = resolveTarget(target, cwd);
  if (!wt) throw new Error(`registered non-primary worktree not found: ${target}`);
  await assertUntrackedScratchpad(primary);
  await assertUntrackedScratchpad(wt.path);
  const git = await runAsync(["git", "-C", wt.path, "rev-parse", "--absolute-git-dir"]);
  if (!git.ok) throw new Error(`cannot resolve worktree metadata: ${git.stderr}`);
  const gitDir = git.stdout.trim();
  const backup = join(gitDir, "wt-scratchpad-original");
  const state = scratchpadState(primary, wt.path);
  if (state.kind === "invalid") throw new Error(state.reason);
  if (statIfPresent(backup) && state.kind === "legacy") throw new Error(`both local and recovery Scratchpads exist; inspect ${backup}`);
  return { primary, wt, gitDir, backup, state, source: statIfPresent(backup) ? backup : join(wt.path, ".scratchpad") };
}

export async function planScratchpadMigration(cwd: string, target: string): Promise<MigrationPlan> {
  const ctx = await context(cwd, target);
  const recovering = !!statIfPresent(ctx.backup);
  const entries = ctx.state.kind === "shared" && !recovering ? [] : inventory(ctx.source);
  const canonical = join(ctx.primary, ".scratchpad");
  return {
    version: 1, primary: ctx.primary, worktree: ctx.wt.path, head: ctx.wt.head,
    state: recovering ? "legacy" : ctx.state.kind,
    sourceHash: digest(JSON.stringify(entries)),
    entries: entries.map((entry) => {
      const evidence = entry.kind === "file" ? regularEvidence(canonical, entry.path) : null;
      return { ...entry, status: entry.kind === "directory" ? "directory" : evidence?.hash === entry.hash && evidence.mode === entry.mode ? "identical" : "review" };
    }),
    resolutions: [],
  };
}

function validate(plan: MigrationPlan, current: MigrationPlan): void {
  if (plan.version !== 1 || plan.primary !== current.primary || plan.worktree !== current.worktree || plan.head !== current.head || plan.sourceHash !== current.sourceHash) {
    throw new Error("migration snapshot changed; generate and review a fresh plan");
  }
  if (!Array.isArray(plan.resolutions)) throw new Error("resolutions must be an array");
  const resolutions = new Map<string, Resolution>();
  for (const decision of plan.resolutions) {
    if (!decision || typeof decision.path !== "string" || resolutions.has(decision.path)) throw new Error("invalid or duplicate resolution");
    resolutions.set(decision.path, decision);
  }
  for (const entry of current.entries) {
    if (entry.status !== "review") continue;
    const decision = resolutions.get(entry.path);
    if (!decision || decision.sourceHash !== entry.hash || !["integrated", "superseded", "preserved"].includes(decision.disposition) || typeof decision.reason !== "string" || !decision.reason.trim()) {
      throw new Error(`unreconciled Scratchpad entry: ${entry.path}`);
    }
    if (!decision.evidence || typeof decision.evidence.path !== "string" || typeof decision.evidence.hash !== "string") throw new Error(`missing canonical evidence: ${entry.path}`);
    const evidence = regularEvidence(join(current.primary, ".scratchpad"), decision.evidence.path);
    if (!evidence || evidence.hash !== decision.evidence.hash) throw new Error(`canonical evidence changed or missing: ${entry.path}`);
    if (decision.disposition === "preserved" && (entry.kind !== "file" || evidence.hash !== entry.hash || evidence.mode !== entry.mode)) {
      throw new Error(`preserved requires an identical regular artifact; reconcile symlink meaning explicitly: ${entry.path}`);
    }
  }
  for (const path of resolutions.keys()) if (!current.entries.some((entry) => entry.path === path)) throw new Error(`resolution is outside the source snapshot: ${path}`);
}

/** Run only after the lane's writers are paused. A failed transaction retains the original in its private gitdir. */
export async function applyScratchpadMigration(cwd: string, target: string, plan: MigrationPlan): Promise<{ state: "shared"; worktree: string }> {
  const ctx = await context(cwd, target);
  const lock = join(ctx.gitDir, "wt-scratchpad-migration.lock");
  try { mkdirSync(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`migration lock exists: ${lock}; verify no migration is running before removing a stale lock`);
    throw error;
  }
  try {
    const current = await planScratchpadMigration(cwd, target);
    if (current.state === "shared" && plan.version === 1 && plan.primary === current.primary && plan.worktree === current.worktree && plan.head === current.head) return { state: "shared", worktree: ctx.wt.path };
    validate(plan, current);
    // Persist the decisions before moving anything; an interrupted run can be resumed
    // with the same plan or a freshly reviewed preview of the retained original.
    writeFileSync(join(ctx.gitDir, "wt-scratchpad-migration.json"), JSON.stringify(plan, null, 2) + "\n");
    if (current.state === "legacy" && !statIfPresent(ctx.backup)) renameSync(join(ctx.wt.path, ".scratchpad"), ctx.backup);
    await ensureSharedScratchpad(ctx.primary, ctx.wt.path);
    // Recheck the retained tree and canonical witnesses after linking, before disposal.
    validate(plan, await planScratchpadMigration(cwd, target));
    if (statIfPresent(ctx.backup)) rmSync(ctx.backup, { recursive: true });
    return { state: "shared", worktree: ctx.wt.path };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}. If present, recovery content is retained at ${ctx.backup}`);
  } finally { rmSync(lock, { recursive: true }); }
}
