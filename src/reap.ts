// wt reap — report (default) and remove (--apply) safely-reapable worktrees.
//
// Policy (locked 2026-07-15): only REACHABLE / REACHABLE_BRANCH / EMPTY /
// CONTENT_LANDED lanes may auto-remove, and the safety pipeline can still
// demote any of them to SKIP. STRANDED and edge verdicts never auto-remove.
// Reap never deletes branches.

import { basename, dirname, join } from "node:path";
import { discoverPrimaries, humanSize } from "./ls.ts";
import { resolvePrimaryRepo } from "./git.ts";
import { runSafetyPipeline, type SafetyResult } from "./safety.ts";
import { scanWorktrees, type ScanOptions, type WorktreeStatus } from "./scan.ts";
import { bold, dim, gray, green, pool, red, runAsync, yellow } from "./term.ts";
import { err, ExitError } from "./ui.ts";
import { AUTO_REMOVABLE, classifyWorktree, verdictLabel, type Verdict } from "./verdict.ts";

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
      if (!AUTO_REMOVABLE.has(verdict.kind)) {
        return { ...base, verdict, verdictText, disposition: "keep", reasons: [verdictText] };
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

export async function applyReap(entries: ReapEntry[]): Promise<ApplyResult> {
  const removed: ReapEntry[] = [];
  const skipped: ApplyResult["skipped"] = [];
  for (const entry of entries) {
    if (entry.disposition !== "remove") continue;
    const { record, repoRoot } = entry;
    // TOCTOU guard: the lane must still be at the sha the plan classified
    const headNow = await runAsync(["git", "-C", record.path, "rev-parse", "HEAD"]);
    if (!headNow.ok || headNow.stdout.trim() !== record.head) {
      skipped.push({ entry, reason: "HEAD moved since scan" });
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
  const byRepo = new Map<string, ReapEntry[]>();
  for (const e of entries) {
    const list = byRepo.get(e.repoRoot) ?? [];
    list.push(e);
    byRepo.set(e.repoRoot, list);
  }
  const lines: string[] = [];
  const label: Record<Disposition, string> = {
    remove: apply ? "REMOVE" : "WOULD REMOVE",
    skip: "SKIP",
    keep: "KEEP",
  };
  const color: Record<Disposition, (s: string | number) => string> = {
    remove: green,
    skip: yellow,
    keep: gray,
  };
  for (const [repoRoot, repoEntries] of byRepo) {
    lines.push(`${bold(basename(repoRoot))} ${gray(dirname(repoRoot))}`);
    for (const disposition of ["remove", "skip", "keep"] as const) {
      for (const e of repoEntries.filter((x) => x.disposition === disposition)) {
        const size = humanSize(e.record.sizeKb);
        lines.push(
          `  ${color[disposition](label[disposition].padEnd(apply ? 6 : 12))}  ${e.record.slug.padEnd(30)} ${size.padStart(6)}  ${dim(e.reasons.join("; "))}`,
        );
        if (e.safety && e.safety.salvaged.length > 0) {
          lines.push(`  ${" ".repeat(apply ? 6 : 12)}  ${dim(`salvage: ${e.safety.salvaged.join(", ")}`)}`);
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
