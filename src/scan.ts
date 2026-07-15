// Worktree status scan: one record per worktree, probed in parallel.
// This is the data layer behind `wt ls`, `wt reap`, and the picker.

import { statSync } from "node:fs";
import { basename } from "node:path";
import { listWorktrees, originDefault, resolvePrimaryRepo, type WorktreeInfo } from "./git.ts";
import { pool, runAsync } from "./term.ts";

export type PrState = "open" | "merged" | "closed" | "none" | "unknown";

export interface WorktreeStatus {
  path: string;
  slug: string;
  branch: string | null;
  head: string;
  detached: boolean;
  primary: boolean;
  locked: boolean;
  prunable: boolean;
  dirty: boolean;
  dirtyCount: number;
  /** Ref ahead/behind is measured against: upstream if set, else origin default. */
  compareRef: string | null;
  ahead: number | null;
  behind: number | null;
  sizeKb: number | null;
  lastCommitAt: string | null;
  mtimeMs: number | null;
  prState: PrState;
  prNumber: number | null;
}

export interface PrInfo {
  headRefName: string;
  state: string;
  number: number;
}

export interface ScanOptions {
  env?: Record<string, string | undefined>;
  concurrency?: number;
}

/**
 * One repo-level `gh pr list` maps branches to PR state. Returns null when gh
 * is missing, unauthenticated, offline, or slow — the scan must never block
 * on network, so callers degrade to prState "unknown".
 */
export async function fetchPrs(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 8000,
): Promise<PrInfo[] | null> {
  if (!Bun.which("gh", { PATH: env.PATH ?? "" })) return null;
  try {
    const p = Bun.spawn(
      ["gh", "pr", "list", "--state", "all", "--limit", "200", "--json", "headRefName,state,number"],
      { cwd: repoRoot, env: env as Record<string, string>, stdout: "pipe", stderr: "ignore" },
    );
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    clearTimeout(timer);
    if (code !== 0) return null;
    return JSON.parse(stdout) as PrInfo[];
  } catch {
    return null;
  }
}

/** Newest PR wins when a branch has several (gh lists newest-first). */
export function prStateFor(
  branch: string | null,
  prs: PrInfo[] | null,
): { prState: PrState; prNumber: number | null } {
  if (prs === null) return { prState: "unknown", prNumber: null };
  if (!branch) return { prState: "none", prNumber: null };
  const pr = prs.find((p) => p.headRefName === branch);
  if (!pr) return { prState: "none", prNumber: null };
  const state = pr.state.toLowerCase();
  const prState: PrState =
    state === "open" || state === "merged" || state === "closed" ? state : "unknown";
  return { prState, prNumber: pr.number };
}

async function probe(
  wt: WorktreeInfo,
  repoRoot: string,
  defaultBranch: string | null,
): Promise<Omit<WorktreeStatus, "prState" | "prNumber">> {
  const g = (...args: string[]) => runAsync(["git", "-C", wt.path, ...args]);

  const [status, upstreamRes, sizeRes, lastCommitRes] = await Promise.all([
    g("status", "--porcelain"),
    g("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
    runAsync(["du", "-sk", wt.path]),
    g("log", "-1", "--format=%cI"),
  ]);

  const upstream = upstreamRes.ok ? upstreamRes.stdout.trim() : null;
  const compareRef = upstream ?? (defaultBranch ? `origin/${defaultBranch}` : null);

  let ahead: number | null = null;
  let behind: number | null = null;
  if (compareRef) {
    const counts = await g("rev-list", "--left-right", "--count", `${compareRef}...HEAD`);
    if (counts.ok) {
      const [left, right] = counts.stdout.trim().split(/\s+/);
      behind = Number(left ?? "0");
      ahead = Number(right ?? "0");
    }
  }

  const dirtyLines = status.ok ? status.stdout.split("\n").filter(Boolean) : [];
  let mtimeMs: number | null = null;
  try {
    mtimeMs = statSync(wt.path).mtimeMs;
  } catch {
    // worktree dir may be gone (prunable) — keep the record, without mtime
  }

  return {
    path: wt.path,
    slug: basename(wt.path),
    branch: wt.branch,
    head: wt.head,
    detached: wt.detached,
    primary: wt.path === repoRoot,
    locked: wt.locked,
    prunable: wt.prunable,
    dirty: dirtyLines.length > 0,
    dirtyCount: dirtyLines.length,
    compareRef,
    ahead,
    behind,
    sizeKb: sizeRes.ok ? Number(sizeRes.stdout.trim().split(/\s+/)[0]) : null,
    lastCommitAt: lastCommitRes.ok ? lastCommitRes.stdout.trim() || null : null,
    mtimeMs,
  };
}

export async function scanWorktrees(cwd: string, opts: ScanOptions = {}): Promise<WorktreeStatus[]> {
  const repoRoot = resolvePrimaryRepo(cwd);
  const worktrees = listWorktrees(repoRoot);
  const defaultBranch = originDefault(repoRoot);
  const prsPromise = fetchPrs(repoRoot, opts.env ?? process.env);
  const probed = await pool(worktrees, opts.concurrency ?? 10, (w) =>
    probe(w, repoRoot, defaultBranch),
  );
  const prs = await prsPromise;
  return probed.map((r) => ({ ...r, ...prStateFor(r.branch, prs) }));
}
