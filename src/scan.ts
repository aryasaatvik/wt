// Worktree status scan: one record per worktree, probed in parallel.
// This is the data layer behind `wt ls`, `wt reap`, and the picker.

import { statSync } from "node:fs";
import { basename } from "node:path";
import { measureDiskUsage, type WorktreeDiskReport, type WorktreeDiskUsage } from "./disk.ts";
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
  /** true when sizeKb came from the on-disk cache rather than a fresh `du` */
  sizeCached: boolean;
  /** Owned checkout + lane-private Git metadata; shared Git storage is separate. */
  diskUsage: WorktreeDiskUsage | null;
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

/** "cached" reuses a recent `du` result; "fresh" always remeasures; "skip" omits size. */
export type SizeMode = "cached" | "fresh" | "skip";

export interface ScanOptions {
  env?: Record<string, string | undefined>;
  concurrency?: number;
  sizeMode?: SizeMode;
  /** Resolve unmatched lanes by commit (one API call each). Default true. */
  resolvePrsByCommit?: boolean;
}

export interface RemoteRepo {
  name: string;
  nwo: string;
}

export interface PrListing {
  prs: PrInfo[];
  /** false when the listing may be truncated by the fetch limit */
  complete: boolean;
}

const PR_LIST_LIMIT = 1000;

/**
 * One repo-level `gh pr list` maps branches to PR state. Returns null when gh
 * is missing, unauthenticated, offline, or slow — the scan must never block
 * on network, so callers degrade to prState "unknown".
 */
export async function fetchPrs(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 8000,
): Promise<PrListing | null> {
  if (!Bun.which("gh", { PATH: env.PATH ?? "" })) return null;
  try {
    const p = Bun.spawn(
      ["gh", "pr", "list", "--state", "all", "--limit", String(PR_LIST_LIMIT), "--json", "headRefName,state,number"],
      { cwd: repoRoot, env: env as Record<string, string>, stdout: "pipe", stderr: "ignore" },
    );
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    clearTimeout(timer);
    if (code !== 0) return null;
    const prs = JSON.parse(stdout) as PrInfo[];
    return { prs, complete: prs.length < PR_LIST_LIMIT };
  } catch {
    return null;
  }
}

/** Newest PR wins when a branch has several (gh lists newest-first). */
export function prStateFor(
  branch: string | null,
  listing: PrListing | null,
): { prState: PrState; prNumber: number | null } {
  if (listing === null) return { prState: "unknown", prNumber: null };
  if (!branch) return { prState: "none", prNumber: null };
  const pr = listing.prs.find((p) => p.headRefName === branch);
  if (!pr) {
    // a miss in a truncated listing proves nothing — don't claim "no PR"
    return { prState: listing.complete ? "none" : "unknown", prNumber: null };
  }
  const state = pr.state.toLowerCase();
  const prState: PrState =
    state === "open" || state === "merged" || state === "closed" ? state : "unknown";
  return { prState, prNumber: pr.number };
}

const GITHUB_REMOTE = /github\.com[:/](.+?)(?:\.git)?$/;

/**
 * GitHub remotes as owner/name, origin first. A fork workflow puts the PR on
 * `upstream`, so a listing that only ever asks origin reports "no PR" for work
 * that is very much open.
 */
export async function remoteRepos(cwd: string): Promise<RemoteRepo[]> {
  const list = await runAsync(["git", "-C", cwd, "remote"]);
  if (!list.ok) return [];
  const names = list.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  names.sort((a, b) => Number(b === "origin") - Number(a === "origin"));
  const repos: RemoteRepo[] = [];
  for (const name of names) {
    const url = await runAsync(["git", "-C", cwd, "remote", "get-url", name]);
    const nwo = url.ok ? GITHUB_REMOTE.exec(url.stdout.trim())?.[1] : undefined;
    if (nwo && !repos.some((r) => r.nwo === nwo)) repos.push({ name, nwo });
  }
  return repos;
}

/**
 * Open beats merged beats closed. If a commit sits in several PRs, the most
 * live one decides: treating an open lane as merged is how you delete work in
 * progress, while treating a merged lane as open only costs disk.
 */
const PR_RANK: Record<string, number> = { open: 3, merged: 2, closed: 1 };

export function pickPr(
  candidates: Array<{ prState: PrState; prNumber: number }>,
): { prState: PrState; prNumber: number | null } | null {
  let best: { prState: PrState; prNumber: number } | null = null;
  for (const c of candidates) {
    if (!best || (PR_RANK[c.prState] ?? 0) > (PR_RANK[best.prState] ?? 0)) best = c;
  }
  return best;
}

