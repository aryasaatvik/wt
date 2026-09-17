import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";
import { makeRepo } from "./harness.ts";

const wtBin = join(import.meta.dir, "..", "bin", "wt");

function runWt(cwd: string, args: string[]) {
  return spawnSync([process.execPath, wtBin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
}

describe("wt cli", () => {
  test("`wt help` prints usage instead of creating a worktree named help", () => {
    const repo = makeRepo();
    try {
      const result = runWt(repo.dir, ["help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("Usage:");
      expect(result.stdout.toString()).not.toContain("Creating worktree");
      expect(repo.git("branch", "--list", "help").trim()).toBe("");
      expect(existsSync(join(repo.root, "repo-worktrees", "help"))).toBe(false);
    } finally {
      repo.rm();
    }
  });

  test("`wt --help` still prints usage", () => {
    const repo = makeRepo();
    try {
      const result = runWt(repo.dir, ["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("Usage:");
    } finally {
      repo.rm();
    }
  });
});
