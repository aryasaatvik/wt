import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cmdNew, readProvenance } from "../src/create.ts";
import { resolvePrimaryRepo } from "../src/git.ts";
import { makeRepo } from "./harness.ts";

const OPTS = { verbose: false, install: false, extraFlags: [] };

describe("cmdNew", () => {
  test("creates the worktree, syncs ignored files, skips excluded artifacts", async () => {
    const repo = makeRepo();
    try {
      repo.write(".gitignore", ".env\nnode_modules/\nDerivedData*/\n.scratchpad/\n");
      repo.commit("gitignore");
      repo.write(".env", "SECRET=1\n");
      repo.write(".scratchpad/note.md", "note\n");
      repo.write("node_modules/pkg/index.js", "x\n");
      repo.write("DerivedDataDevice/db.bin", "x\n");

      const wtDir = await cmdNew("feat/sync-test", "main", { ...OPTS, cwd: repo.dir });

      expect(wtDir).toBe(join(repo.root, "repo-worktrees", "feat-sync-test"));
      expect(existsSync(join(wtDir, ".env"))).toBe(true);
      expect(existsSync(join(wtDir, ".scratchpad/note.md"))).toBe(true);
      expect(existsSync(join(wtDir, "node_modules"))).toBe(false);
      expect(existsSync(join(wtDir, "DerivedDataDevice"))).toBe(false);
      expect(repo.gitIn(wtDir, "branch", "--show-current").trim()).toBe("feat/sync-test");

      const marker = readProvenance(wtDir);
      expect(marker?.branch).toBe("feat/sync-test");
      expect(marker?.base).toBe("main");
      expect(marker?.syncedFiles).toContain(".env");
      expect(marker?.syncedFiles).not.toContain("node_modules/pkg/index.js");
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
