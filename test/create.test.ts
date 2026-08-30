import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { cmdNew, readProvenance } from "../src/create.ts";
import { defaultBase, resolvePrimaryRepo } from "../src/git.ts";
import { ExitError } from "../src/ui.ts";
import { makeRepo } from "./harness.ts";

const OPTS = { verbose: false, install: false, extraFlags: [] };

describe("cmdNew", () => {
  test("creates the worktree, syncs config, skips artifacts and dangling e2e links", async () => {
    const repo = makeRepo();
    try {
      repo.write(".gitignore", ".env\n.env.*\nnode_modules/\nDerivedData*/\n.scratchpad/\nruns/\n");
      repo.commit("gitignore");
      repo.write(".env", "SECRET=1\n");
      repo.write(".scratchpad/note.md", "note\n");
      repo.write("node_modules/pkg/index.js", "x\n");
      repo.write("DerivedDataDevice/db.bin", "x\n");
      repo.write("runs/local/artifact.bin", "heavy\n");
      mkdirSync(join(repo.dir, "runs/local"), { recursive: true });
      symlinkSync(
        "_runs/missing/artifacts",
        join(repo.dir, "runs/local/billing-refund-permanent-ses-rejection-releases-the-reserved-autumn-unit"),
      );
      symlinkSync("missing-env-target", join(repo.dir, ".env.broken"));

      const wtDir = await cmdNew("feat/sync-test", "main", { ...OPTS, cwd: repo.dir });

      expect(wtDir).toBe(join(repo.root, "repo-worktrees", "feat-sync-test"));
      expect(existsSync(join(wtDir, ".env"))).toBe(true);
      expect(existsSync(join(wtDir, ".scratchpad/note.md"))).toBe(true);
      expect(lstatSync(join(wtDir, ".env.broken")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(wtDir, ".env.broken"))).toBe("missing-env-target");
      expect(existsSync(join(wtDir, "node_modules"))).toBe(false);
      expect(existsSync(join(wtDir, "DerivedDataDevice"))).toBe(false);
      expect(existsSync(join(wtDir, "runs/local/artifact.bin"))).toBe(false);
      expect(
        () =>
          lstatSync(
            join(wtDir, "runs/local/billing-refund-permanent-ses-rejection-releases-the-reserved-autumn-unit"),
          ),
      ).toThrow();
      expect(repo.gitIn(wtDir, "branch", "--show-current").trim()).toBe("feat/sync-test");

      const marker = readProvenance(wtDir);
      expect(marker?.branch).toBe("feat/sync-test");
      expect(marker?.base).toBe("main");
      expect(marker?.syncedFiles).toContain(".env");
      expect(marker?.syncedFiles).toContain(".env.broken");
      expect(marker?.syncedFiles).not.toContain("node_modules/pkg/index.js");
      expect(marker?.syncedFiles).not.toContain("runs/local/artifact.bin");
    } finally {
      repo.rm();
    }
  });

  test("checks out an existing branch instead of creating one", async () => {
    const repo = makeRepo();
    try {
      repo.git("branch", "feat/existing");
      const wtDir = await cmdNew("feat/existing", "main", { ...OPTS, cwd: repo.dir });
      expect(repo.gitIn(wtDir, "branch", "--show-current").trim()).toBe("feat/existing");
      expect(readProvenance(wtDir)?.base).toBeNull();
    } finally {
      repo.rm();
    }
  });

  test("uses .worktreeinclude and records sync provenance", async () => {
    const repo = makeRepo();
    try {
      repo.write(".gitignore", ".env\n.scratchpad/\n");
      repo.write(".worktreeinclude", "/.env\n");
      repo.commit("sync manifest");
      repo.write(".env", "A=1\n");
      repo.write(".scratchpad/STATE.md", "not selected\n");

      const wtDir = await cmdNew("feat/manifest", "main", { ...OPTS, cwd: repo.dir });
      const marker = readProvenance(wtDir);
      expect(existsSync(join(wtDir, ".env"))).toBe(true);
      expect(existsSync(join(wtDir, ".scratchpad/STATE.md"))).toBe(false);
      expect(marker?.sync?.mode).toBe("manifest");
      expect(marker?.sync?.manifestHash).toHaveLength(64);
      expect(marker?.sync?.copiedPaths).toEqual([".env"]);
      expect(marker?.sync?.copiedFiles).toBe(1);
      expect(marker?.sync?.copiedBytes).toBe(4);
      expect(marker?.phase).toBe("ready");
    } finally {
      repo.rm();
    }
  });

  test("keeps an incomplete worktree and fails when dependency install fails", async () => {
    const repo = makeRepo();
    try {
      repo.write("package.json", '{"packageManager":"bun@1.4.0"}\n');
      repo.commit("package manager");
      let installedIn = "";
      const run = cmdNew("feat/install-fails", "main", {
        ...OPTS,
        cwd: repo.dir,
        install: true,
        installRunner: async (dir) => {
          installedIn = dir;
          return 23;
        },
      });
      let failure: unknown;
      try { await run; } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(ExitError);
      expect((failure as ExitError).code).toBe(23);
      const wtDir = join(repo.root, "repo-worktrees", "feat-install-fails");
      expect(installedIn).toBe(wtDir);
      expect(existsSync(wtDir)).toBe(true);
      expect(readProvenance(wtDir)).toEqual(expect.objectContaining({
        phase: "incomplete",
        failure: "dependency install exited 23",
        recoveryCommand: `cd '${wtDir}' && ni`,
      }));
    } finally {
      repo.rm();
    }
  });

  test("records incomplete when the installer throws", async () => {
    const repo = makeRepo();
    try {
      repo.write("package.json", '{"packageManager":"bun@1.4.0"}\n');
      repo.commit("package manager");
      let failure: unknown;
      try {
        await cmdNew("feat/install-throws", "main", {
          ...OPTS,
          cwd: repo.dir,
          install: true,
          installRunner: async () => { throw new Error("spawn EACCES"); },
        });
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(ExitError);
      const wtDir = join(repo.root, "repo-worktrees", "feat-install-throws");
      expect(readProvenance(wtDir)).toEqual(expect.objectContaining({
        phase: "incomplete",
        failure: "dependency install failed: spawn EACCES",
        recoveryCommand: `cd '${wtDir}' && ni`,
      }));
    } finally {
      repo.rm();
    }
  });
});

describe("defaultBase", () => {
  test("prefers origin/HEAD", () => {
    const repo = makeRepo();
    try {
      repo.git("branch", "trunk");
      repo.addOrigin();
      repo.git("push", "origin", "trunk");
      repo.git("remote", "set-head", "origin", "trunk");
      expect(defaultBase(repo.dir)).toBe("origin/trunk");
    } finally {
      repo.rm();
    }
  });

  test("ignores a stale origin/HEAD symbolic ref", () => {
    const repo = makeRepo();
    try {
      repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing");
      expect(defaultBase(repo.dir)).toBe("main");
    } finally {
      repo.rm();
    }
  });

  test("falls back to local main/master/dev and otherwise fails", () => {
    const repo = makeRepo();
    try {
      expect(defaultBase(repo.dir)).toBe("main");
      repo.git("branch", "-m", "custom");
      expect(defaultBase(repo.dir)).toBeNull();
    } finally {
      repo.rm();
    }
  });
});

describe("resolvePrimaryRepo", () => {
  test("resolves the primary root from inside a worktree", () => {
    const repo = makeRepo();
    try {
      const wt = repo.addWorktree("lane", { branch: "lane" });
      expect(resolvePrimaryRepo(wt)).toBe(resolvePrimaryRepo(repo.dir));
    } finally {
      repo.rm();
    }
  });

  test.if(process.platform === "darwin")("canonicalizes path case (APFS)", () => {
    const repo = makeRepo();
    try {
      const mangled = repo.dir.replace(/repo$/, "REPO");
      expect(resolvePrimaryRepo(mangled)).toBe(resolvePrimaryRepo(repo.dir));
      expect(resolvePrimaryRepo(mangled).endsWith("/repo")).toBe(true);
    } finally {
      repo.rm();
    }
  });
});
