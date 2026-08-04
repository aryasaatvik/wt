// Worktree status scan: one record per worktree, probed in parallel.
// This is the data layer behind `wt ls`, `wt reap`, and the picker.

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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
 * Returns null when nothing could be resolved, so callers keep their old value.
 */
export async function prForCommit(
  repos: RemoteRepo[],
  sha: string,
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 8000,
): Promise<{ prState: PrState; prNumber: number | null } | null> {
  if (!Bun.which("gh", { PATH: env.PATH ?? "" })) return null;
  const candidates: Array<{ prState: PrState; prNumber: number }> = [];
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
      // 404/422 (unpushed commit, no access) is a normal answer here, not an error
      if (code !== 0) continue;
      for (const line of stdout.split("\n").filter(Boolean)) {
        const [num, state] = line.split("\t");
        const prState = String(state).toLowerCase();
        if (prState !== "open" && prState !== "merged" && prState !== "closed") continue;
        candidates.push({ prState, prNumber: Number(num) });
      }
    } catch {
      // gh missing mid-scan or spawn failure — try the next remote
    }
  }
  return candidates.length > 0 ? pickPr(candidates) : null;
}

// du over a big node_modules tree is the dominant cost of a scan, and sizes
// only change meaningfully on installs/builds — a day-old answer is honest
// for a status display. `wt ls --fresh` remeasures on demand.
const SIZE_CACHE_TTL_MS = 24 * 3600_000;
const SIZE_CACHE_FILE = "wt-size.json";

/**
 * Measure a worktree's disk size, reusing a cached `du` result younger than
 * the TTL. The cache lives in the worktree's own gitdir (`.git/worktrees/
 * <name>/` for lanes, `.git/` for the primary), so git removes it with the
 * worktree and strays are covered too. All cache IO is best-effort: a
 * missing, corrupt, or unwritable cache degrades to a fresh `du`.
 */
async function measureSize(
  wtPath: string,
  mode: SizeMode,
): Promise<{ sizeKb: number | null; sizeCached: boolean }> {
  if (mode === "skip") return { sizeKb: null, sizeCached: false };

  const gitDirRes = await runAsync(["git", "-C", wtPath, "rev-parse", "--absolute-git-dir"]);
  const cachePath = gitDirRes.ok ? join(gitDirRes.stdout.trim(), SIZE_CACHE_FILE) : null;

  if (mode === "cached" && cachePath) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as {
        sizeKb?: unknown;
        sizedAt?: unknown;
      };
      // ageMs >= 0: a future-dated entry (clock jumped backward) must count
      // as stale, or it would bypass the TTL forever
      const ageMs = Date.now() - Date.parse(String(cached.sizedAt));
      if (typeof cached.sizeKb === "number" && Number.isFinite(cached.sizeKb) && ageMs >= 0 && ageMs < SIZE_CACHE_TTL_MS) {
        return { sizeKb: cached.sizeKb, sizeCached: true };
      }
    } catch {
      // no cache yet, or unreadable/corrupt — fall through to a fresh du
    }
  }

  const du = await runAsync(["du", "-sk", wtPath]);
  if (!du.ok) return { sizeKb: null, sizeCached: false };
  const sizeKb = Number(du.stdout.trim().split(/\s+/)[0]);
  // exit 0 with malformed output must degrade like a failed du, not cache NaN
  if (!Number.isFinite(sizeKb)) return { sizeKb: null, sizeCached: false };
  if (cachePath) {
    try {
      writeFileSync(cachePath, `${JSON.stringify({ sizeKb, sizedAt: new Date().toISOString() })}\n`);
    } catch {
      // read-only gitdir — the size is still fresh, just not cached
    }
  }
  return { sizeKb, sizeCached: false };
}

async function probe(
  wt: WorktreeInfo,
  repoRoot: string,
  defaultBranch: string | null,
  sizeMode: SizeMode,
): Promise<Omit<WorktreeStatus, "prState" | "prNumber">> {
  const g = (...args: string[]) => runAsync(["git", "-C", wt.path, ...args]);

  const [status, upstreamRes, size, lastCommitRes] = await Promise.all([
    g("status", "--porcelain"),
    g("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
    measureSize(wt.path, sizeMode),
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
    sizeKb: size.sizeKb,
    sizeCached: size.sizeCached,
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
    probe(w, repoRoot, defaultBranch, opts.sizeMode ?? "cached"),
  );
  const listing = await prsPromise;
  const records = probed.map((r) => ({ ...r, ...prStateFor(r.branch, listing) }));

  // Branch matching is blind to detached lanes and to PRs opened on a remote
  // other than origin. Both read as "none", which is the most dangerous answer
  // a removal tool can get — re-ask by commit before believing it.
  if (opts.resolvePrsByCommit === false) return records;
  const repos = await remoteRepos(repoRoot);
  if (repos.length === 0) return records;
  return pool(records, opts.concurrency ?? 10, async (r) => {
    if (r.primary || r.prState !== "none") return r;
    const resolved = await prForCommit(repos, r.head, opts.env ?? process.env);
    return resolved ? { ...r, ...resolved } : r;
  });
}
