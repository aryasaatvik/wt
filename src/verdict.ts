// Reachability verdicts for worktrees — the classification proven on 90
// detached lanes during the 2026-07-15 cleanup (75 safe, 15 stranded).
// Read-only: no fetch, no mutation.

import { originDefault } from "./git.ts";
import { runAsync } from "./term.ts";

export type VerdictKind =
  | "REACHABLE" // HEAD is an ancestor of origin's default branch
  | "REACHABLE_BRANCH" // HEAD is contained in some remote branch
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

export async function classifyWorktree(wtPath: string): Promise<Verdict> {
  const g = (...args: string[]) => runAsync(["git", "-C", wtPath, ...args]);

  const defaultBranch = originDefault(wtPath);
  if (!defaultBranch) return { kind: "NO_REMOTE_REF", ref: null };
  const defRef = `origin/${defaultBranch}`;

  const head = (await g("rev-parse", "HEAD")).stdout.trim();

  if ((await g("merge-base", "--is-ancestor", head, defRef)).ok) {
    return { kind: "REACHABLE", ref: defRef };
  }

  const containing = await g("branch", "-r", "--contains", head);
  const branch = containing.ok
    ? containing.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !l.includes("->"))[0]
    : undefined;
  if (branch) return { kind: "REACHABLE_BRANCH", ref: branch };

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
  if (prState === "merged" && prNumber) label += ` (PR #${prNumber} merged)`;
  return label;
}
