// wt reap — report (default) and remove (--apply) safely-reapable worktrees.
//
// Policy (see isRemovable in verdict.ts): REACHABLE / REACHABLE_BRANCH /
// EMPTY / CONTENT_LANDED auto-remove; PUSHED_ONLY needs a merged PR; an open
// or unknown PR vetoes every verdict. The safety pipeline can still demote any
// of them to SKIP. STRANDED and edge verdicts never auto-remove. Reap never
// deletes branches.

import { basename, dirname, join } from "node:path";
import { discoverPrimaries, humanSize } from "./ls.ts";
import { resolvePrimaryRepo } from "./git.ts";
import { runSafetyPipeline, type SafetyResult } from "./safety.ts";
import { prForCommit, remoteRepos, scanWorktrees, type ScanOptions, type WorktreeStatus } from "./scan.ts";
import { bold, dim, gray, green, pool, red, runAsync, yellow } from "./term.ts";
import { err, ExitError } from "./ui.ts";
import { classifyWorktree, isRemovable, verdictLabel, type Verdict } from "./verdict.ts";

export type Disposition = "remove" | "skip" | "keep";

export interface ReapEntry {
  record: WorktreeStatus;
  repoRoot: string;
  verdict: Verdict | null;
  verdictText: string;
  disposition: Disposition;
  reasons: string[];
  safety: SafetyResult | null;
}

export interface ReapOptions {
  all: boolean;
  olderThanDays?: number;
  cwd: string;
  devRoot?: string;
  scan?: ScanOptions;
}

async function planRepo(repoRoot: string, opts: ReapOptions): Promise<ReapEntry[]> {
  const records = await scanWorktrees(repoRoot, opts.scan);
  const cutoffMs = opts.olderThanDays ? Date.now() - opts.olderThanDays * 86400_000 : null;

  return pool(
    records.filter((r) => !r.primary),
    8,
    async (record): Promise<ReapEntry> => {
      const base = { record, repoRoot, safety: null as SafetyResult | null };
      if (record.locked) {
        return { ...base, verdict: null, verdictText: "-", disposition: "keep", reasons: ["locked"] };
      }
      if (record.prunable) {
        return {
          ...base,
          verdict: null,
          verdictText: "-",
          disposition: "keep",
          reasons: ["prunable (directory missing — use git worktree prune)"],
        };
      }
      const verdict = await classifyWorktree(record.path);
      const verdictText = verdictLabel(verdict, record.prState, record.prNumber);
      if (!isRemovable(verdict.kind, record.prState)) {
        const reason =
          record.prState === "open"
            ? `open PR #${record.prNumber} — active lane (${verdict.kind})`
            : record.prState === "unknown"
              ? `PR state unknown — keeping (${verdict.kind})`
              : verdictText;
        return { ...base, verdict, verdictText, disposition: "keep", reasons: [reason] };
      }
      if (cutoffMs !== null) {
        const lastCommitMs = record.lastCommitAt ? Date.parse(record.lastCommitAt) : Number.NaN;
        if (Number.isNaN(lastCommitMs)) {
          // The user asked for old lanes only; unknowable age keeps the lane.
          return {
            ...base,
            verdict,
            verdictText,
            disposition: "keep",
            reasons: ["age unknown — keeping (--older-than set)"],
          };
        }
        if (lastCommitMs > cutoffMs) {
          return {
            ...base,
            verdict,
            verdictText,
            disposition: "keep",
            reasons: [`last commit newer than ${opts.olderThanDays}d`],
          };
        }
      }
      // dry-run safety evaluation — accurate SKIP prediction, no salvage copies yet
      const safety = await runSafetyPipeline(record.path, repoRoot, { dryRun: true });
      if (!safety.ok) {
        return {
          ...base,
          verdict,
          verdictText,
          disposition: "skip",
          reasons: safety.flags.map((f) => `[${f.kind}] ${f.detail}`),
          safety,
        };
      }
      return { ...base, verdict, verdictText, disposition: "remove", reasons: [verdictText], safety };
    },
  );
}

export async function planReap(opts: ReapOptions): Promise<ReapEntry[]> {
  if (!opts.all) {
    let repoRoot: string;
    try {
      repoRoot = resolvePrimaryRepo(opts.cwd);
    } catch {
      err("not inside a git repository (use wt reap --all to sweep ~/Developer)");
      throw new ExitError(1);
    }
    return planRepo(repoRoot, opts);
  }
  const devRoot = opts.devRoot ?? join(process.env.HOME ?? "~", "Developer");
  const primaries = discoverPrimaries(devRoot);
  const perRepo = await pool(primaries, 4, async (primary) => {
    try {
      return await planRepo(primary, opts);
    } catch {
      return [];
    }
  });
  return perRepo.flat();
}

export interface ApplyResult {
  removed: ReapEntry[];
  skipped: Array<{ entry: ReapEntry; reason: string }>;
}

export interface ApplyOptions {
  env?: Record<string, string | undefined>;
}

