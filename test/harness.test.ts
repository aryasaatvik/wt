import { describe, expect, test } from "bun:test";
import { makeRepo } from "./harness.ts";

describe("fixture harness", () => {
  test("builds a repo with branch and detached worktrees", () => {
    const repo = makeRepo();
    try {
      const head = repo.git("rev-parse", "HEAD").trim();
      const branchWt = repo.addWorktree("feat-x", { branch: "feat/x" });
      const detachedWt = repo.addWorktree("lane-1", { detachAt: head });

      const list = repo.git("worktree", "list", "--porcelain");
      expect(list).toContain(branchWt);
      expect(list).toContain(detachedWt);
      expect(list).toContain("detached");
      expect(repo.gitIn(detachedWt, "rev-parse", "HEAD").trim()).toBe(head);
    } finally {
      repo.rm();
    }
  });
});
