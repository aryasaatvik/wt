import { Worker } from "node:worker_threads";
import type { ApfsUsage } from "./apfs.ts";
import type { ScanRequest } from "./apfs-worker.ts";

// Share the limit across repos: wt ls --all can measure multiple repos at once.
const MAX_SCANS = 4;
let active = 0;
const waiting: (() => void)[] = [];

export async function measureApfsUsage(
  root: string,
  excludedPaths: string[],
): Promise<ApfsUsage | null> {
  if (process.platform !== "darwin") return null;
  if (active < MAX_SCANS) active++;
  else await new Promise<void>((resolve) => waiting.push(resolve));

  try {
    const request: ScanRequest = { root, excludedPaths };
    return await new Promise<ApfsUsage | null>((resolve, reject) => {
      const worker = new Worker(new URL("./apfs-worker.ts", import.meta.url), {
        workerData: request,
      });
      let usage: ApfsUsage | null | undefined;
      worker.once("message", (value: ApfsUsage | null) => {
        usage = value;
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code === 0 && usage !== undefined) resolve(usage);
        else reject(new Error(`APFS scan worker exited with code ${code} while measuring ${root}`));
      });
    });
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
