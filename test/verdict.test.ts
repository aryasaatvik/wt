import { describe, expect, test } from "bun:test";
import { classifyWorktree, isRemovable, verdictLabel } from "../src/verdict.ts";
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

  // The bug this split fixes: a pushed-but-unmerged lane — every open PR looks
  // like this — used to classify as REACHABLE_BRANCH and auto-remove.
  test("PUSHED_ONLY: tip of a pushed feature branch is durable, not landed", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      const wt = repo.addWorktree("feat-x", { branch: "feat/x" });
      repo.gitIn(wt, "commit", "--allow-empty", "-m", "feature work");
      repo.gitIn(wt, "push", "-u", "origin", "feat/x");
      const v = await classifyWorktree(wt);
      expect(v.kind).toBe("PUSHED_ONLY");
      expect(v.ref).toBe("origin/feat/x");
    } finally {
      repo.rm();
    }
  });

  test("REACHABLE_BRANCH: contained in a mainline branch other than the default", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      // work that landed on dev but not yet on main
      repo.git("checkout", "-b", "dev");
      repo.git("commit", "--allow-empty", "-m", "landed on dev");
      repo.git("push", "-u", "origin", "dev");
      const devHead = repo.git("rev-parse", "HEAD").trim();
      repo.git("checkout", "main");
      const wt = repo.addWorktree("lane-dev", { detachAt: devHead });
      const v = await classifyWorktree(wt);
      expect(v.kind).toBe("REACHABLE_BRANCH");
      expect(v.ref).toBe("origin/dev");
    } finally {
      repo.rm();
    }
  });

  test("PUSHED_ONLY: conventional branches on backup remotes are not landing evidence", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      const wt = repo.addWorktree("feat-backup", { branch: "feat/backup" });
      repo.gitIn(wt, "commit", "--allow-empty", "-m", "unlanded backup");
      const head = repo.gitIn(wt, "rev-parse", "HEAD").trim();
      repo.git("remote", "add", "backup", "https://github.com/me/widgets.git");
      repo.git("update-ref", "refs/remotes/backup/main", head);
      const v = await classifyWorktree(wt);
      expect(v.kind).toBe("PUSHED_ONLY");
      expect(v.ref).toBe("backup/main");
    } finally {
      repo.rm();
    }
  });

  test("PUSHED_ONLY: detached lane left on a feature branch by a stack merge", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      const wt = repo.addWorktree("feat-stack", { branch: "feat/stack" });
      repo.gitIn(wt, "commit", "--allow-empty", "-m", "stacked work");
      repo.gitIn(wt, "push", "-u", "origin", "feat/stack");
      const head = repo.gitIn(wt, "rev-parse", "HEAD").trim();
      // a stack CLI detaches the lane after merging it
      repo.gitIn(wt, "checkout", "--detach", head);
      expect((await classifyWorktree(wt)).kind).toBe("PUSHED_ONLY");
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

  test("verdictLabel appends PR evidence", () => {
    expect(verdictLabel({ kind: "REACHABLE", ref: "origin/main" }, "merged", 42)).toBe(
      "REACHABLE (PR #42 merged)",
    );
    expect(verdictLabel({ kind: "PUSHED_ONLY", ref: "origin/feat/x" }, "open", 7)).toBe(
      "PUSHED_ONLY (PR #7 open)",
    );
    expect(verdictLabel({ kind: "REACHABLE", ref: "origin/main" }, "none", null)).toBe("REACHABLE");
  });
});

describe("isRemovable", () => {
  test("an open PR vetoes every verdict", () => {
    for (const kind of ["REACHABLE", "REACHABLE_BRANCH", "EMPTY", "CONTENT_LANDED"] as const) {
      expect(isRemovable(kind, "open")).toBe(false);
    }
  });

  test("reachability tiers remove only when PR lookup is conclusive", () => {
    for (const kind of ["REACHABLE", "REACHABLE_BRANCH", "EMPTY", "CONTENT_LANDED"] as const) {
      expect(isRemovable(kind, "none")).toBe(true);
      expect(isRemovable(kind, "unknown")).toBe(false);
    }
  });

  test("PUSHED_ONLY removes only on a merged PR", () => {
    expect(isRemovable("PUSHED_ONLY", "merged")).toBe(true);
    expect(isRemovable("PUSHED_ONLY", "open")).toBe(false);
    expect(isRemovable("PUSHED_ONLY", "closed")).toBe(false);
    expect(isRemovable("PUSHED_ONLY", "none")).toBe(false);
    // a failed gh lookup must not read as "no PR, go ahead"
    expect(isRemovable("PUSHED_ONLY", "unknown")).toBe(false);
  });

  test("STRANDED and edge verdicts never remove, merged PR or not", () => {
    for (const kind of ["STRANDED", "NO_REMOTE_REF", "NO_MERGE_BASE", "PROBE_FAILED"] as const) {
      expect(isRemovable(kind, "merged")).toBe(false);
      expect(isRemovable(kind, "none")).toBe(false);
    }
  });
});
