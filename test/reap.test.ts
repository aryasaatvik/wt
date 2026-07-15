import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { branchExists } from "../src/git.ts";
import { applyReap, planReap, renderReapReport, type ReapEntry } from "../src/reap.ts";
import { makeRepo, type FixtureRepo } from "./harness.ts";

function write(dir: string, rel: string, content: string) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Fixture: one lane per disposition. */
async function buildFixture(repo: FixtureRepo) {
  repo.addOrigin();
  const head = repo.git("rev-parse", "HEAD").trim();

  // REACHABLE + clean → remove
  const reachable = repo.addWorktree("lane-reachable", { detachAt: head });

  // STRANDED → keep
  const stranded = repo.addWorktree("feat-stranded", { branch: "feat/stranded" });
  write(stranded, "unmerged.txt", "unmerged\n");
  repo.gitIn(stranded, "add", "-A");
  repo.gitIn(stranded, "commit", "-m", "unmerged work");

  // REACHABLE + dirty → skip
  const dirty = repo.addWorktree("lane-dirty", { detachAt: head });
  write(dirty, "uncommitted.txt", "dirty\n");

  // REACHABLE + env drift → skip
  write(repo.dir, ".env", "A=1\n");
  const drifted = repo.addWorktree("lane-drifted", { detachAt: head });
  write(drifted, ".env", "A=1\nLANE_KEY=v\n");

  return { reachable, stranded, dirty, drifted };
}

const dispositionOf = (entries: ReapEntry[], slug: string) =>
  entries.find((e) => e.record.slug === slug)!;

describe("wt reap", () => {
  test("plans dispositions and --apply removes only the safe set", async () => {
    const repo = makeRepo();
    try {
      const lanes = await buildFixture(repo);
      const entries = await planReap({ all: false, cwd: repo.dir });

      expect(dispositionOf(entries, "lane-reachable").disposition).toBe("remove");
      expect(dispositionOf(entries, "feat-stranded").disposition).toBe("keep");
      expect(dispositionOf(entries, "feat-stranded").verdictText).toMatch(/^STRANDED/);
      expect(dispositionOf(entries, "lane-dirty").disposition).toBe("skip");
      expect(dispositionOf(entries, "lane-drifted").disposition).toBe("skip");
      const driftReasons = dispositionOf(entries, "lane-drifted").reasons.join(" ");
      expect(driftReasons).toContain("LANE_KEY");
      expect(driftReasons).not.toContain("=v");

      // dry-run must not touch anything
      expect(existsSync(lanes.reachable)).toBe(true);

      const report = renderReapReport(entries, false);
      expect(report).toContain("WOULD REMOVE");
      expect(report).toContain("lane-reachable");
      expect(report).toContain("--apply");

      const applied = await applyReap(entries);
      expect(applied.removed.map((e) => e.record.slug)).toEqual(["lane-reachable"]);
      expect(applied.skipped).toEqual([]);
      expect(existsSync(lanes.reachable)).toBe(false);
      expect(existsSync(lanes.stranded)).toBe(true);
      expect(existsSync(lanes.dirty)).toBe(true);
      expect(existsSync(lanes.drifted)).toBe(true);
      // reap never deletes branches
      expect(branchExists(repo.dir, "feat/stranded")).toBe(true);
    } finally {
      repo.rm();
    }
  }, 30000);

  test("apply skips a lane whose HEAD moved since the plan (TOCTOU)", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      const head = repo.git("rev-parse", "HEAD").trim();
      const lane = repo.addWorktree("lane-toctou", { detachAt: head });
      const entries = await planReap({ all: false, cwd: repo.dir });
      expect(dispositionOf(entries, "lane-toctou").disposition).toBe("remove");

      repo.gitIn(lane, "commit", "--allow-empty", "-m", "raced in after the scan");

      const applied = await applyReap(entries);
      expect(applied.removed).toEqual([]);
      expect(applied.skipped[0]?.reason).toContain("HEAD moved");
      expect(existsSync(lane)).toBe(true);
    } finally {
      repo.rm();
    }
  }, 30000);

  test("--older-than keeps young lanes", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      const head = repo.git("rev-parse", "HEAD").trim();
      repo.addWorktree("lane-young", { detachAt: head });
      const entries = await planReap({ all: false, cwd: repo.dir, olderThanDays: 1 });
      const young = dispositionOf(entries, "lane-young");
      expect(young.disposition).toBe("keep");
      expect(young.reasons.join(" ")).toContain("newer than 1d");
    } finally {
      repo.rm();
    }
  }, 30000);

  test("salvages unique scratchpad notes during apply", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      const head = repo.git("rev-parse", "HEAD").trim();
      const lane = repo.addWorktree("lane-notes", { detachAt: head });
      write(lane, ".scratchpad/notes/finding.md", "important\n");

      const entries = await planReap({ all: false, cwd: repo.dir });
      expect(dispositionOf(entries, "lane-notes").disposition).toBe("remove");

      const applied = await applyReap(entries);
      expect(applied.removed.length).toBe(1);
      expect(existsSync(lane)).toBe(false);
      const archive = join(repo.dir, ".scratchpad", "archive");
      expect(existsSync(archive)).toBe(true);
      const report = renderReapReport(entries, true, applied);
      expect(report).toContain("salvage: .scratchpad/notes/finding.md");
    } finally {
      repo.rm();
    }
  }, 30000);
});
