import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slugFor } from "../src/create.ts";
import { applySyncPlan, classifyCopy, isAllowed, isExcluded, isEnvFile, planSync, readSyncConfig, syncFiles } from "../src/sync.ts";
import { makeRepo } from "./harness.ts";

describe("slugFor", () => {
  test("replaces every slash with a dash", () => {
    expect(slugFor("x/my-feature")).toBe("x-my-feature");
    expect(slugFor("feat/a/b")).toBe("feat-a-b");
    expect(slugFor("plain")).toBe("plain");
  });
});

describe("isAllowed", () => {
  test("keeps the files wt exists to sync", () => {
    expect(isAllowed(".env")).toBe(true);
    expect(isAllowed("apps/api/.env.local")).toBe(true);
    expect(isAllowed(".dev.vars")).toBe(true);
    expect(isAllowed("apps/web/.dev.vars")).toBe(true);
    expect(isAllowed(".scratchpad/notes.md")).toBe(true);
    expect(isAllowed(".vscode/settings.json")).toBe(true);
    expect(isAllowed(".idea/workspace.xml")).toBe(true);
    expect(isAllowed(".zed/settings.json")).toBe(true);
    expect(isAllowed(".claude/settings.local.json")).toBe(true);
  });

  test("drops artifact trees and unrelated gitignored files", () => {
    expect(isAllowed("apps/e2e/runs/local/billing-refund-permanent-ses-rejection-releases-the-reserved-autumn-unit")).toBe(false);
    expect(isAllowed(".alchemy/local/aws/lambda/Api/index.js")).toBe(false);
    expect(isAllowed("builder-config.json")).toBe(false);
    expect(isAllowed(".DS_Store")).toBe(false);
    expect(isAllowed(".env.example")).toBe(false);
  });
});

describe("isEnvFile", () => {
  test("matches env files, never examples", () => {
    expect(isEnvFile(".env")).toBe(true);
    expect(isEnvFile("apps/api/.env.local")).toBe(true);
    expect(isEnvFile(".env.example")).toBe(false);
  });
});

describe("isExcluded", () => {
  test("matches multi-component entries at directory boundaries", () => {
    expect(isExcluded(".claude/worktrees/lane/file")).toBe(true);
    expect(isExcluded("sub/.claude/worktrees/lane")).toBe(true);
    expect(isExcluded(".claude/settings.json")).toBe(false);
  });

  test("only protects repository and tool-owned state", () => {
    expect(isExcluded(".git/config")).toBe(true);
    expect(isExcluded(".env")).toBe(false);
    expect(isExcluded("node_modules/pkg/index.js")).toBe(false);
    expect(isExcluded(".scratchpad/archive/note.md")).toBe(false);
  });
});

describe("sync planner", () => {
  test("uses gitignore-style manifests, target ignores, conflicts, and hard exclusions", async () => {
    const repo = makeRepo();
    try {
      repo.write(".gitignore", ".env\n.scratchpad/\n.cache/\n.claude/worktrees/\n");
      repo.write(".worktreeinclude", "/.env\n/.scratchpad/**\n!/.scratchpad/archive/\n!/.scratchpad/archive/**\n/.cache/**\n/.claude/worktrees/**\n");
      repo.commit("sync policy");
      const target = repo.addWorktree("lane", { branch: "lane" });
      repo.write(".env", "A=1\n");
      repo.write(".scratchpad/STATE.md", "same\n");
      repo.write(".scratchpad/archive/old.md", "old\n");
      repo.write(".cache/large.bin", "cache\n");
      repo.write(".claude/worktrees/private/state", "private\n");
      mkdirSync(join(target, ".scratchpad"), { recursive: true });
      writeFileSync(join(target, ".scratchpad/STATE.md"), "same\n");
      writeFileSync(join(target, ".env"), "different\n");

      const plan = await planSync(repo.dir, target, { config: { requireInclude: false, exclude: [] } });
      expect(plan.mode).toBe("manifest");
      expect(plan.manifestHash).toHaveLength(64);
      expect(plan.actions.find((item) => item.path === ".env")?.status).toBe("conflict");
      expect(plan.actions.find((item) => item.path === ".scratchpad/STATE.md")?.status).toBe("skip-identical");
      expect(plan.actions.find((item) => item.path === ".cache/large.bin")?.status).toBe("copy");
      expect(plan.actions.find((item) => item.path === ".claude/worktrees/private/state")?.status).toBe("excluded");
      expect(plan.actions.some((item) => item.path.includes("archive"))).toBe(false);

      const copied = await applySyncPlan(plan);
      expect(copied).toEqual([".cache/large.bin"]);
      expect(readFileSync(join(target, ".env"), "utf8")).toBe("different\n");
    } finally {
      repo.rm();
    }
  });

  test("supports requireInclude and user-level subtractive patterns", async () => {
    const repo = makeRepo();
    try {
      repo.write(".gitignore", ".env\n.scratchpad/\n");
      repo.commit("ignores");
      const target = repo.addWorktree("lane", { branch: "lane" });
      repo.write(".env", "A=1\n");
      repo.write(".scratchpad/STATE.md", "state\n");
      const none = await planSync(repo.dir, target, { config: { requireInclude: true, exclude: [] } });
      expect(none.mode).toBe("none");
      expect(none.actions).toEqual([]);

      repo.write(".worktreeinclude", ".env\n.scratchpad/**\n");
      const excluded = await planSync(repo.dir, target, {
        config: { requireInclude: false, exclude: [".scratchpad/**"] },
      });
      expect(excluded.actions.find((item) => item.path === ".scratchpad/STATE.md")?.reason).toBe("sync.exclude");
    } finally {
      repo.rm();
    }
  });
});

describe("readSyncConfig", () => {
  test("reads ~/.config/wt/config.toml", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-config-"));
    try {
      mkdirSync(join(root, ".config/wt"), { recursive: true });
      writeFileSync(join(root, ".config/wt/config.toml"), "[sync]\nrequireInclude = true\nexclude = [\".env.production*\"]\n");
      expect(readSyncConfig({ HOME: root })).toEqual({ requireInclude: true, exclude: [".env.production*"] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("syncFiles", () => {
  test("recreates dangling symlinks without calling rsync on them", async () => {
    const src = mkdtempSync(join(tmpdir(), "wt-sync-src-"));
    const dest = mkdtempSync(join(tmpdir(), "wt-sync-dst-"));
    mkdirSync(join(src, ".scratchpad"), { recursive: true });
    writeFileSync(join(src, ".env"), "A=1\n");
    symlinkSync("missing-target", join(src, ".scratchpad/stale-link"));

    expect(classifyCopy(src, ".scratchpad/stale-link")).toBe("symlink");
    expect(classifyCopy(src, ".env")).toBe("rsync");

    const landed = await syncFiles(src, dest, [".env", ".scratchpad/stale-link"], false);
    expect(landed).toEqual([".env", ".scratchpad/stale-link"]);
    expect(existsSync(join(dest, ".env"))).toBe(true);
    expect(lstatSync(join(dest, ".scratchpad/stale-link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dest, ".scratchpad/stale-link"))).toBe("missing-target");
  });

  test("skips paths that vanished between listing and copy", async () => {
    const src = mkdtempSync(join(tmpdir(), "wt-sync-src-"));
    const dest = mkdtempSync(join(tmpdir(), "wt-sync-dst-"));
    expect(classifyCopy(src, "gone.env")).toBe("skip");
    const landed = await syncFiles(src, dest, ["gone.env"], false);
    expect(landed).toEqual([]);
  });
});
