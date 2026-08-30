import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cmdLs, discoverPrimaries, humanAge, humanSize, renderTable, sizeLabel } from "../src/ls.ts";
import type { WorktreeStatus } from "../src/scan.ts";
import { makeRepo } from "./harness.ts";

describe("humanSize", () => {
  test("scales K/M/G", () => {
    expect(humanSize(null)).toBe("-");
    expect(humanSize(512)).toBe("512K");
    expect(humanSize(1536)).toBe("1.5M");
    expect(humanSize(36 * 1024)).toBe("36M");
    expect(humanSize(2.5 * 1024 * 1024)).toBe("2.5G");
  });
});

describe("humanAge", () => {
  const now = Date.parse("2026-07-15T12:00:00Z");
  test("buckets minutes to years", () => {
    expect(humanAge(null, now)).toBe("-");
    expect(humanAge("2026-07-15T11:30:00Z", now)).toBe("30m");
    expect(humanAge("2026-07-15T02:00:00Z", now)).toBe("10h");
    expect(humanAge("2026-07-10T12:00:00Z", now)).toBe("5d");
    expect(humanAge("2026-04-15T12:00:00Z", now)).toBe("3mo");
    expect(humanAge("2024-07-15T12:00:00Z", now)).toBe("2y");
  });
});

function record(over: Partial<WorktreeStatus>): WorktreeStatus {
  return {
    path: "/tmp/repo-worktrees/x",
    slug: "x",
    branch: "feat/x",
    head: "abcdef0123456789",
    detached: false,
    primary: false,
    locked: false,
    prunable: false,
    dirty: false,
    dirtyCount: 0,
    compareRef: "origin/main",
    ahead: 0,
    behind: 0,
    sizeKb: 2048,
    sizeCached: false,
    diskUsage: { checkoutKb: 2048, privateGitKb: 0, ownedKb: 2048, sharedKb: 512 },
    lastCommitAt: "2026-07-14T12:00:00Z",
    mtimeMs: 0,
    prState: "none",
    prNumber: null,
    ...over,
  };
}

describe("sizeLabel", () => {
  test("marks cached sizes with ~ and leaves fresh/missing sizes alone", () => {
    expect(sizeLabel(record({ sizeKb: 2048, sizeCached: false }))).toBe("2.0M");
    expect(sizeLabel(record({ sizeKb: 2048, sizeCached: true }))).toBe("~2.0M");
    expect(sizeLabel(record({ sizeKb: null, sizeCached: false }))).toBe("-");
  });
});

describe("renderTable", () => {
  test("plain snapshot", () => {
    const now = Date.parse("2026-07-15T12:00:00Z");
    const out = renderTable(
      [
        record({ slug: "repo", primary: true, branch: "main" }),
        record({ slug: "feat-x", dirty: true, dirtyCount: 3, ahead: 2, prState: "open", prNumber: 4 }),
        record({ slug: "lane-1", branch: null, detached: true, prState: "unknown" }),
      ],
      now,
    );
    expect(out).toBe(
      [
        "WORKTREE        BRANCH            DIRTY  ±      PR      SIZE  AGE",
        "repo (primary)  main              -      +0/-0  -       2.0M  1d ",
        "feat-x          feat/x            3*     +2/-0  open#4  2.0M  1d ",
        "lane-1          detached@abcdef0  -      +0/-0  ?       2.0M  1d ",
      ].join("\n"),
    );
  });
});

describe("discovery and --all", () => {
  test("finds primaries via *-worktrees dirs and reports registered strays", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      repo.addWorktree("conventional-lane", { branch: "feat/conv" });
      // stray: registered worktree OUTSIDE the <repo>-worktrees convention
      const strayDir = join(repo.root, "elsewhere", "stray-lane");
      repo.git("worktree", "add", "-b", "feat/stray", strayDir);

      expect(discoverPrimaries(repo.root)).toEqual([repo.dir]);

      const json = await cmdLs({ json: true, all: true, cwd: repo.root, devRoot: repo.root });
      const fleet = JSON.parse(json) as Array<{ slug: string; repo: string; path: string }>;
      const slugs = fleet.map((f) => f.slug).sort();
      expect(slugs).toEqual(["conventional-lane", "repo", "stray-lane"]);
      expect(fleet.every((f) => f.repo === "repo")).toBe(true);

      const table = await cmdLs({ json: false, all: true, cwd: repo.root, devRoot: repo.root });
      expect(table).toContain("stray-lane");
      expect(table).not.toContain("(primary)");
    } finally {
      repo.rm();
    }
  });

  test("cmdLs errors outside a repo without --all", async () => {
    const repo = makeRepo();
    try {
      await expect(
        cmdLs({ json: false, all: false, cwd: join(repo.root, "elsewhere-nonexistent") }),
      ).rejects.toThrow();
    } finally {
      repo.rm();
    }
  });
});
