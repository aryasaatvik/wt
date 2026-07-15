import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cmdRm, resolveTarget } from "../src/rm.ts";
import { branchExists } from "../src/git.ts";
import { makeRepo } from "./harness.ts";

describe("cmdRm", () => {
  test("removes by branch name", async () => {
    const repo = makeRepo();
    try {
      const wt = repo.addWorktree("feat-x", { branch: "feat/x" });
      await cmdRm("feat/x", { deleteBranch: false, cwd: repo.dir });
      expect(existsSync(wt)).toBe(false);
      expect(branchExists(repo.dir, "feat/x")).toBe(true);
    } finally {
      repo.rm();
    }
  });

  test("removes a DETACHED worktree by directory slug", async () => {
    const repo = makeRepo();
    try {
      const head = repo.git("rev-parse", "HEAD").trim();
      const wt = repo.addWorktree("lane-1", { detachAt: head });
      expect(resolveTarget("lane-1", repo.dir)?.path).toBe(wt);
      await cmdRm("lane-1", { deleteBranch: false, cwd: repo.dir });
      expect(existsSync(wt)).toBe(false);
    } finally {
      repo.rm();
    }
  });

  test("removes by path", async () => {
    const repo = makeRepo();
    try {
      const head = repo.git("rev-parse", "HEAD").trim();
      const wt = repo.addWorktree("lane-2", { detachAt: head });
      await cmdRm(wt, { deleteBranch: false, cwd: repo.dir });
      expect(existsSync(wt)).toBe(false);
    } finally {
      repo.rm();
    }
  });

  test("-D deletes the branch after removal", async () => {
    const repo = makeRepo();
    try {
      repo.addWorktree("feat-y", { branch: "feat/y" });
      await cmdRm("feat/y", { deleteBranch: true, cwd: repo.dir });
      expect(branchExists(repo.dir, "feat/y")).toBe(false);
    } finally {
      repo.rm();
    }
  });

  test("refuses a dirty worktree", async () => {
    const repo = makeRepo();
    try {
      const wt = repo.addWorktree("feat-dirty", { branch: "feat/dirty" });
      await Bun.write(`${wt}/uncommitted.txt`, "dirty\n");
      await expect(cmdRm("feat/dirty", { deleteBranch: false, cwd: repo.dir })).rejects.toThrow();
      expect(existsSync(wt)).toBe(true);
    } finally {
      repo.rm();
    }
  });

  test("errors clearly on unknown target", async () => {
    const repo = makeRepo();
    try {
      await expect(cmdRm("nope", { deleteBranch: false, cwd: repo.dir })).rejects.toThrow();
    } finally {
      repo.rm();
    }
  });
});
