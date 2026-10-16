import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";
import { makeRepo } from "./harness.ts";
import { readProvenance } from "../src/create.ts";

const wtBin = join(import.meta.dir, "..", "bin", "wt");

function runWt(cwd: string, args: string[]) {
  return spawnSync([process.execPath, wtBin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
}

describe("wt cli", () => {
  test("selects a remote-only branch without a default trunk or fetching", () => {
    const repo = makeRepo();
    try {
      const head = repo.git("rev-parse", "HEAD").trim();
      repo.git("branch", "-m", "custom");
      repo.git("update-ref", "refs/remotes/origin/topic", head);
      // A nonexistent origin proves create uses only cached refs.
      repo.git("remote", "add", "origin", join(repo.root, "offline-origin.git"));
      const result = runWt(repo.dir, ["new", "topic", "--no-install"]);
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      const lane = join(repo.root, "repo-worktrees", "topic");
      expect(repo.gitIn(lane, "rev-parse", "HEAD").trim()).toBe(head);
      expect(readProvenance(lane)?.source).toEqual({
        kind: "origin",
        ref: "refs/remotes/origin/topic",
        head,
      });
      expect(result.stdout.toString()).toContain(head);
    } finally {
      repo.rm();
    }
  });

  test("requires a base only for a genuinely new branch", () => {
    const repo = makeRepo();
    try {
      repo.git("branch", "-m", "custom");
      repo.git("branch", "local-topic");
      expect(runWt(repo.dir, ["new", "local-topic", "--no-install"]).exitCode).toBe(0);
      const result = runWt(repo.dir, ["new", "brand-new", "--no-install"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("cannot determine a default base");
      expect(existsSync(join(repo.root, "repo-worktrees", "brand-new"))).toBe(false);
    } finally {
      repo.rm();
    }
  });

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
      expect(Object.keys(example)).toEqual([
        "version",
        "primary",
        "worktree",
        "head",
        "state",
        "sourceHash",
        "entries",
        "resolutions",
      ]);
      expect(example.entries[0]).toEqual({
        path: "note.md",
        kind: "file",
        hash: "<entry hash from preview>",
        mode: 420,
        status: "review",
      });
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
