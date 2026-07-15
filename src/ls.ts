// wt ls — status table, --json, and --all fleet discovery.

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { scanWorktrees, type ScanOptions, type WorktreeStatus } from "./scan.ts";
import { bold, cyan, dim, gray, green, pad, pool, red, yellow } from "./term.ts";
import { err, ExitError } from "./ui.ts";

export function humanSize(kb: number | null): string {
  if (kb === null) return "-";
  if (kb < 1024) return `${kb}K`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)}M`;
  const gb = mb / 1024;
  return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)}G`;
}

export function humanAge(iso: string | null, nowMs: number = Date.now()): string {
  if (!iso) return "-";
  const sec = Math.max(0, (nowMs - Date.parse(iso)) / 1000);
  if (sec < 3600) return `${Math.max(1, Math.floor(sec / 60))}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}d`;
  if (sec < 86400 * 365) return `${Math.floor(sec / (86400 * 30))}mo`;
  return `${Math.floor(sec / (86400 * 365))}y`;
}

function branchLabel(r: WorktreeStatus): string {
  if (r.branch) return r.branch;
  return r.detached ? `detached@${r.head.slice(0, 7)}` : "?";
}

function dirtyLabel(r: WorktreeStatus): string {
  return r.dirty ? `${r.dirtyCount}*` : "-";
}

function aheadBehindLabel(r: WorktreeStatus): string {
  if (r.ahead === null || r.behind === null) return "-";
  return `+${r.ahead}/-${r.behind}`;
}

function prLabel(r: WorktreeStatus): string {
  switch (r.prState) {
    case "open":
      return `open#${r.prNumber}`;
    case "merged":
      return `merged#${r.prNumber}`;
    case "closed":
      return `closed#${r.prNumber}`;
    case "none":
      return "-";
    case "unknown":
      return "?";
  }
}

const HEADERS = ["WORKTREE", "BRANCH", "DIRTY", "±", "PR", "SIZE", "AGE"] as const;

/** Plain-text table; colors come from term.ts and disable themselves when piped. */
export function renderTable(records: WorktreeStatus[], nowMs: number = Date.now()): string {
  const rows = records.map((r) => [
    r.primary ? `${r.slug} (primary)` : r.slug,
    branchLabel(r),
    dirtyLabel(r),
    aheadBehindLabel(r),
    prLabel(r),
    humanSize(r.sizeKb),
    humanAge(r.lastCommitAt, nowMs),
  ]);
  const widths = HEADERS.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const lines = [HEADERS.map((h, i) => bold(pad(h, widths[i]!))).join("  ")];
  for (let ri = 0; ri < rows.length; ri++) {
    const r = records[ri]!;
    const row = rows[ri]!;
    const cells = row.map((cell, i) => pad(cell, widths[i]!));
    // color accents: dirty red, detached yellow, open PR cyan, merged green
    if (r.dirty) cells[2] = red(cells[2]!);
    if (r.detached) cells[1] = yellow(cells[1]!);
    if (r.prState === "open") cells[4] = cyan(cells[4]!);
    if (r.prState === "merged") cells[4] = green(cells[4]!);
    if (r.primary) cells[0] = dim(cells[0]!);
    lines.push(cells.join("  "));
  }
  return lines.join("\n");
}

/**
 * Fleet discovery: every `<repo>-worktrees` dir under root (depth ≤ 3) names
 * a primary repo sibling. Scanning the primary then reports ALL its
 * registered worktrees, including strays outside the convention.
 */
export function discoverPrimaries(root: string, depth = 3): string[] {
  const primaries = new Set<string>();
  const walk = (dir: string, remaining: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(dir, name);
      if (name.endsWith("-worktrees")) {
        const primary = join(dir, name.slice(0, -"-worktrees".length));
        if (existsSync(join(primary, ".git"))) primaries.add(primary);
        continue;
      }
      if (remaining > 1) {
        try {
          // lstat: never follow symlinks out of the dev root during the sweep
          if (lstatSync(full).isDirectory()) walk(full, remaining - 1);
        } catch {
          // unreadable entry — skip
        }
      }
    }
  };
  walk(root, depth);
  return [...primaries].sort();
}

export interface LsOptions {
  json: boolean;
  all: boolean;
  cwd: string;
  devRoot?: string;
  scan?: ScanOptions;
}

type FleetRecord = WorktreeStatus & { repo: string; repoPath: string };

export async function cmdLs(opts: LsOptions): Promise<string> {
  if (!opts.all) {
    let records: WorktreeStatus[];
    try {
      records = await scanWorktrees(opts.cwd, opts.scan);
    } catch {
      err("not inside a git repository (use wt ls --all to scan ~/Developer)");
      throw new ExitError(1);
    }
    return opts.json ? JSON.stringify(records, null, 2) : renderTable(records);
  }

  const devRoot = opts.devRoot ?? join(process.env.HOME ?? "~", "Developer");
  const primaries = discoverPrimaries(devRoot);
  // repos scan concurrently; each scan already pools its own probes
  const perRepo = await pool(primaries, 4, async (primary) => {
    try {
      return { primary, records: await scanWorktrees(primary, opts.scan) };
    } catch {
      return null; // unreadable/broken repo — skip rather than abort the sweep
    }
  });
  const fleet: FleetRecord[] = [];
  const sections: string[] = [];
  for (const entry of perRepo) {
    if (!entry) continue;
    const repo = basename(entry.primary);
    fleet.push(...entry.records.map((r) => ({ ...r, repo, repoPath: entry.primary })));
    const lanes = entry.records.filter((r) => !r.primary);
    if (lanes.length > 0) {
      sections.push(`${bold(repo)} ${gray(dirname(entry.primary))}\n${renderTable(lanes)}`);
    }
  }
  if (opts.json) return JSON.stringify(fleet, null, 2);
  return sections.length > 0 ? sections.join("\n\n") : "no worktrees found";
}
