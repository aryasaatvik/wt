import { describe, expect, test } from "bun:test";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slugFor } from "../src/create.ts";
import { applySyncPlan, classifyCopy, copyFileNoFollowAt, isAllowed, isExcluded, isEnvFile, planSync, readSyncConfig, syncFiles } from "../src/sync.ts";
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
      repo.write(".gitignore", ".env\n.scratchpad/\n.cache/\n.claude/worktrees/\nsource-only.local\n");
      repo.write(".worktreeinclude", "/.env\n/.scratchpad/**\n!/.scratchpad/archive/\n!/.scratchpad/archive/**\n/.cache/**\n/.claude/worktrees/**\n/source-only.local\n");
      repo.commit("sync policy");
      const target = repo.addWorktree("lane", { branch: "lane" });
      repo.write(".env", "A=1\n");
      repo.write(".scratchpad/STATE.md", "same\n");
      repo.write(".scratchpad/archive/old.md", "old\n");
      repo.write(".cache/large.bin", "cache\n");
      repo.write(".claude/worktrees/private/state", "private\n");
      repo.write("source-only.local", "source\n");
      writeFileSync(join(target, ".gitignore"), ".env\n.scratchpad/\n.cache/\n.claude/worktrees/\n");
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
      expect(plan.actions.find((item) => item.path === "source-only.local")?.reason).toBe("not ignored by target");
      expect(plan.actions.some((item) => item.path.includes("archive"))).toBe(false);

      const copied = await applySyncPlan(plan);
      expect(copied).toEqual([".cache/large.bin"]);
      expect(readFileSync(join(target, ".env"), "utf8")).toBe("different\n");

      const forced = await planSync(repo.dir, target, { force: true, config: { requireInclude: false, exclude: [] } });
      expect(forced.actions.find((item) => item.path === ".env")?.status).toBe("copy");
      await applySyncPlan(forced);
      expect(readFileSync(join(target, ".env"), "utf8")).toBe("A=1\n");
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

  test("copies newline paths without injecting extra rsync entries", async () => {
    const src = mkdtempSync(join(tmpdir(), "wt-sync-src-"));
    const dest = mkdtempSync(join(tmpdir(), "wt-sync-dst-"));
    writeFileSync(join(src, "selected\nname"), "selected\n");
    writeFileSync(join(src, "name"), "must not copy\n");
    const landed = await syncFiles(src, dest, ["selected\nname"], false);
    expect(landed).toEqual(["selected\nname"]);
    expect(readFileSync(join(dest, "selected\nname"), "utf8")).toBe("selected\n");
    expect(existsSync(join(dest, "name"))).toBe(false);
  });
});

test("copyFileNoFollowAt rejects a symlink source without creating a target", () => {
  const source = mkdtempSync(join(tmpdir(), "wt-copy-source-"));
  const target = mkdtempSync(join(tmpdir(), "wt-copy-target-"));
  writeFileSync(join(source, "referent"), "outside\n");
  symlinkSync("referent", join(source, "source"));
  const sourceFd = openSync(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const destinationFd = openSync(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    expect(() => copyFileNoFollowAt(sourceFd, "source", destinationFd, "target")).toThrow();
    expect(existsSync(join(target, "target"))).toBe(false);
  } finally {
    closeSync(destinationFd);
    closeSync(sourceFd);
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("copyFileNoFollowAt stays anchored when a destination parent is replaced", () => {
  const source = mkdtempSync(join(tmpdir(), "wt-copy-source-"));
  const target = mkdtempSync(join(tmpdir(), "wt-copy-target-"));
  const outside = mkdtempSync(join(tmpdir(), "wt-copy-outside-"));
  mkdirSync(join(target, "parent"));
  writeFileSync(join(source, "source"), "safe\n");
  const sourceFd = openSync(
    source,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const destinationFd = openSync(
    join(target, "parent"),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    renameSync(join(target, "parent"), join(target, "moved"));
    symlinkSync(outside, join(target, "parent"));
    copyFileNoFollowAt(sourceFd, "source", destinationFd, "copied");
    expect(readFileSync(join(target, "moved/copied"), "utf8")).toBe("safe\n");
    expect(existsSync(join(outside, "copied"))).toBe(false);
  } finally {
    closeSync(destinationFd);
    closeSync(sourceFd);
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("applySyncPlan preserves a target created after planning", async () => {
  const repo = makeRepo();
  try {
    repo.write(".gitignore", ".env\n");
    repo.write(".worktreeinclude", ".env\n");
    repo.commit("policy");
    const target = repo.addWorktree("lane", { branch: "lane" });
    repo.write(".env", "source\n");
    const plan = await planSync(repo.dir, target, { config: { requireInclude: false, exclude: [] } });
    writeFileSync(join(target, ".env"), "late target\n");
    await expect(applySyncPlan(plan)).rejects.toThrow("target changed while copying");
    expect(readFileSync(join(target, ".env"), "utf8")).toBe("late target\n");
  } finally {
    repo.rm();
  }
});

test("applySyncPlan does not copy beneath a late target directory", async () => {
  const repo = makeRepo();
  try {
    repo.write(".gitignore", ".env\n");
    repo.write(".worktreeinclude", ".env\n");
    repo.commit("policy");
    const target = repo.addWorktree("lane", { branch: "lane" });
    repo.write(".env", "source\n");
    const plan = await planSync(repo.dir, target, { config: { requireInclude: false, exclude: [] } });
    mkdirSync(join(target, ".env"));
    await expect(applySyncPlan(plan)).rejects.toThrow();
    expect(existsSync(join(target, ".env/.env"))).toBe(false);
  } finally {
    repo.rm();
  }
});

test("applySyncPlan rejects a symlinked destination parent", async () => {
  const repo = makeRepo();
  const outside = mkdtempSync(join(tmpdir(), "wt-sync-outside-"));
  try {
    repo.write(".gitignore", ".scratchpad/\n");
    repo.write(".worktreeinclude", ".scratchpad/**\n");
    repo.commit("policy");
    const target = repo.addWorktree("lane", { branch: "lane" });
    repo.write(".scratchpad/STATE.md", "source\n");
    const plan = await planSync(repo.dir, target, { config: { requireInclude: false, exclude: [] } });
    symlinkSync(outside, join(target, ".scratchpad"));
    await expect(applySyncPlan(plan)).rejects.toThrow("unsafe symlink or non-directory parent");
    expect(existsSync(join(outside, "STATE.md"))).toBe(false);
  } finally {
    repo.rm();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("forced sync replaces a leaf symlink without touching its referent", async () => {
  const repo = makeRepo();
  const outside = mkdtempSync(join(tmpdir(), "wt-sync-outside-"));
  try {
    repo.write(".gitignore", ".env\n");
    repo.write(".worktreeinclude", ".env\n");
    repo.commit("policy");
    const target = repo.addWorktree("lane", { branch: "lane" });
    repo.write(".env", "source\n");
    const referent = join(outside, "referent");
    writeFileSync(referent, "outside\n");
    symlinkSync(referent, join(target, ".env"));
    const plan = await planSync(repo.dir, target, { force: true, config: { requireInclude: false, exclude: [] } });
    await applySyncPlan(plan);
    expect(lstatSync(join(target, ".env")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(target, ".env"), "utf8")).toBe("source\n");
    expect(readFileSync(referent, "utf8")).toBe("outside\n");
  } finally {
    repo.rm();
    rmSync(outside, { recursive: true, force: true });
  }
});
