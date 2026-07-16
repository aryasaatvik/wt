import { describe, expect, test } from "bun:test";
import { classifyWorktree, verdictLabel } from "../src/verdict.ts";
import { makeRepo } from "./harness.ts";

describe("classifyWorktree", () => {
  test("REACHABLE: detached at a pushed default-branch commit", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      const head = repo.git("rev-parse", "HEAD").trim();
      const wt = repo.addWorktree("lane", { detachAt: head });
      expect((await classifyWorktree(wt)).kind).toBe("REACHABLE");
    } finally {
      repo.rm();
    }
  });

  test("REACHABLE_BRANCH: tip of a pushed feature branch", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      const wt = repo.addWorktree("feat-x", { branch: "feat/x" });
      repo.gitIn(wt, "commit", "--allow-empty", "-m", "feature work");
      repo.gitIn(wt, "push", "-u", "origin", "feat/x");
      const v = await classifyWorktree(wt);
      expect(v.kind).toBe("REACHABLE_BRANCH");
      expect(v.ref).toBe("origin/feat/x");
    } finally {
      repo.rm();
    }
  });

  test("EMPTY: unpushed lane with no unique content", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      const wt = repo.addWorktree("feat-empty", { branch: "feat/empty" });
      repo.gitIn(wt, "commit", "--allow-empty", "-m", "no content");
      expect((await classifyWorktree(wt)).kind).toBe("EMPTY");
    } finally {
      repo.rm();
    }
  });

  test("CONTENT_LANDED: squash-merged lane", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      const wt = repo.addWorktree("feat-squash", { branch: "feat/squash" });
      repo.write(".keep", "");
      // lane commits a change
      await Bun.write(`${wt}/feature.txt`, "landed content\n");
      repo.gitIn(wt, "add", "-A");
      repo.gitIn(wt, "commit", "-m", "add feature");
      // main squash-merges it (same content, different commit) and pushes
      repo.git("merge", "--squash", "feat/squash");
      repo.git("commit", "-m", "feat: squashed");
      repo.git("push", "origin", "main");
      const v = await classifyWorktree(wt);
      expect(v.kind).toBe("CONTENT_LANDED");
    } finally {
      repo.rm();
    }
  });

  test("STRANDED: lane content differs from origin", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      const wt = repo.addWorktree("feat-stranded", { branch: "feat/stranded" });
      await Bun.write(`${wt}/only-here.txt`, "unmerged work\n");
      repo.gitIn(wt, "add", "-A");
      repo.gitIn(wt, "commit", "-m", "unmerged");
      const v = await classifyWorktree(wt);
      expect(v.kind).toBe("STRANDED");
      expect(v.differing).toBe(1);
      expect(v.total).toBe(1);
      expect(verdictLabel(v)).toBe("STRANDED(1/1)");
    } finally {
      repo.rm();
    }
  });

  test("NO_REMOTE_REF: repo without origin", async () => {
    const repo = makeRepo();
    try {
      const wt = repo.addWorktree("lane", { branch: "lane" });
      expect((await classifyWorktree(wt)).kind).toBe("NO_REMOTE_REF");
    } finally {
      repo.rm();
    }
  });

  test("verdictLabel appends merged-PR evidence", () => {
    expect(verdictLabel({ kind: "REACHABLE", ref: "origin/main" }, "merged", 42)).toBe(
      "REACHABLE (PR #42 merged)",
    );
  });
});
