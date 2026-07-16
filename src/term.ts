// Terminal primitives, duplicated from dotfiles shared/bin/lib/term.ts by
// design: wt is a standalone repo and these are small and stable, so a copy
// beats a cross-repo dependency. Keep only what wt's commands actually use.

import { spawnSync } from "bun";

const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const c = (code: string) => (s: string | number) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const bold = c("1");
export const dim = c("2");
export const gray = c("90");
export const red = c("31");
export const green = c("32");
export const yellow = c("33");
export const cyan = c("36");

// Pad plain text only — never a string that already carries ANSI codes, or the
// truncation slices through an escape sequence.
export function pad(s: string, n: number): string {
  if (s.length > n) return s.slice(0, n - 1) + "…";
  return s + " ".repeat(n - s.length);
}

/** Run a command synchronously; stdout on success, "" on any failure. */
export function run(cmd: string[]): string {
  const r = spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
  return r.success ? r.stdout.toString() : "";
}

/** Run a command asynchronously; never throws, reports the exit code. */
export async function runAsync(
  cmd: string[],
  opts?: { cwd?: string },
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  try {
    const p = Bun.spawn(cmd, { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { ok: code === 0, stdout, stderr, code };
  } catch (e) {
    // Missing binary (ENOENT) and other OS-level spawn failures land here,
    // keeping the never-throws contract real.
    return { ok: false, stdout: "", stderr: String(e), code: -1 };
  }
}

/** Map over items with at most `limit` calls in flight; preserves order. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let cursorHooked = false;

/**
 * Inline braille spinner on a single stderr line; no-op when stderr is piped.
 * Progress lives on stderr so redirecting stdout still shows it and pipes
 * stay clean. Call stop() before printing anything else.
 */
export function spinner(message: string): { update(m: string): void; stop(): void } {
  if (!process.stderr.isTTY) return { update() {}, stop() {} };
  let text = message;
  let frame = 0;
  process.stderr.write("\x1b[?25l");
  if (!cursorHooked) {
    cursorHooked = true;
    process.on("exit", () => process.stderr.write("\x1b[?25h"));
  }
  const timer = setInterval(() => {
    process.stderr.write(`\r\x1b[K  ${cyan(SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]!)} ${text}`);
  }, 80);
  return {
    update(m: string) {
      text = m;
    },
    stop() {
      clearInterval(timer);
      process.stderr.write("\r\x1b[K\x1b[?25h");
    },
  };
}
