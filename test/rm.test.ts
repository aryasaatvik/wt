import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  statSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cmdRm, resolveTarget } from "../src/rm.ts";
import { branchExists } from "../src/git.ts";
import { makeRepo, type FixtureRepo } from "./harness.ts";

/**
 * Alchemy's bootstrap-distilled.mjs topology: the primary's submodule owns the
 * shared child Git directory, and every lane checks the submodule out as a
 * detached linked worktree registered there.
 */
function addDistilled(repo: FixtureRepo, module: FixtureRepo) {
  repo.git(
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    module.dir,
    "submodules/distilled",
  );
  repo.commit("add submodule");
  repo.git("-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
  const main = join(repo.dir, "submodules/distilled");
  return {
    main,
    url: module.dir,
    commonDir: join(repo.dir, ".git/modules/submodules/distilled"),
    pin: repo.gitIn(main, "rev-parse", "HEAD").trim(),
  };
}

function addLinkedChild(
  repo: FixtureRepo,
  setup: ReturnType<typeof addDistilled>,
  lane: string,
  branch?: string,
): string {
  const checkout = join(lane, "submodules/distilled");
  const args = branch
    ? [checkout, branch]
    : ["--force", "--detach", "--no-checkout", checkout, setup.pin];
  if (branch) {
    repo.gitIn(setup.main, "branch", branch, setup.pin);
    repo.gitIn(setup.main, "worktree", "add", ...args);
  } else {
    repo.gitIn(setup.main, "worktree", "add", ...args);
  }
  repo.gitIn(lane, "submodule", "init");
  return checkout;
}

/** Admin directory of the lane's linked child worktree. */
function childAdmin(
  repo: FixtureRepo,
  setup: ReturnType<typeof addDistilled>,
  checkout: string,
): string {
  for (const name of readdirSync(join(setup.commonDir, "worktrees"))) {
    const admin = join(setup.commonDir, "worktrees", name);
    const gitfile = readFileSync(join(admin, "gitdir"), "utf8").trim();
    if (realpathSync.native(resolve(admin, dirname(gitfile))) === realpathSync.native(checkout))
      return admin;
  }
  throw new Error(`no child worktree admin for ${checkout}`);
}

/**
 * Enable per-worktree child config the way a distilled bootstrap does. The
 * shared `core.worktree` stays as git wrote it for the primary checkout; each
 * linked checkout gets its own path in its admin `config.worktree`.
 */
function enableChildWorktreeConfig(
  repo: FixtureRepo,
  setup: ReturnType<typeof addDistilled>,
): void {
  repo.git(
    "config",
    "--file",
    join(setup.commonDir, "config"),
    "extensions.worktreeConfig",
    "true",
  );
  for (const name of readdirSync(join(setup.commonDir, "worktrees"))) {
    const admin = join(setup.commonDir, "worktrees", name);
    const gitfile = readFileSync(join(admin, "gitdir"), "utf8").trim();
    repo.git(
      "config",
      "--file",
      join(admin, "config.worktree"),
      "core.worktree",
      resolve(admin, dirname(gitfile)),
    );
  }
}

/**
 * The lane checkout is a linked worktree of the child Git directory the
 * primary's submodule owns, and the child's natural `core.worktree` (a
 * relative path back to the primary checkout) stays in the shared config.
 * This is the topology `git submodule update` produced for the primary.
 */
function nestedLane(repo: FixtureRepo, setup: ReturnType<typeof addDistilled>, slug: string) {
  const lane = repo.addWorktree(slug, { branch: `feat/${slug}` });
  const checkout = addLinkedChild(repo, setup, lane);
  return { lane, checkout };
}

function childRegistrations(repo: FixtureRepo, commonDir: string): string {
  return repo.gitIn(commonDir, "worktree", "list", "--porcelain");
}

/**
 * Lane-private child Git data under the lane's own admin `modules`, with the
 * lane checkout registered as a linked worktree of it. Removal must move this
 * data aside, so a rollback has to put it back before re-adding the checkout.
 */
function lanePrivateChild(
  repo: FixtureRepo,
  setup: ReturnType<typeof addDistilled>,
  lane: string,
): { checkout: string; commonDir: string } {
  const laneGit = repo.gitIn(lane, "rev-parse", "--absolute-git-dir").trim();
  const commonDir = join(laneGit, "modules/submodules/distilled");
  const checkout = join(lane, "submodules/distilled");
  repo.gitIn(lane, "submodule", "init");
  repo.git("clone", setup.url, commonDir);
  repo.gitIn(commonDir, "worktree", "add", "--detach", checkout, setup.pin);
  repo.gitIn(checkout, "reset", "--hard");
  return { checkout, commonDir };
}

/** Check the primary submodule checkout is usable and clean at its recorded commit. */
function expectPrimaryChildHealthy(
  repo: FixtureRepo,
  setup: ReturnType<typeof addDistilled>,
): void {
  expect(repo.gitIn(setup.main, "rev-parse", "--show-toplevel").trim()).toBe(setup.main);
  expect(repo.gitIn(setup.main, "rev-parse", "HEAD").trim()).toBe(setup.pin);
  expect(repo.gitIn(setup.main, "symbolic-ref", "--short", "HEAD").trim()).toBe("main");
  expect(repo.gitIn(setup.main, "status", "--porcelain")).toBe("");
}

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
      expect(errors.join("\n")).toContain(
        "Run wt rm from the primary checkout or another worktree",
      );
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
      repo.gitIn(
        wt,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "update",
        "--init",
        "--recursive",
      );
      await cmdRm("feat/module", { deleteBranch: false, cwd: repo.dir });
      expect(existsSync(wt)).toBe(false);
      expect(repo.git("worktree", "list", "--porcelain")).not.toContain(wt);
      const archives = readdirSync(join(repo.dir, ".git")).filter((name) =>
        name.startsWith("wt-submodules-"),
      );
      expect(archives).toHaveLength(1);
      expect(existsSync(join(repo.dir, ".git", archives[0]!, "modules/vendor/module/HEAD"))).toBe(
        true,
      );
      // deinit in the lane must not unregister the primary's submodule
      expect(repo.git("config", "--get", "submodule.vendor/module.url").trim()).toBe(module.dir);
      expect(repo.git("submodule", "status").trim().startsWith("-")).toBe(false);
    } finally {
      repo.rm();
      module.rm();
    }
  });

  test("removes an empty uninitialized gitlink without a .gitmodules mapping", async () => {
    const repo = makeRepo();
    try {
      const head = repo.git("rev-parse", "HEAD").trim();
      repo.git("update-index", "--add", "--cacheinfo", `160000,${head},vendor/module`);
      repo.git("commit", "-m", "add unmapped gitlink");
      const wt = repo.addWorktree("unmapped", { branch: "feat/unmapped" });
      expect(readdirSync(join(wt, "vendor/module"))).toEqual([]);
      await cmdRm("feat/unmapped", { deleteBranch: false, cwd: repo.dir });
      expect(existsSync(wt)).toBe(false);
      expect(branchExists(repo.dir, "feat/unmapped")).toBe(true);
    } finally {
      repo.rm();
    }
  });

  test("preserves files inside an uninitialized gitlink without a mapping", async () => {
    const repo = makeRepo();
    try {
      const head = repo.git("rev-parse", "HEAD").trim();
      repo.git("update-index", "--add", "--cacheinfo", `160000,${head},vendor/module`);
      repo.git("commit", "-m", "add unmapped gitlink");
      const wt = repo.addWorktree("unmapped", { branch: "feat/unmapped" });
      const evidence = join(wt, "vendor/module/.local-evidence");
      await Bun.write(evidence, "keep\n");
      await expect(
        cmdRm("feat/unmapped", { deleteBranch: false, cwd: repo.dir }),
      ).rejects.toThrow();
      expect(await Bun.file(evidence).text()).toBe("keep\n");
      expect(branchExists(repo.dir, "feat/unmapped")).toBe(true);
    } finally {
      repo.rm();
    }
  });

  test("refuses a dirty submodule without deinitializing it", async () => {
    const module = makeRepo();
    const repo = makeRepo();
    try {
      repo.git("-c", "protocol.file.allow=always", "submodule", "add", module.dir, "vendor/module");
      repo.commit("add submodule");
      const wt = repo.addWorktree("with-module", { branch: "feat/module" });
      repo.gitIn(
        wt,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "update",
        "--init",
        "--recursive",
      );
      await Bun.write(join(wt, "vendor/module/untracked.txt"), "keep\n");
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
      try {
        await expect(
          cmdRm("feat/module", { deleteBranch: false, cwd: repo.dir }),
        ).rejects.toThrow();
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
      repo.gitIn(
        wt,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "update",
        "--init",
        "--recursive",
      );
      await Bun.write(join(wt, "vendor/module/README.md"), "changed\n");
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
      try {
        await expect(
          cmdRm("feat/module", { deleteBranch: false, cwd: repo.dir }),
        ).rejects.toThrow();
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

  test("removes a lane whose submodule is a nested linked worktree", async () => {
    const module = makeRepo();
    const repo = makeRepo();
    try {
      const setup = addDistilled(repo, module);
      const sharedConfig = readFileSync(join(setup.commonDir, "config"), "utf8");
      const target = nestedLane(repo, setup, "nested");
      const sibling = nestedLane(repo, setup, "sibling");
      repo.gitIn(target.checkout, "reset", "--hard");
      repo.gitIn(sibling.checkout, "reset", "--hard");

      await cmdRm("feat/nested", { deleteBranch: false, cwd: repo.dir });

      expect(existsSync(target.lane)).toBe(false);
      expect(repo.git("worktree", "list", "--porcelain")).not.toContain(target.lane);
      // The child's own shared Git directory must forget the lane exactly, but
      // keep the primary checkout and the sibling lane registered.
      const childList = childRegistrations(repo, setup.commonDir);
      expect(childList).toContain(sibling.checkout);
      expect(childList).not.toContain(target.checkout);
      expect(childList).not.toContain("prunable");
      expect(readdirSync(join(setup.commonDir, "worktrees"))).toHaveLength(1);
      expect(existsSync(sibling.lane)).toBe(true);
      expect(repo.gitIn(sibling.checkout, "status", "--porcelain")).toBe("");
      expect(repo.gitIn(sibling.checkout, "rev-parse", "--show-toplevel").trim()).toBe(
        sibling.checkout,
      );
      // The shared child config still names the primary checkout, so the
      // primary child repository keeps working after the lane is gone.
      expect(readFileSync(join(setup.commonDir, "config"), "utf8")).toBe(sharedConfig);
      expectPrimaryChildHealthy(repo, setup);
      expect(repo.git("config", "--get", "submodule.submodules/distilled.url").trim()).toBe(
        module.dir,
      );
      expect(repo.git("submodule", "status").trim().startsWith("-")).toBe(false);
      expect(branchExists(repo.dir, "feat/sibling")).toBe(true);
    } finally {
      repo.rm();
      module.rm();
    }
  });

  test("refuses ignored content in a nested linked submodule and preserves it", async () => {
    const module = makeRepo();
    module.write(".gitignore", "*.log\n");
    module.commit("ignore logs");
    const repo = makeRepo();
    try {
      const setup = addDistilled(repo, module);
      const target = nestedLane(repo, setup, "nested");
      const sibling = nestedLane(repo, setup, "sibling");
      repo.gitIn(target.checkout, "reset", "--hard");
      repo.gitIn(sibling.checkout, "reset", "--hard");
      await Bun.write(join(target.checkout, "build.log"), "ignored\n");

      await expect(cmdRm("feat/nested", { deleteBranch: false, cwd: repo.dir })).rejects.toThrow();

      expect(existsSync(target.lane)).toBe(true);
      const childList = childRegistrations(repo, setup.commonDir);
      expect(childList).toContain(target.checkout);
      expect(childList).toContain(sibling.checkout);
      expect(existsSync(join(target.checkout, "build.log"))).toBe(true);
    } finally {
      repo.rm();
      module.rm();
    }
  });

  test("restores a nested linked submodule when the parent removal fails", async () => {
    const module = makeRepo();
    const repo = makeRepo();
    try {
      const setup = addDistilled(repo, module);
      const target = nestedLane(repo, setup, "nested");
      const sibling = nestedLane(repo, setup, "sibling");
      repo.gitIn(target.checkout, "reset", "--hard");
      repo.gitIn(sibling.checkout, "reset", "--hard");
      // A non-core per-worktree setting must survive the lift and rollback.
      enableChildWorktreeConfig(repo, setup);
      const admin = childAdmin(repo, setup, target.checkout);
      repo.git("config", "--file", join(admin, "config.worktree"), "wt.marker", "keep");
      chmodSync(join(admin, "config.worktree"), 0o600);
      const adminConfig = readFileSync(join(admin, "config.worktree"), "utf8");
      const sharedConfig = readFileSync(join(setup.commonDir, "config"), "utf8");
      expect(repo.gitIn(target.checkout, "rev-parse", "--show-toplevel").trim()).toBe(
        target.checkout,
      );
      repo.git("worktree", "lock", target.lane);

      await expect(cmdRm("feat/nested", { deleteBranch: false, cwd: repo.dir })).rejects.toThrow();

      expect(existsSync(target.lane)).toBe(true);
      expect(
        statSync(join(childAdmin(repo, setup, target.checkout), "config.worktree")).mode & 0o777,
      ).toBe(0o600);
      const childList = childRegistrations(repo, setup.commonDir);
      expect(childList).toContain(target.checkout);
      expect(childList).toContain(sibling.checkout);
      expect(repo.gitIn(target.checkout, "rev-parse", "--show-toplevel").trim()).toBe(
        target.checkout,
      );
      expect(repo.gitIn(target.checkout, "rev-parse", "HEAD").trim()).toBe(setup.pin);
      expect(repo.gitIn(target.checkout, "status", "--porcelain")).toBe("");
      expect(existsSync(join(target.checkout, "README.md"))).toBe(true);
      expect(
        readFileSync(join(childAdmin(repo, setup, target.checkout), "config.worktree"), "utf8"),
      ).toBe(adminConfig);
      // The lift must not rewrite the shared child config that names the
      // primary checkout, or the primary child repository stops working.
      expect(readFileSync(join(setup.commonDir, "config"), "utf8")).toBe(sharedConfig);
      expectPrimaryChildHealthy(repo, setup);
      expect(repo.gitIn(sibling.checkout, "status", "--porcelain")).toBe("");
      expect(existsSync(sibling.lane)).toBe(true);

      // The sibling still removes cleanly afterwards.
      await cmdRm("feat/sibling", { deleteBranch: false, cwd: repo.dir });
      expect(existsSync(sibling.lane)).toBe(false);
      expectPrimaryChildHealthy(repo, setup);
      expect(childRegistrations(repo, setup.commonDir)).not.toContain(sibling.checkout);
    } finally {
      repo.rm();
      module.rm();
    }
  });

  test("restores a branch-mode nested linked submodule on rollback", async () => {
    const module = makeRepo();
    const repo = makeRepo();
    try {
      const setup = addDistilled(repo, module);
      const lane = repo.addWorktree("nested", { branch: "feat/nested" });
      const checkout = addLinkedChild(repo, setup, lane, "child/lane");
      const target = { lane, checkout };
      repo.gitIn(target.checkout, "reset", "--hard");
      expect(repo.gitIn(target.checkout, "symbolic-ref", "--short", "HEAD").trim()).toBe(
        "child/lane",
      );
      repo.git("worktree", "lock", target.lane);

      await expect(cmdRm("feat/nested", { deleteBranch: false, cwd: repo.dir })).rejects.toThrow();

      expect(existsSync(target.lane)).toBe(true);
      expect(repo.gitIn(target.checkout, "symbolic-ref", "--short", "HEAD").trim()).toBe(
        "child/lane",
      );
      expect(repo.gitIn(target.checkout, "rev-parse", "HEAD").trim()).toBe(setup.pin);
      expect(repo.gitIn(target.checkout, "status", "--porcelain")).toBe("");
      expectPrimaryChildHealthy(repo, setup);
    } finally {
      repo.rm();
      module.rm();
    }
  });

  test("restores lane-private linked submodule Git data before re-adding it", async () => {
    const module = makeRepo();
    const repo = makeRepo();
    try {
      const setup = addDistilled(repo, module);
      const lane = repo.addWorktree("private", { branch: "feat/private" });
      const child = lanePrivateChild(repo, setup, lane);
      expect(childRegistrations(repo, child.commonDir)).toContain(child.checkout);
      repo.git("worktree", "lock", lane);

      await expect(cmdRm("feat/private", { deleteBranch: false, cwd: repo.dir })).rejects.toThrow();

      // The archived lane modules hold this checkout's common directory, so
      // they must be back before the worktree can be registered again.
      expect(existsSync(child.commonDir)).toBe(true);
      expect(existsSync(child.checkout)).toBe(true);
      expect(childRegistrations(repo, child.commonDir)).toContain(child.checkout);
      expect(repo.gitIn(child.checkout, "rev-parse", "--show-toplevel").trim()).toBe(
        child.checkout,
      );
      expect(repo.gitIn(child.checkout, "rev-parse", "HEAD").trim()).toBe(setup.pin);
      expect(repo.gitIn(child.checkout, "status", "--porcelain")).toBe("");
      expect(
        readdirSync(join(repo.dir, ".git")).filter((n) => n.startsWith("wt-submodules-")),
      ).toEqual([]);
      expectPrimaryChildHealthy(repo, setup);

      // A later successful removal retains the lane-private data as usual.
      repo.git("worktree", "unlock", lane);
      await cmdRm("feat/private", { deleteBranch: false, cwd: repo.dir });
      expect(existsSync(lane)).toBe(false);
      const archives = readdirSync(join(repo.dir, ".git")).filter((n) =>
        n.startsWith("wt-submodules-"),
      );
      expect(archives).toHaveLength(1);
      expect(
        existsSync(join(repo.dir, ".git", archives[0]!, "modules/submodules/distilled/.git/HEAD")),
      ).toBe(true);
      expectPrimaryChildHealthy(repo, setup);
    } finally {
      repo.rm();
      module.rm();
    }
  });

  test("rollback reinitializes ordinary submodules but not the lifted one", async () => {
    const module = makeRepo();
    const other = makeRepo();
    const repo = makeRepo();
    try {
      const setup = addDistilled(repo, module);
      repo.git("-c", "protocol.file.allow=always", "submodule", "add", other.dir, "vendor/other");
      repo.commit("add other submodule");
      const lane = repo.addWorktree("nested", { branch: "feat/nested" });
      repo.gitIn(
        lane,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "update",
        "--init",
        "vendor/other",
      );
      const checkout = addLinkedChild(repo, setup, lane);
      repo.gitIn(checkout, "reset", "--hard");
      repo.git("worktree", "lock", lane);

      await expect(cmdRm("feat/nested", { deleteBranch: false, cwd: repo.dir })).rejects.toThrow();

      expect(repo.gitIn(join(lane, "vendor/other"), "status", "--porcelain")).toBe("");
      expect(repo.gitIn(join(lane, "vendor/other"), "rev-parse", "HEAD").trim()).toBe(
        repo.gitIn(other.dir, "rev-parse", "HEAD").trim(),
      );
      expect(existsSync(join(lane, "vendor/other/README.md"))).toBe(true);
      expect(repo.gitIn(checkout, "rev-parse", "HEAD").trim()).toBe(setup.pin);
      expect(repo.gitIn(checkout, "status", "--porcelain")).toBe("");
      expectPrimaryChildHealthy(repo, setup);
    } finally {
      repo.rm();
      other.rm();
      module.rm();
    }
  });

  test("refuses a locked nested linked submodule worktree and preserves it", async () => {
    const module = makeRepo();
    const repo = makeRepo();
    try {
      const setup = addDistilled(repo, module);
      const target = nestedLane(repo, setup, "nested");
      repo.gitIn(target.checkout, "reset", "--hard");
      repo.gitIn(setup.commonDir, "worktree", "lock", target.checkout);

      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
      try {
        await expect(
          cmdRm("feat/nested", { deleteBranch: false, cwd: repo.dir }),
        ).rejects.toThrow();
      } finally {
        console.error = original;
      }

      expect(errors.join("\n")).toContain("locked");
      expect(existsSync(target.lane)).toBe(true);
      expect(childRegistrations(repo, setup.commonDir)).toContain(target.checkout);
      expect(existsSync(join(target.checkout, "README.md"))).toBe(true);
      expectPrimaryChildHealthy(repo, setup);
    } finally {
      repo.rm();
      module.rm();
    }
  });
  test("refuses a linked child inside an ordinary submodule before changing checkouts", async () => {
    const inner = makeRepo();
    const outer = makeRepo();
    const repo = makeRepo();
    try {
      addDistilled(outer, inner);
      repo.git("-c", "protocol.file.allow=always", "submodule", "add", outer.dir, "vendor/outer");
      repo.commit("add outer submodule");
      repo.git("-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
      const lane = repo.addWorktree("deep", { branch: "feat/deep" });
      repo.gitIn(
        lane,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "update",
        "--init",
        "vendor/outer",
      );
      const main = join(repo.dir, "vendor/outer/submodules/distilled");
      const setup = {
        main,
        url: inner.dir,
        pin: repo.gitIn(main, "rev-parse", "HEAD").trim(),
        commonDir: repo
          .gitIn(main, "rev-parse", "--path-format=absolute", "--git-common-dir")
          .trim(),
      };
      const checkout = addLinkedChild(repo, setup, join(lane, "vendor/outer"));
      repo.gitIn(checkout, "reset", "--hard");
      const before = childRegistrations(repo, setup.commonDir);
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
      try {
        await expect(cmdRm("feat/deep", { deleteBranch: false, cwd: repo.dir })).rejects.toThrow();
      } finally {
        console.error = original;
      }
      expect(errors.join("\n")).toContain("nested inside another submodule");
      expect(childRegistrations(repo, setup.commonDir)).toBe(before);
      expect(existsSync(join(lane, "vendor/outer/README.md"))).toBe(true);
      expect(repo.gitIn(checkout, "status", "--porcelain")).toBe("");
      expect(repo.gitIn(main, "status", "--porcelain")).toBe("");
    } finally {
      repo.rm();
      outer.rm();
      inner.rm();
    }
  });
});
