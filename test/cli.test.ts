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

  test("`wt scratchpad --help` prints usage and a complete plan example", () => {
    const repo = makeRepo();
    try {
      const result = runWt(repo.dir, ["scratchpad", "--help"]);
      const output = result.stdout.toString();
      expect(result.exitCode).toBe(0);
      expect(output).toContain("Usage: wt scratchpad <target>");
      expect(output).not.toContain("expects a worktree target");
      const start = output.indexOf("{\n");
      const end = output.lastIndexOf("\n}");
      const example = JSON.parse(output.slice(start, end + 2));
      expect(Object.keys(example)).toEqual(["version", "primary", "worktree", "head", "state", "sourceHash", "entries", "resolutions"]);
      expect(example.entries[0]).toEqual({ path: "note.md", kind: "file", hash: "<entry hash from preview>", mode: 420, status: "review" });
      expect(example.resolutions[0]).toEqual({
        path: "note.md",
        sourceHash: "<entry hash from preview>",
        disposition: "integrated",
        reason: "Relevant facts are in the canonical note.",
        evidence: { path: "notes/canonical.md", hash: "<canonical file SHA-256>" },
      });
    } finally {
      repo.rm();
    }
  });
});
