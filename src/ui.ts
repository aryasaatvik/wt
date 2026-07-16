// Status-line output matching the v1 bash look: two-space indent, ✓/→/✗.

import { cyan, green, red } from "./term.ts";

export const log = (m: string) => console.log(`  ${green("✓")} ${m}`);
export const info = (m: string) => console.log(`  ${cyan("→")} ${m}`);
export const err = (m: string) => console.error(`  ${red("✗")} ${m}`);

/** Print indented detail lines (e.g. a captured stderr) to stderr. */
export function detail(text: string): void {
  const trimmed = text.trimEnd();
  if (!trimmed) return;
  for (const line of trimmed.split("\n")) console.error(`    ${line}`);
}

/**
 * Commands report failures by printing and throwing this; only the entry
 * point calls process.exit, so tests can drive commands as plain functions.
 */
export class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}
