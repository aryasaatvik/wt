import { expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdNew } from "../src/create.ts";
import { cmdRm } from "../src/rm.ts";
import { runSafetyPipeline } from "../src/safety.ts";
import { ensureSharedScratchpad } from "../src/scratchpad.ts";
import { planSync, applySyncPlan } from "../src/sync.ts";
import { measureDiskUsage } from "../src/disk.ts";
import { makeRepo } from "./harness.ts";

test("new worktrees share writes, remain clean and remove without archiving canonical content", async () => {
  const repo = makeRepo();
  try {
    repo.write(".gitignore", ".scratchpad/\n");
    repo.commit("ignore local notes");
    repo.write(".scratchpad/note.md", "primary\n");
    const opts = { cwd: repo.dir, verbose: false, install: false, extraFlags: [] };
    const first = await cmdNew("first", "main", opts);
    const second = await cmdNew("second", "main", opts);
    expect(lstatSync(join(first, ".scratchpad")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(first, ".scratchpad"))).toBe(join(repo.dir, ".scratchpad"));
    writeFileSync(join(first, ".scratchpad/note.md"), "shared update\n");
    expect(readFileSync(join(second, ".scratchpad/note.md"), "utf8")).toBe("shared update\n");
    // Even a cyclic link in shared history is irrelevant to removal.
    symlinkSync(".", join(repo.dir, ".scratchpad/cycle"));
    expect((await runSafetyPipeline(first, repo.dir)).ok).toBe(true);
    expect(repo.gitIn(first, "status", "--porcelain")).toBe("");
    await cmdRm("first", { cwd: repo.dir, deleteBranch: false });
    expect(existsSync(first)).toBe(false);
    expect(readFileSync(join(second, ".scratchpad/note.md"), "utf8")).toBe("shared update\n");
    expect(existsSync(join(repo.dir, ".scratchpad/archive"))).toBe(false);
    expect(repo.git("branch", "--list", "first")).toContain("first");
  } finally { repo.rm(); }
});

test("sync excludes Scratchpad even when explicitly selected and forced", async () => {
  const repo = makeRepo();
  try {
    repo.write(".gitignore", ".scratchpad/\n");
    repo.write(".worktreeinclude", ".scratchpad/\n");
    repo.commit("manifest");
    repo.write(".scratchpad/note.md", "canonical");
    const lane = repo.addWorktree("lane");
    await ensureSharedScratchpad(repo.dir, lane);
    const plan = await planSync(repo.dir, lane, { force: true });
    expect(plan.actions).toEqual([]);
    expect(await applySyncPlan(plan)).toEqual([]);
    expect(lstatSync(join(lane, ".scratchpad")).isSymbolicLink()).toBe(true);
  } finally { repo.rm(); }
});

test("broken and foreign shared links veto removal without following them", async () => {
  const repo = makeRepo();
  try {
    const lane = repo.addWorktree("lane");
    await ensureSharedScratchpad(repo.dir, lane);
    unlinkSync(join(lane, ".scratchpad"));
    symlinkSync("missing", join(lane, ".scratchpad"));
    expect((await runSafetyPipeline(lane, repo.dir)).ok).toBe(false);
    unlinkSync(join(lane, ".scratchpad"));
    symlinkSync(repo.root, join(lane, ".scratchpad"));
    await expect(cmdRm("lane", { cwd: repo.dir, deleteBranch: false })).rejects.toThrow();
    expect(existsSync(lane)).toBe(true);
  } finally { repo.rm(); }
});

test("sharing never replaces tracked or existing local Scratchpad content", async () => {
  const repo = makeRepo();
  try {
    repo.write(".scratchpad/note.md", "tracked");
    repo.commit("tracked notes");
    const lane = repo.addWorktree("lane");
    await expect(ensureSharedScratchpad(repo.dir, lane)).rejects.toThrow("tracked");
    expect(readFileSync(join(lane, ".scratchpad/note.md"), "utf8")).toBe("tracked");
  } finally { repo.rm(); }
});

test("shared Scratchpad bytes are charged to primary only", async () => {
  const repo = makeRepo();
  try {
    const lane = repo.addWorktree("lane");
    await ensureSharedScratchpad(repo.dir, lane);
    const before = await measureDiskUsage(repo.dir, "fresh");
    repo.write(".scratchpad/large.bin", "x".repeat(2 * 1024 * 1024));
    const after = await measureDiskUsage(repo.dir, "fresh");
    expect(after.find((r) => r.path === lane)!.usage!.checkoutKb).toBe(before.find((r) => r.path === lane)!.usage!.checkoutKb);
    expect(after.find((r) => r.primary)!.usage!.checkoutKb).toBeGreaterThan(before.find((r) => r.primary)!.usage!.checkoutKb + 1000);
  } finally { repo.rm(); }
});
