// Reachability verdicts for worktrees — the classification proven on 90
// detached lanes during the 2026-07-15 cleanup (75 safe, 15 stranded).
// Read-only: no fetch, no mutation.

import { originDefault } from "./git.ts";
import type { PrState } from "./scan.ts";
import { runAsync } from "./term.ts";

export type VerdictKind =
  | "REACHABLE" // HEAD is an ancestor of origin's default branch
  | "REACHABLE_BRANCH" // HEAD is contained in a remote *mainline* branch
  | "PUSHED_ONLY" // HEAD is contained only in feature branches — durable, not landed
  | "EMPTY" // no diff vs merge-base — nothing unique in the lane
  | "CONTENT_LANDED" // squash-merge signature: every touched file byte-identical in origin default
  | "STRANDED" // lane content differs from origin
  | "NO_REMOTE_REF" // no origin default branch to compare against
  | "NO_MERGE_BASE" // unrelated histories
  | "PROBE_FAILED"; // a git probe errored — never classify optimistically

export interface Verdict {
  kind: VerdictKind;
  /** ref that proves reachability (origin/main, origin/feat-x, …) */
  ref: string | null;
  /** STRANDED detail: how many of the touched files differ */
  differing?: number;
  total?: number;
}

/** Tiers wt reap may remove without human review (locked policy, 2026-07-15). */
export const AUTO_REMOVABLE: ReadonlySet<VerdictKind> = new Set([
  "REACHABLE",
  "REACHABLE_BRANCH",
  "EMPTY",
  "CONTENT_LANDED",
]);

/**
 * PUSHED_ONLY says the commits survive on a remote, not that the work is done —
 * an unmerged open-PR lane looks exactly like this. Removing one needs
 * independent evidence that it landed, which only the PR state carries.
 */
export const REMOVABLE_WITH_MERGED_PR: ReadonlySet<VerdictKind> = new Set(["PUSHED_ONLY"]);

/**
 * The whole removal policy in one place: git reachability and PR state are
 * separate evidence axes. Open and unknown PR states veto both: a lane whose
 * PR is open is live work, and a failed or incomplete lookup is not consent to
 * remove anything.
 */
export function isRemovable(kind: VerdictKind, prState: PrState): boolean {
  if (prState === "open" || prState === "unknown") return false;
  if (AUTO_REMOVABLE.has(kind)) return true;
  return REMOVABLE_WITH_MERGED_PR.has(kind) && prState === "merged";
}

/**
 * Long-lived branches on origin. origin is already the authoritative remote
 * used by originDefault; conventional branches on forks and backup remotes are
 * not landing evidence.
 */
async function originMainlineRefs(wtPath: string): Promise<Set<string>> {
  const g = (...args: string[]) => runAsync(["git", "-C", wtPath, ...args]);
  const refs = new Set<string>();
  const head = await g("symbolic-ref", "-q", "refs/remotes/origin/HEAD");
  if (head.ok && head.stdout.trim()) {
    refs.add(head.stdout.trim().replace(/^refs\/remotes\//, ""));
  }
  await Promise.all(
    ["main", "master", "dev"].map(async (name) => {
      const r = await g("rev-parse", "--verify", "-q", `refs/remotes/origin/${name}`);
      if (r.ok) refs.add(`origin/${name}`);
    }),
  );
  return refs;
}

export async function classifyWorktree(wtPath: string): Promise<Verdict> {
  const g = (...args: string[]) => runAsync(["git", "-C", wtPath, ...args]);

  const defaultBranch = originDefault(wtPath);
  if (!defaultBranch) return { kind: "NO_REMOTE_REF", ref: null };
  const defRef = `origin/${defaultBranch}`;

  const headRes = await g("rev-parse", "HEAD");
  const head = headRes.stdout.trim();
  if (!headRes.ok || !head) return { kind: "PROBE_FAILED", ref: defRef };

  if ((await g("merge-base", "--is-ancestor", head, defRef)).ok) {
    return { kind: "REACHABLE", ref: defRef };
  }

  const containing = await g("branch", "-r", "--contains", head);
  const remoteBranches = containing.ok
    ? containing.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !l.includes("->"))
    : [];
  if (remoteBranches.length > 0) {
    const mainlines = await originMainlineRefs(wtPath);
    const landed = remoteBranches.find((b) => mainlines.has(b));
    if (landed) return { kind: "REACHABLE_BRANCH", ref: landed };
    return { kind: "PUSHED_ONLY", ref: remoteBranches[0]! };
  }

  const mbRes = await g("merge-base", head, defRef);
  if (!mbRes.ok) return { kind: "NO_MERGE_BASE", ref: defRef };
  const mergeBase = mbRes.stdout.trim();

  // A failed diff must never read as EMPTY/CONTENT_LANDED — both auto-remove.
  const filesRes = await g("diff", "--name-only", mergeBase, head);
  if (!filesRes.ok) return { kind: "PROBE_FAILED", ref: defRef };
  const files = filesRes.stdout.split("\n").filter(Boolean);
  if (files.length === 0) return { kind: "EMPTY", ref: defRef };

  const differsRes = await g("diff", "--name-only", head, defRef, "--", ...files);
  if (!differsRes.ok) return { kind: "PROBE_FAILED", ref: defRef };
  const differing = differsRes.stdout.split("\n").filter(Boolean).length;
  if (differing === 0) return { kind: "CONTENT_LANDED", ref: defRef, total: files.length };
  return { kind: "STRANDED", ref: defRef, differing, total: files.length };
}

export function verdictLabel(v: Verdict, prState?: string, prNumber?: number | null): string {
  let label: string = v.kind;
  if (v.kind === "STRANDED") label = `STRANDED(${v.differing}/${v.total})`;
  if (prNumber && (prState === "merged" || prState === "open" || prState === "closed")) {
    label += ` (PR #${prNumber} ${prState})`;
  }
  return label;
}
