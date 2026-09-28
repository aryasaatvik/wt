import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cmdRm, resolveTarget } from "../src/rm.ts";
import { branchExists } from "../src/git.ts";
import { makeRepo } from "./harness.ts";

describe("cmdRm", () => {
  test("removes by branch name", async () => {
    const repo = makeRepo();
    try {
      const wt = repo.addWorktree("feat-x", { branch: "feat/x" });
      await cmdRm("feat/x", { deleteBranch: false, cwd: repo.dir });
      expect(existsSync(wt)).toBe(false);
      expect(branchExists(repo.dir, "feat/x")).toBe(true);
    } finally {
      repo.rm();
    }
  });

  test("removes a DETACHED worktree by directory slug", async () => {
    const repo = makeRepo();
    try {
      const head = repo.git("rev-parse", "HEAD").trim();
      const wt = repo.addWorktree("lane-1", { detachAt: head });
      expect(resolveTarget("lane-1", repo.dir)?.path).toBe(wt);
      await cmdRm("lane-1", { deleteBranch: false, cwd: repo.dir });
      expect(existsSync(wt)).toBe(false);
    } finally {
      repo.rm();
    }
  });

  test("removes by path", async () => {
    const repo = makeRepo();
    try {
      const head = repo.git("rev-parse", "HEAD").trim();
      const wt = repo.addWorktree("lane-2", { detachAt: head });
      await cmdRm(wt, { deleteBranch: false, cwd: repo.dir });
      expect(existsSync(wt)).toBe(false);
    } finally {
      repo.rm();
    }
  });

  test("resolves an exact path in another repository and keeps its branch", async () => {
    const owner = makeRepo();
    const caller = makeRepo();
    try {
      const wt = owner.addWorktree("other-lane", { branch: "feat/other" });
      expect(resolveTarget(wt, caller.dir)?.path).toBe(wt);
      expect(resolveTarget("feat/other", caller.dir)).toBeNull();
      await cmdRm(wt, { deleteBranch: false, cwd: caller.dir });
      expect(existsSync(wt)).toBe(false);
      expect(branchExists(owner.dir, "feat/other")).toBe(true);
    } finally {
      owner.rm();
      caller.rm();
    }
  });

  test("-D deletes the owning repository's branch for an exact foreign path", async () => {
    const owner = makeRepo();
    const caller = makeRepo();
    try {
      const wt = owner.addWorktree("other-lane", { branch: "feat/other" });
      await cmdRm(wt, { deleteBranch: true, cwd: caller.dir });
      expect(existsSync(wt)).toBe(false);
      expect(branchExists(owner.dir, "feat/other")).toBe(false);
    } finally {
      owner.rm();
      caller.rm();
    }
  });

  test("refuses removal from the target worktree", async () => {
    const repo = makeRepo();
    try {
      const wt = repo.addWorktree("caller-lane", { branch: "feat/caller" });
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
      try {
        await expect(cmdRm("caller-lane", { deleteBranch: false, cwd: wt })).rejects.toThrow();
      } finally {
        console.error = original;
      }
      expect(errors.join("\n")).toContain("Run wt rm from the primary checkout or another worktree");
      expect(existsSync(wt)).toBe(true);
    } finally {
      repo.rm();
    }
  });

  test("refuses removal from a nested directory in the target", async () => {
    const repo = makeRepo();
    try {
      const wt = repo.addWorktree("caller-lane", { branch: "feat/caller" });
      const nested = join(wt, "nested");
      mkdirSync(nested);
      await expect(cmdRm("caller-lane", { deleteBranch: false, cwd: nested })).rejects.toThrow();
      expect(existsSync(wt)).toBe(true);
    } finally {
      repo.rm();
    }
  });

  test("refuses removal when a valid PWD is inside the target", async () => {
    const repo = makeRepo();
    const originalPwd = process.env.PWD;
    try {
      const wt = repo.addWorktree("caller-lane", { branch: "feat/caller" });
      const nested = join(wt, "nested");
      mkdirSync(nested);
      process.env.PWD = nested;
      await expect(cmdRm("caller-lane", { deleteBranch: false, cwd: repo.dir })).rejects.toThrow();
      expect(existsSync(wt)).toBe(true);
    } finally {
      if (originalPwd === undefined) delete process.env.PWD;
      else process.env.PWD = originalPwd;
      repo.rm();
    }
  });

  test("a sibling with the same path prefix does not count as inside the target", async () => {
    const repo = makeRepo();
    const originalPwd = process.env.PWD;
    try {
      const wt = repo.addWorktree("caller-lane", { branch: "feat/caller" });
      const sibling = repo.addWorktree("caller-lane-more", { branch: "feat/sibling" });
      process.env.PWD = sibling;
      await cmdRm("caller-lane", { deleteBranch: false, cwd: repo.dir });
      expect(existsSync(wt)).toBe(false);
      expect(existsSync(sibling)).toBe(true);
    } finally {
      if (originalPwd === undefined) delete process.env.PWD;
      else process.env.PWD = originalPwd;
      repo.rm();
    }
  });

  test("-D deletes the branch after removal", async () => {
    const repo = makeRepo();
    try {
      repo.addWorktree("feat-y", { branch: "feat/y" });
      await cmdRm("feat/y", { deleteBranch: true, cwd: repo.dir });
      expect(branchExists(repo.dir, "feat/y")).toBe(false);
    } finally {
      repo.rm();
    }
  });

  test("refuses a dirty worktree", async () => {
    const repo = makeRepo();
    try {
      const wt = repo.addWorktree("feat-dirty", { branch: "feat/dirty" });
      await Bun.write(`${wt}/uncommitted.txt`, "dirty\n");
      await expect(cmdRm("feat/dirty", { deleteBranch: false, cwd: repo.dir })).rejects.toThrow();
      expect(existsSync(wt)).toBe(true);
    } finally {
      repo.rm();
    }
  });

  test("-D on a detached worktree fails BEFORE removing anything", async () => {
    const repo = makeRepo();
    try {
      const head = repo.git("rev-parse", "HEAD").trim();
      const wt = repo.addWorktree("lane-detached", { detachAt: head });
      await expect(cmdRm("lane-detached", { deleteBranch: true, cwd: repo.dir })).rejects.toThrow();
      expect(existsSync(wt)).toBe(true);
    } finally {
      repo.rm();
    }
  });

  test("errors clearly on unknown target", async () => {
    const repo = makeRepo();
    try {
      await expect(cmdRm("nope", { deleteBranch: false, cwd: repo.dir })).rejects.toThrow();
    } finally {
      repo.rm();
    }
  });

  test("env-drift refusal prints the reconciliation commands", async () => {
    const repo = makeRepo();
    try {
      await Bun.write(`${repo.dir}/.env`, "A=1\n");
      const wt = repo.addWorktree("feat-env", { branch: "feat/env" });
      await Bun.write(`${wt}/.env`, "A=1\nB=2\n");
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
      try {
        await expect(cmdRm("feat/env", { deleteBranch: false, cwd: repo.dir })).rejects.toThrow();
      } finally {
        console.error = original;
      }
      const text = errors.join("\n");
      expect(text).toContain("[env-drift]");
      expect(text).toContain("wt sync --dry-run");
      expect(text).toContain("--force");
      expect(text).toContain("'feat/env'");
      expect(existsSync(wt)).toBe(true);
    } finally {
      repo.rm();
    }
  });

  test("removes a clean worktree with an initialized submodule", async () => {
    const module = makeRepo();
    const repo = makeRepo();
    try {
      repo.git("-c", "protocol.file.allow=always", "submodule", "add", module.dir, "vendor/module");
      repo.commit("add submodule");
      const wt = repo.addWorktree("with-module", { branch: "feat/module" });
      repo.gitIn(wt, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
      await cmdRm("feat/module", { deleteBranch: false, cwd: repo.dir });
      expect(existsSync(wt)).toBe(false);
      expect(repo.git("worktree", "list", "--porcelain")).not.toContain(wt);
      const archives = readdirSync(join(repo.dir, ".git")).filter((name) => name.startsWith("wt-submodules-"));
      expect(archives).toHaveLength(1);
      expect(existsSync(join(repo.dir, ".git", archives[0]!, "modules/vendor/module/HEAD"))).toBe(true);
    } finally {
      repo.rm();
      module.rm();
    }
  });

  test("refuses a dirty submodule without deinitializing it", async () => {
    const module = makeRepo();
    const repo = makeRepo();
    try {
      repo.git("-c", "protocol.file.allow=always", "submodule", "add", module.dir, "vendor/module");
      repo.commit("add submodule");
      const wt = repo.addWorktree("with-module", { branch: "feat/module" });
      repo.gitIn(wt, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
      await Bun.write(join(wt, "vendor/module/untracked.txt"), "keep\n");
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
      try {
        await expect(cmdRm("feat/module", { deleteBranch: false, cwd: repo.dir })).rejects.toThrow();
      } finally {
        console.error = original;
      }
      expect(errors.join("\n")).toContain("vendor/module");
      expect(existsSync(join(wt, "vendor/module/.git"))).toBe(true);
      expect(existsSync(join(wt, "vendor/module/untracked.txt"))).toBe(true);
    } finally {
      repo.rm();
      module.rm();
    }
  });

  test("refuses a modified tracked file in a submodule without deinitializing it", async () => {
    const module = makeRepo();
    const repo = makeRepo();
    try {
      repo.git("-c", "protocol.file.allow=always", "submodule", "add", module.dir, "vendor/module");
      repo.commit("add submodule");
      const wt = repo.addWorktree("with-module", { branch: "feat/module" });
      repo.gitIn(wt, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
      await Bun.write(join(wt, "vendor/module/README.md"), "changed\n");
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
      try {
        await expect(cmdRm("feat/module", { deleteBranch: false, cwd: repo.dir })).rejects.toThrow();
      } finally {
        console.error = original;
      }
      expect(errors.join("\n")).toContain("vendor/module");
      expect(existsSync(join(wt, "vendor/module/.git"))).toBe(true);
    } finally {
      repo.rm();
      module.rm();
    }
  });
});
