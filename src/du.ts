import { existsSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { humanSize } from "./ls.ts";
import { measureDiskUsage, type WorktreeDiskReport } from "./disk.ts";

export interface DuOptions {
  cwd: string;
  target?: string;
  json: boolean;
  fresh: boolean;
}

function selectTarget(records: WorktreeDiskReport[], cwd: string, target: string): WorktreeDiskReport {
  const candidate = resolve(cwd, target);
  const canonical = existsSync(candidate) ? realpathSync.native(candidate) : null;
  const record = records.find((item) =>
    item.branch === target || basename(item.path) === target || (canonical !== null && item.path === canonical));
  if (!record) throw new Error(`worktree not found: ${target}`);
  return record;
}

export function renderDiskTable(records: WorktreeDiskReport[]): string {
  const header = "WORKTREE\tCHECKOUT\tPRIVATE GIT\tOWNED\tSHARED";
  return [header, ...records.map((record) => [
    record.primary ? `${basename(record.path)} (primary)` : basename(record.path),
    humanSize(record.usage.checkoutKb),
    humanSize(record.usage.privateGitKb),
    humanSize(record.usage.ownedKb),
    humanSize(record.usage.sharedKb ?? null),
  ].join("\t"))].join("\n");
}

export async function cmdDu(options: DuOptions): Promise<string> {
  let records = await measureDiskUsage(options.cwd, options.fresh ? "fresh" : "cached");
  if (options.target) records = [selectTarget(records, options.cwd, options.target)];
  return options.json ? JSON.stringify(records, null, 2) : renderDiskTable(records);
}
