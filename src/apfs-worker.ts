import { parentPort, workerData } from "node:worker_threads";
import { scanApfsUsage } from "./apfs.ts";

export interface ScanRequest {
  root: string;
  excludedPaths: string[];
}

if (parentPort) {
  const request: ScanRequest = workerData;
  parentPort.postMessage(scanApfsUsage(request.root, new Set(request.excludedPaths)));
}