/**
 * PRs associated with a commit, across every GitHub remote. This is the only
 * mapping that works for a detached lane — it has no branch for a headRefName
 * match, which is exactly how a stack CLI leaves a worktree after it merges.
 * Returns unknown when any remote lookup fails, because partial evidence must
 * not authorize removal. An open result is safe to return even from a partial
 * lookup because it vetoes removal. Returns null only when gh is unavailable.
 */
export async function prForCommit(
  repos: RemoteRepo[],
  sha: string,
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 8000,
): Promise<{ prState: PrState; prNumber: number | null } | null> {
  if (!Bun.which("gh", { PATH: env.PATH ?? "" })) return null;
  const candidates: Array<{ prState: PrState; prNumber: number }> = [];
  let complete = true;
  for (const { nwo } of repos) {
    try {
      const p = Bun.spawn(
        [
          "gh",
          "api",
          `repos/${nwo}/commits/${sha}/pulls`,
          "--jq",
          '.[] | [.number, (if .merged_at then "merged" else .state end)] | @tsv',
        ],
        { env: env as Record<string, string>, stdout: "pipe", stderr: "ignore" },
      );
      const timer = setTimeout(() => p.kill(), timeoutMs);
      const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      clearTimeout(timer);
      if (code !== 0) {
        complete = false;
        continue;
      }
      for (const line of stdout.split("\n").filter(Boolean)) {
        const [num, state] = line.split("\t");
        const prState = String(state).toLowerCase();
        if (prState !== "open" && prState !== "merged" && prState !== "closed") continue;
        candidates.push({ prState, prNumber: Number(num) });
      }
    } catch {
      complete = false;
    }
  }
  const best = pickPr(candidates);
  if (best?.prState === "open") return best;
  if (!complete) return { prState: "unknown", prNumber: null };
  return best ?? { prState: "none", prNumber: null };
}

async function probe(
  wt: WorktreeInfo,
  repoRoot: string,
  defaultBranch: string | null,
  disk: { usage: WorktreeDiskUsage; cached: boolean } | null,
): Promise<Omit<WorktreeStatus, "prState" | "prNumber">> {
  const g = (...args: string[]) => runAsync(["git", "-C", wt.path, ...args]);

  const [status, upstreamRes, lastCommitRes] = await Promise.all([
    g("status", "--porcelain"),
    g("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
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
    sizeKb: disk?.usage.ownedKb ?? null,
    sizeCached: disk?.cached ?? false,
    diskUsage: disk?.usage ?? null,
    lastCommitAt: lastCommitRes.ok ? lastCommitRes.stdout.trim() || null : null,
    mtimeMs,
  };
}

export async function scanWorktrees(cwd: string, opts: ScanOptions = {}): Promise<WorktreeStatus[]> {
  const repoRoot = resolvePrimaryRepo(cwd);
  const worktrees = listWorktrees(repoRoot);
  const defaultBranch = originDefault(repoRoot);
  const prsPromise = fetchPrs(repoRoot, opts.env ?? process.env);
  const sizeMode = opts.sizeMode ?? "cached";
  const diskReports = sizeMode === "skip" ? [] : await measureDiskUsage(repoRoot, sizeMode);
  const availableDisk = diskReports.filter(
    (report): report is WorktreeDiskReport & { usage: WorktreeDiskUsage } => report.usage !== null,
  );
  const diskByPath = new Map(availableDisk.map((report) => [report.path, report]));
  const probed = await pool(worktrees, opts.concurrency ?? 10, (w) =>
    probe(w, repoRoot, defaultBranch, diskByPath.get(w.path) ?? null),
  );
  const listing = await prsPromise;
  const records = probed.map((r) => ({ ...r, ...prStateFor(r.branch, listing) }));

  // Branch matching is blind to detached lanes, PRs opened on another remote,
  // and misses in truncated listings. Only a known-open PR is already the
  // highest-ranked answer; reconcile every other state across remotes by
  // commit. An unresolved unknown remains a removal veto.
  if (opts.resolvePrsByCommit === false) return records;
  const repos = await remoteRepos(repoRoot);
  if (repos.length === 0) return records;
  return pool(records, opts.concurrency ?? 10, async (r) => {
    if (r.primary || r.prState === "open") return r;
    const resolved = await prForCommit(repos, r.head, opts.env ?? process.env);
    return resolved ? { ...r, ...resolved } : r;
  });
}
