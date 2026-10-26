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
        join(
          repo.dir,
          "runs/local/billing-refund-permanent-ses-rejection-releases-the-reserved-autumn-unit",
        ),
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
      expect(() =>
        lstatSync(
          join(
            wtDir,
            "runs/local/billing-refund-permanent-ses-rejection-releases-the-reserved-autumn-unit",
          ),
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

  test("reuses an existing branch equal to the supplied base", async () => {
    const repo = makeRepo();
    try {
      repo.git("branch", "feat/existing");
      const head = repo.git("rev-parse", "main").trim();
      const wtDir = await cmdNew("feat/existing", "main", { ...OPTS, cwd: repo.dir });
      expect(repo.gitIn(wtDir, "branch", "--show-current").trim()).toBe("feat/existing");
      expect(repo.gitIn(wtDir, "rev-parse", "HEAD").trim()).toBe(head);
      expect(readProvenance(wtDir)?.base).toBeNull();
    } finally {
      repo.rm();
    }
  });

  test("fast-forwards a merged local branch to an advanced explicit base", async () => {
    const repo = makeRepo();
    try {
      repo.git("checkout", "-b", "fix/merged");
      repo.write("fix.txt", "fixed\n");
      repo.commit("fix");
      repo.git("checkout", "main");
      repo.git("merge", "--ff-only", "fix/merged");
      repo.git("commit", "--allow-empty", "-m", "advance one");
      repo.git("commit", "--allow-empty", "-m", "advance two");
      const head = repo.git("rev-parse", "main").trim();
      const wtDir = await cmdNew("fix/merged", "main", { ...OPTS, cwd: repo.dir });
      expect(repo.gitIn(wtDir, "rev-parse", "HEAD").trim()).toBe(head);
      expect(repo.git("rev-parse", "fix/merged").trim()).toBe(head);
      expect(readProvenance(wtDir)?.source?.head).toBe(head);
    } finally {
      repo.rm();
    }
  });

  test("leaves a stale local branch unchanged without an explicit base", async () => {
    const repo = makeRepo();
    try {
      repo.git("branch", "stale");
      const head = repo.git("rev-parse", "stale").trim();
      repo.git("commit", "--allow-empty", "-m", "advance main");
      const wtDir = await cmdNew("stale", undefined, { ...OPTS, cwd: repo.dir });
      expect(repo.gitIn(wtDir, "rev-parse", "HEAD").trim()).toBe(head);
    } finally {
      repo.rm();
    }
  });

  test("does not move a stale branch already checked out in a worktree", async () => {
    const repo = makeRepo();
    try {
      const lane = repo.addWorktree("in-use", { branch: "in-use" });
      const head = repo.git("rev-parse", "in-use").trim();
      repo.git("commit", "--allow-empty", "-m", "advance main");
      await expect(cmdNew("in-use", "main", { ...OPTS, cwd: repo.dir })).rejects.toThrow(
        "already checked out",
      );
      expect(repo.gitIn(lane, "rev-parse", "HEAD").trim()).toBe(head);
    } finally {
      repo.rm();
    }
  });

  test("prefers a divergent local branch over origin and the supplied base", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      repo.git("branch", "topic");
      repo.git("push", "origin", "topic");
      repo.git("checkout", "topic");
      repo.write("local.txt", "local\n");
      const localHead = repo.commit("local topic");
      repo.git("checkout", "main");
      repo.write("main.txt", "main\n");
      repo.commit("advance main");
      const wtDir = await cmdNew("topic", "main", { ...OPTS, cwd: repo.dir });
      expect(repo.gitIn(wtDir, "rev-parse", "HEAD").trim()).toBe(localHead);
      expect(readProvenance(wtDir)?.source).toEqual({
        kind: "local",
        ref: "refs/heads/topic",
        head: localHead,
      });
    } finally {
      repo.rm();
    }
  });

  test("uses the same-name origin branch before a supplied base and runs setup at its SHA", async () => {
    const repo = makeRepo();
    try {
      repo.write("package.json", '{"packageManager":"bun@1.4.0"}\n');
      repo.write("wt.toml", '[create]\npostInstall = "git rev-parse HEAD > setup-head.txt"\n');
      const baseHead = repo.commit("setup config");
      repo.addOrigin();
      repo.write("remote.txt", "remote\n");
      const remoteHead = repo.commit("remote topic");
      repo.git("update-ref", "refs/remotes/origin/topic", remoteHead);
      repo.git("reset", "--hard", baseHead);
      const wtDir = await cmdNew("topic", "main", {
        ...OPTS,
        cwd: repo.dir,
        install: true,
        installRunner: async () => 0,
      });
      expect(repo.gitIn(wtDir, "rev-parse", "HEAD").trim()).toBe(remoteHead);
      expect(await Bun.file(join(wtDir, "setup-head.txt")).text()).toBe(`${remoteHead}\n`);
      expect(repo.git("for-each-ref", "--format=%(upstream)", "refs/heads/topic").trim()).toBe("");
      expect(readProvenance(wtDir)?.source).toEqual({
        kind: "origin",
        ref: "refs/remotes/origin/topic",
        head: remoteHead,
      });
      expect(readProvenance(wtDir)?.base).toBe("refs/remotes/origin/topic");
    } finally {
      repo.rm();
    }
  });

  test("honors explicit tracking flags for same-name origin branches", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      for (const [branch, flags, upstream] of [
        ["track", ["--track"], "refs/remotes/origin/track"],
        ["short-track", ["-t"], "refs/remotes/origin/short-track"],
        ["no-track", ["--no-track"], ""],
      ] as const) {
        repo.git("update-ref", `refs/remotes/origin/${branch}`, "HEAD");
        await cmdNew(branch, "missing-base", { ...OPTS, cwd: repo.dir, extraFlags: [...flags] });
        expect(
          repo.git("for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`).trim(),
        ).toBe(upstream);
      }
    } finally {
      repo.rm();
    }
  });

  test("new branches do not track a remote base unless tracking is requested", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      repo.git("branch", "topic");
      repo.git("push", "origin", "topic");
      const upstream = (branch: string) =>
        repo.git("for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`).trim();

      await cmdNew("feat/no-upstream", "origin/topic", { ...OPTS, cwd: repo.dir });
      expect(upstream("feat/no-upstream")).toBe("");

      await cmdNew("feat/track", "origin/topic", {
        ...OPTS,
        cwd: repo.dir,
        extraFlags: ["--track"],
      });
      expect(upstream("feat/track")).toBe("refs/remotes/origin/topic");

      await cmdNew("feat/short-track", "origin/topic", {
        ...OPTS,
        cwd: repo.dir,
        extraFlags: ["-t"],
      });
      expect(upstream("feat/short-track")).toBe("refs/remotes/origin/topic");

      await cmdNew("feat/explicit-no-track", "origin/topic", {
        ...OPTS,
        cwd: repo.dir,
        extraFlags: ["--no-track"],
      });
      expect(upstream("feat/explicit-no-track")).toBe("");

      repo.git("branch", "feat/existing-upstream", "main");
      repo.git("branch", "--set-upstream-to=origin/main", "feat/existing-upstream");
      await cmdNew("feat/existing-upstream", "origin/topic", { ...OPTS, cwd: repo.dir });
      expect(upstream("feat/existing-upstream")).toBe("refs/remotes/origin/main");
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
      expect(existsSync(join(wtDir, ".scratchpad/STATE.md"))).toBe(true);
      expect(lstatSync(join(wtDir, ".scratchpad")).isSymbolicLink()).toBe(true);
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

  test("runs the wt.toml post-install command in the worktree and records it", async () => {
    const repo = makeRepo();
    try {
      repo.write("package.json", '{"packageManager":"bun@1.4.0"}\n');
      repo.write("wt.toml", '[create]\npostInstall = "printf ran > post-install.txt"\n');
      repo.commit("post-install config");

      const wtDir = await cmdNew("feat/post-install", "main", {
        ...OPTS,
        cwd: repo.dir,
        install: true,
        installRunner: async () => 0,
      });

      expect(existsSync(join(wtDir, "post-install.txt"))).toBe(true);
      const marker = readProvenance(wtDir);
      expect(marker?.phase).toBe("ready");
      expect(marker?.postInstall).toEqual({ command: "printf ran > post-install.txt" });
    } finally {
      repo.rm();
    }
  });

  test("skips the configured post-install command when disabled", async () => {
    const repo = makeRepo();
    try {
      repo.write("package.json", '{"packageManager":"bun@1.4.0"}\n');
      repo.write("wt.toml", '[create]\npostInstall = "printf ran > post-install.txt"\n');
      repo.commit("post-install config");

      const wtDir = await cmdNew("feat/post-install-skip", "main", {
        ...OPTS,
        cwd: repo.dir,
        install: true,
        installRunner: async () => 0,
        postInstall: false,
      });

      expect(existsSync(join(wtDir, "post-install.txt"))).toBe(false);
      expect(readProvenance(wtDir)?.postInstall).toBeUndefined();
      expect(readProvenance(wtDir)?.phase).toBe("ready");
    } finally {
      repo.rm();
    }
  });

  test("keeps an incomplete worktree and fails when post-install fails", async () => {
    const repo = makeRepo();
    try {
      repo.write("package.json", '{"packageManager":"bun@1.4.0"}\n');
      repo.write("wt.toml", '[create]\npostInstall = "exit 7"\n');
      repo.commit("post-install config");

      let failure: unknown;
      try {
        await cmdNew("feat/post-install-fail", "main", {
          ...OPTS,
          cwd: repo.dir,
          install: true,
          installRunner: async () => 0,
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(ExitError);
      expect((failure as ExitError).code).toBe(7);
      const wtDir = join(repo.root, "repo-worktrees", "feat-post-install-fail");
      expect(readProvenance(wtDir)).toEqual(
        expect.objectContaining({
          phase: "incomplete",
          failure: "post-install exited 7",
          recoveryCommand: `cd '${wtDir}' && exit 7`,
        }),
      );
    } finally {
      repo.rm();
    }
  });

  test("rejects a malformed wt.toml before creating the worktree", async () => {
    const repo = makeRepo();
    try {
      repo.write("wt.toml", "[create]\npostInstall = 123\n");
      repo.commit("bad config");

      let failure: unknown;
      try {
        await cmdNew("feat/bad-config", "main", { ...OPTS, cwd: repo.dir });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(ExitError);
      expect((failure as ExitError).code).toBe(1);
      expect(existsSync(join(repo.root, "repo-worktrees", "feat-bad-config"))).toBe(false);
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
      try {
        await run;
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ExitError);
      expect((failure as ExitError).code).toBe(23);
      const wtDir = join(repo.root, "repo-worktrees", "feat-install-fails");
      expect(installedIn).toBe(wtDir);
      expect(existsSync(wtDir)).toBe(true);
      expect(readProvenance(wtDir)).toEqual(
        expect.objectContaining({
          phase: "incomplete",
          failure: "dependency install exited 23",
          recoveryCommand: `cd '${wtDir}' && ni`,
        }),
      );
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
          installRunner: async () => {
            throw new Error("spawn EACCES");
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ExitError);
      const wtDir = join(repo.root, "repo-worktrees", "feat-install-throws");
      expect(readProvenance(wtDir)).toEqual(
        expect.objectContaining({
          phase: "incomplete",
          failure: "dependency install failed: spawn EACCES",
          recoveryCommand: `cd '${wtDir}' && ni`,
        }),
      );
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
      repo.git("branch", "origin/trunk", "main");
      expect(defaultBase(repo.dir)).toBe("refs/remotes/origin/trunk");
    } finally {
      repo.rm();
    }
  });

  test("ignores a stale origin/HEAD symbolic ref", () => {
    const repo = makeRepo();
    try {
      repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing");
      repo.git("branch", "origin/missing");
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
  test("uses the embedded primary config.worktree rather than a linked lane's config", async () => {
    const superproject = makeRepo();
    const submodule = makeRepo();
    try {
      submodule.write("package.json", '{"packageManager":"bun@1.4.0"}\n');
      submodule.write("wt.toml", '[create]\npostInstall = "git rev-parse HEAD > setup-head.txt"\n');
      const setupHead = submodule.commit("setup config");
      superproject.git(
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        submodule.dir,
        "modules/child",
      );
      const checkout = join(superproject.dir, "modules", "child");
      const common = superproject.gitIn(checkout, "rev-parse", "--absolute-git-dir").trim();
      superproject.gitIn(checkout, "config", "extensions.worktreeConfig", "true");
      superproject.gitIn(
        checkout,
        "config",
        "--file",
        join(common, "config.worktree"),
        "core.worktree",
        checkout,
      );
      superproject.gitIn(
        checkout,
        "config",
        "--file",
        join(common, "config"),
        "--unset",
        "core.worktree",
      );
      const lane = join(superproject.root, "existing-lane");
      superproject.gitIn(checkout, "worktree", "add", "-b", "existing-lane", lane);
      superproject.gitIn(lane, "config", "--worktree", "core.worktree", lane);
      mkdirSync(join(lane, "nested"));
      expect(resolvePrimaryRepo(checkout)).toBe(checkout);
      expect(resolvePrimaryRepo(join(lane, "nested"))).toBe(checkout);
      superproject.gitIn(checkout, "update-ref", "refs/remotes/origin/feat/embedded", setupHead);
      const created = await cmdNew("feat/embedded", "missing-base", {
        ...OPTS,
        cwd: join(lane, "nested"),
        install: true,
        installRunner: async () => 0,
      });
      expect(created).toBe(join(superproject.dir, "modules", "child-worktrees", "feat-embedded"));
      expect(superproject.gitIn(created, "branch", "--show-current").trim()).toBe("feat/embedded");
      expect(await Bun.file(join(created, "setup-head.txt")).text()).toBe(`${setupHead}\n`);
    } finally {
      superproject.rm();
      submodule.rm();
    }
  });

  test("refuses missing or foreign primary checkout identity", () => {
    const superproject = makeRepo();
    const submodule = makeRepo();
    try {
      superproject.git(
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        submodule.dir,
        "modules/child",
      );
      const checkout = join(superproject.dir, "modules", "child");
      const common = superproject.gitIn(checkout, "rev-parse", "--absolute-git-dir").trim();
      const lane = join(superproject.root, "existing-lane");
      superproject.gitIn(checkout, "worktree", "add", "-b", "existing-lane", lane);
      superproject.gitIn(
        checkout,
        "config",
        "--file",
        join(common, "config"),
        "core.worktree",
        join(superproject.root, "missing"),
      );
      expect(() => resolvePrimaryRepo(lane)).toThrow();
      superproject.gitIn(
        lane,
        "config",
        "--file",
        join(common, "config"),
        "core.worktree",
        submodule.dir,
      );
      expect(() => resolvePrimaryRepo(lane)).toThrow("primary");
    } finally {
      superproject.rm();
      submodule.rm();
    }
  });

  test("resolves an initialized local submodule to its checkout", async () => {
    const superproject = makeRepo();
    const submodule = makeRepo();
    try {
      superproject.git(
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        submodule.dir,
        "modules/child",
      );
      const checkout = join(superproject.dir, "modules", "child");
      mkdirSync(join(checkout, "nested"));
      expect(resolvePrimaryRepo(checkout)).toBe(checkout);
      expect(resolvePrimaryRepo(join(checkout, "nested"))).toBe(checkout);
      const lane = await cmdNew("feat/submodule", "main", { ...OPTS, cwd: checkout });
      expect(lane).toBe(join(superproject.dir, "modules", "child-worktrees", "feat-submodule"));
      expect(superproject.gitIn(lane, "branch", "--show-current").trim()).toBe("feat/submodule");
      expect(resolvePrimaryRepo(lane)).toBe(checkout);
    } finally {
      superproject.rm();
      submodule.rm();
    }
  });

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