export async function applyReap(entries: ReapEntry[], opts: ApplyOptions = {}): Promise<ApplyResult> {
  const removed: ReapEntry[] = [];
  const skipped: ApplyResult["skipped"] = [];
  const reposByRoot = new Map<string, Awaited<ReturnType<typeof remoteRepos>>>();
  for (const entry of entries) {
    if (entry.disposition !== "remove") continue;
    const { record, repoRoot } = entry;
    // TOCTOU guard: the lane must still be at the sha the plan classified
    const headNow = await runAsync(["git", "-C", record.path, "rev-parse", "HEAD"]);
    if (!headNow.ok || headNow.stdout.trim() !== record.head) {
      skipped.push({ entry, reason: "HEAD moved since scan" });
      continue;
    }
    // PR state is external and can change without moving HEAD. Recheck by
    // commit immediately before removal; a failed lookup becomes unknown and
    // therefore cannot authorize the stale plan.
    let repos = reposByRoot.get(repoRoot);
    if (!repos) {
      repos = await remoteRepos(repoRoot);
      reposByRoot.set(repoRoot, repos);
    }
    const latestPr =
      repos.length > 0
        ? await prForCommit(repos, record.head, opts.env ?? process.env)
        : { prState: "unknown" as const, prNumber: null };
    const latestPrState = latestPr?.prState ?? "unknown";
    if (!entry.verdict || !isRemovable(entry.verdict.kind, latestPrState)) {
      const reason =
        latestPrState === "open"
          ? `PR #${latestPr?.prNumber} opened since planning`
          : `PR state became ${latestPrState} since planning`;
      skipped.push({ entry, reason });
      continue;
    }
    // Re-evaluate read-only first: if something changed since the plan
    // (a note edited, a file touched), skip WITHOUT having copied anything.
    const recheck = await runSafetyPipeline(record.path, repoRoot, { dryRun: true });
    if (!recheck.ok) {
      skipped.push({ entry, reason: recheck.flags.map((f) => `[${f.kind}] ${f.detail}`).join("; ") });
      continue;
    }
    const safety = await runSafetyPipeline(record.path, repoRoot);
    if (!safety.ok) {
      skipped.push({ entry, reason: safety.flags.map((f) => `[${f.kind}] ${f.detail}`).join("; ") });
      continue;
    }
    const rm = await runAsync(["git", "-C", repoRoot, "worktree", "remove", record.path]);
    if (!rm.ok) {
      skipped.push({ entry, reason: rm.stderr.trim() });
      continue;
    }
    entry.safety = safety;
    removed.push(entry);
  }
  return { removed, skipped };
}

export function renderReapReport(entries: ReapEntry[], apply: boolean, applied?: ApplyResult): string {
  // After --apply, rows reflect what actually happened: a planned removal
  // that apply skipped (TOCTOU, late safety flag) must not read as REMOVE.
  const removedPaths = new Set(applied?.removed.map((e) => e.record.path));
  const applySkipReasons = new Map(applied?.skipped.map((s) => [s.entry.record.path, s.reason]));
  const effective = entries.map((e) => {
    if (applied && e.disposition === "remove" && !removedPaths.has(e.record.path)) {
      return {
        ...e,
        disposition: "skip" as Disposition,
        reasons: [applySkipReasons.get(e.record.path) ?? "skipped at apply time"],
      };
    }
    return e;
  });

  const byRepo = new Map<string, ReapEntry[]>();
  for (const e of effective) {
    const list = byRepo.get(e.repoRoot) ?? [];
    list.push(e);
    byRepo.set(e.repoRoot, list);
  }
  const lines: string[] = [];
  const label: Record<Disposition, string> = {
    remove: apply ? "REMOVED" : "WOULD REMOVE",
    skip: "SKIP",
    keep: "KEEP",
  };
  const color: Record<Disposition, (s: string | number) => string> = {
    remove: green,
    skip: yellow,
    keep: gray,
  };
  const labelWidth = apply ? 7 : 12;
  for (const [repoRoot, repoEntries] of byRepo) {
    lines.push(`${bold(basename(repoRoot))} ${gray(dirname(repoRoot))}`);
    for (const disposition of ["remove", "skip", "keep"] as const) {
      for (const e of repoEntries.filter((x) => x.disposition === disposition)) {
        const size = humanSize(e.record.sizeKb);
        lines.push(
          `  ${color[disposition](label[disposition].padEnd(labelWidth))}  ${e.record.slug.padEnd(30)} ${size.padStart(6)}  ${dim(e.reasons.join("; "))}`,
        );
        // salvage notices only on removal rows: a SKIP/KEEP lane was never
        // touched, and implying its notes were archived invites data loss
        if (disposition === "remove" && e.safety && e.safety.salvaged.length > 0) {
          lines.push(`  ${" ".repeat(labelWidth)}  ${dim(`salvage: ${e.safety.salvaged.join(", ")}`)}`);
        }
      }
    }
    lines.push("");
  }
  const removable = entries.filter((e) => e.disposition === "remove");
  const totalKb = removable.reduce((s, e) => s + (e.record.sizeKb ?? 0), 0);
  const skips = entries.filter((e) => e.disposition === "skip").length;
  if (applied) {
    const freedKb = applied.removed.reduce((s, e) => s + (e.record.sizeKb ?? 0), 0);
    lines.push(
      `${bold(String(applied.removed.length))} removed (${humanSize(freedKb)} freed), ${applied.skipped.length} skipped at apply time, ${skips} skipped at plan time`,
    );
    for (const s of applied.skipped) {
      lines.push(`  ${red("skipped")} ${s.entry.record.slug}: ${s.reason}`);
    }
  } else {
    lines.push(
      `${bold(String(removable.length))} reapable (${humanSize(totalKb)}), ${skips} skipped, ${entries.filter((e) => e.disposition === "keep").length} kept — run with --apply to remove`,
    );
  }
  return lines.join("\n");
}
