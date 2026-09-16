import { existsSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { humanSize } from "./ls.ts";
import { listWorktrees } from "./git.ts";
import { measureDiskUsage, type WorktreeDiskReport } from "./disk.ts";

export interface DuOptions {
  cwd: string;
  target?: string;
  json: boolean;
  fresh: boolean;
}

function canonical(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

/** Resolve a branch, directory name, or path to the owning worktree path. */
function resolveTargetPath(cwd: string, target: string): string {
  const candidate = resolve(cwd, target);
  const canonicalCandidate = existsSync(candidate) ? canonical(candidate) : null;
  const record = listWorktrees(cwd).find((item) =>
    item.branch === target
    || basename(item.path) === target
    || (canonicalCandidate !== null && canonical(item.path) === canonicalCandidate),
  );
  if (!record) throw new Error(`worktree not found: ${target}`);
  return record.path;
}

export function renderDiskTable(records: WorktreeDiskReport[]): string {
  const header = "WORKTREE\tCHECKOUT\tPRIVATE GIT\tOWNED\tSHARED";
  return [header, ...records.map((record) => {
    const usage = record.usage;
    return [
      record.primary ? `${basename(record.path)} (primary)` : basename(record.path),
      humanSize(usage?.checkoutKb ?? null),
      humanSize(usage?.privateGitKb ?? null),
      humanSize(usage?.ownedKb ?? null),
      humanSize(usage?.sharedKb ?? null),
    ].join("\t");
  })].join("\n");
}

export async function cmdDu(options: DuOptions): Promise<string> {
  const only = options.target ? [resolveTargetPath(options.cwd, options.target)] : undefined;
  const records = await measureDiskUsage(
    options.cwd,
    options.fresh ? "fresh" : "cached",
    only ? { only } : {},
  );
  return options.json ? JSON.stringify(records, null, 2) : renderDiskTable(records);
}
