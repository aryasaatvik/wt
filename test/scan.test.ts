import { describe, expect, test } from "bun:test";
import { originDefault } from "../src/git.ts";
import { prStateFor, scanWorktrees, type PrInfo } from "../src/scan.ts";
import { makeRepo } from "./harness.ts";

describe("prStateFor", () => {
  const prs: PrInfo[] = [
    { headRefName: "feat/a", state: "OPEN", number: 12 },
    { headRefName: "feat/b", state: "MERGED", number: 8 },
    { headRefName: "feat/c", state: "CLOSED", number: 5 },
  ];

  test("maps gh states and misses", () => {
    expect(prStateFor("feat/a", prs)).toEqual({ prState: "open", prNumber: 12 });
    expect(prStateFor("feat/b", prs)).toEqual({ prState: "merged", prNumber: 8 });
    expect(prStateFor("feat/c", prs)).toEqual({ prState: "closed", prNumber: 5 });
    expect(prStateFor("feat/none", prs)).toEqual({ prState: "none", prNumber: null });
    expect(prStateFor(null, prs)).toEqual({ prState: "none", prNumber: null });
  });

  test("degrades to unknown when gh data is unavailable", () => {
    expect(prStateFor("feat/a", null)).toEqual({ prState: "unknown", prNumber: null });
  });
});

describe("scanWorktrees", () => {
  test("probes dirty, detached, ahead/behind, size, and age", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      expect(originDefault(repo.dir)).toBe("main");
      const firstHead = repo.git("rev-parse", "HEAD").trim();

      // ahead lane: branch worktree with one unpushed commit
      const aheadWt = repo.addWorktree("feat-ahead", { branch: "feat/ahead" });
      repo.gitIn(aheadWt, "commit", "--allow-empty", "-m", "ahead commit");

      // advance main on origin, then a detached lane pinned at the old head is behind
      repo.git("commit", "--allow-empty", "-m", "main moves on");
      repo.git("push", "origin", "main");
      const behindWt = repo.addWorktree("lane-behind", { detachAt: firstHead });

      // dirty lane
      const dirtyWt = repo.addWorktree("feat-dirty", { branch: "feat/dirty" });
      await Bun.write(`${dirtyWt}/junk.txt`, "dirty\n");

      const records = await scanWorktrees(repo.dir);
      const by = (slug: string) => records.find((r) => r.slug === slug)!;

      expect(records.find((r) => r.primary)?.path).toBe(repo.dir);

      const ahead = by("feat-ahead");
      expect(ahead.branch).toBe("feat/ahead");
      expect(ahead.compareRef).toBe("origin/main");
      expect(ahead.ahead).toBe(1);
      expect(ahead.dirty).toBe(false);

      const behind = by("lane-behind");
      expect(behind.detached).toBe(true);
      expect(behind.branch).toBeNull();
      expect(behind.behind).toBeGreaterThanOrEqual(1);
      expect(behind.ahead).toBe(0);

      const dirty = by("feat-dirty");
      expect(dirty.dirty).toBe(true);
      expect(dirty.dirtyCount).toBe(1);

      for (const r of records) {
        expect(r.sizeKb).toBeGreaterThan(0);
        expect(r.lastCommitAt).toBeTruthy();
        // fixture origin is a local bare repo: gh has no GitHub remote to
        // query, so PR state must degrade to "unknown", never throw
        expect(r.prState).toBe("unknown");
      }
    } finally {
      repo.rm();
    }
  });

  test("degrades PR state to unknown when gh is not on PATH", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      const records = await scanWorktrees(repo.dir, { env: { PATH: "/usr/bin:/bin" } });
      expect(records[0]?.prState).toBe("unknown");
    } finally {
      repo.rm();
    }
  });
});
