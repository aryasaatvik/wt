import { parentPort, workerData } from "node:worker_threads";
import { privateBytes } from "./apfs.ts";

export interface ScanRequest {
  root: string;
  excludedPaths: string[];
}

if (parentPort) {
  const request: ScanRequest = workerData;
  parentPort.postMessage(privateBytes(request.root, new Set(request.excludedPaths)));
}
