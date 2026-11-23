import { Worker } from "node:worker_threads";
import type { ScanRequest } from "./apfs-worker.ts";

// Share the limit across repos: wt ls --all can measure multiple repos at once.
const MAX_SCANS = 4;
let active = 0;
const waiting: (() => void)[] = [];

export async function measurePrivateBytes(
  root: string,
  excludedPaths: string[],
): Promise<number | null> {
  if (process.platform !== "darwin") return null;
  if (active < MAX_SCANS) active++;
  else await new Promise<void>((resolve) => waiting.push(resolve));

  try {
    const request: ScanRequest = { root, excludedPaths };
    return await new Promise<number | null>((resolve, reject) => {
      const worker = new Worker(new URL("./apfs-worker.ts", import.meta.url), {
        workerData: request,
      });
      let bytes: number | null | undefined;
      worker.once("message", (value: number | null) => {
        bytes = value;
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code === 0 && bytes !== undefined) resolve(bytes);
        else reject(new Error(`APFS scan worker exited with code ${code} while measuring ${root}`));
      });
    });
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
