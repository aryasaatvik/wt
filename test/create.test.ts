import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { cmdNew, readProvenance } from "../src/create.ts";
import { defaultBase, resolvePrimaryRepo } from "../src/git.ts";
import { ExitError } from "../src/ui.ts";
import { clonefile, targetAttributes, runWithGitFailure } from "./clone-fixture.ts";
import { makeRepo } from "./harness.ts";

const OPTS = { verbose: false, install: false, extraFlags: [] };

describe("cmdNew", () => {
  test.if(process.platform === "darwin")(
    "checks out with Git when target attribute lookup is unavailable",
    async () => {
      const repo = makeRepo();
      try {
        const run = await runWithGitFailure(repo, "check-attr", "feat/old-git");
        expect(run.stderr.toString()).toBe("");
        expect(run.exitCode).toBe(0);
        const lane = join(repo.root, "repo-worktrees", "feat-old-git");
        expect(readProvenance(lane)?.checkout).toEqual({
          mode: "git",
          cloned: 0,
          rewritten: 0,
          reason: "could not inspect target Git attributes",
        });
        expect(repo.gitIn(lane, "status", "--porcelain")).toBe("");
        expect(await Bun.file(join(lane, "README.md")).text()).toBe("fixture\n");
      } finally {
        repo.rm();
      }
    },
  );

  test.if(targetAttributes && process.platform === "darwin" && !clonefile)(
    "lets Git populate tracked files on a volume without clone support",
    async () => {
      const repo = makeRepo();
      try {
        const lane = await cmdNew("feat/no-clonefile", "main", { ...OPTS, cwd: repo.dir });
        expect(readProvenance(lane)?.checkout).toMatchObject({
          mode: "clone",
          cloned: 0,
          rewritten: 1,
        });
        expect(repo.gitIn(lane, "status", "--porcelain")).toBe("");
        expect(await Bun.file(join(lane, "README.md")).text()).toBe("fixture\n");
      } finally {
        repo.rm();
      }
    },
  );

  test.if(targetAttributes && process.platform === "darwin")(
    "records and prints a recovery command after a tracked checkout failure",
    async () => {
      const repo = makeRepo();
      try {
        const run = await runWithGitFailure(repo, "diff-files", "feat/interrupted");
        expect(run.exitCode).toBe(1);
        const lane = join(repo.root, "repo-worktrees", "feat-interrupted");
        const marker = readProvenance(lane);
        expect(marker).toMatchObject({
          phase: "incomplete",
          failure: "git diff-files failed: fixture Git command unavailable",
        });
        const command = marker?.recoveryCommand;
        if (!command) throw new Error("missing checkout recovery command");
        expect(run.stderr.toString()).toContain(command);
        expect(existsSync(join(lane, ".scratchpad"))).toBe(false);
        repo.gitIn(lane, "update-index", "--force-remove", "--", "README.md");
        const recovery = Bun.spawnSync(["/bin/sh", "-c", command]);
        expect(recovery.stderr.toString()).toBe("");
        expect(recovery.success).toBe(true);
        expect(repo.gitIn(lane, "status", "--porcelain")).toBe("");
        expect(await Bun.file(join(lane, "README.md")).text()).toBe("fixture\n");
      } finally {
        repo.rm();
      }
    },
  );

  test.if(clonefile && targetAttributes)(
    "clones with an empty effective hooks directory and worktree config enabled",
    async () => {
      const repo = makeRepo();
      try {
        repo.git("config", "core.hooksPath", join(repo.dir, ".git", "hooks"));
        repo.git("config", "extensions.worktreeConfig", "true");
        repo.git("config", "hook.disabled-fixture.event", "post-checkout");
        repo.git("config", "hook.disabled-fixture.command", "exit 1");
        repo.git("config", "hook.disabled-fixture.enabled", "false");
        expect(existsSync(join(repo.dir, ".git", "config.worktree"))).toBe(false);
        const lane = await cmdNew("feat/no-hook", "main", { ...OPTS, cwd: repo.dir });
        expect(readProvenance(lane)?.checkout).toEqual({ mode: "clone", cloned: 1, rewritten: 0 });
        expect(repo.gitIn(lane, "status", "--porcelain")).toBe("");
      } finally {
        repo.rm();
      }
    },
  );

  test.if(process.platform === "darwin")(
    "lets Git discover and run its post-checkout hook once",
    async () => {
      const repo = makeRepo();
      try {
        const hooks = join(repo.dir, ".git", "custom-hooks");
        mkdirSync(hooks);
        const hook = join(hooks, "post-checkout");
        await Bun.write(hook, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" >> hook-call.txt\n');
        chmodSync(hook, 0o755);
        repo.git("config", "core.hooksPath", ".git/custom-hooks");
        const head = repo.git("rev-parse", "HEAD").trim();
        const opts = { ...OPTS, cwd: repo.dir };
        const native = await cmdNew("feat/hook", "main", opts);
        const run = await runWithGitFailure(repo, "hook", "feat/legacy-hook");
        expect(run.stderr.toString()).toBe("");
        expect(run.exitCode).toBe(0);
        const legacy = join(repo.root, "repo-worktrees", "feat-legacy-hook");
        for (const lane of [native, legacy]) {
          expect(readProvenance(lane)?.checkout).toEqual({
            mode: "git",
            cloned: 0,
            rewritten: 0,
            reason: "Git post-checkout hook",
          });
          expect(await Bun.file(join(lane, "hook-call.txt")).text()).toBe(
            `${lane}\n${"0".repeat(head.length)}\n${head}\n1\n`,
          );
        }
      } finally {
        repo.rm();
      }
    },
  );

  test.if(process.platform === "darwin")(
    "checks conditional config against the new lane's Git directory",
    async () => {
      const repo = makeRepo();
      try {
        const config = join(repo.root, "checkout.gitconfig");
        await Bun.write(config, "[core]\n  autocrlf = true\n");
        repo.git("config", "includeIf.gitdir:**/worktrees/*-converted.path", config);
        const converted = await cmdNew("feat/converted", "main", { ...OPTS, cwd: repo.dir });
        const head = repo.git("rev-parse", "HEAD").trim();
        const plain = repo.addWorktree("plain-converted", { detachAt: head });
        expect(readProvenance(converted)?.checkout).toEqual({
          mode: "git",
          cloned: 0,
          rewritten: 0,
          reason: "core.autocrlf conversion",
        });
        expect(await Bun.file(join(converted, "README.md")).text()).toBe("fixture\r\n");
        expect(await Bun.file(join(plain, "README.md")).text()).toBe("fixture\r\n");
        expect(repo.gitIn(converted, "ls-files", "-s")).toBe(repo.gitIn(plain, "ls-files", "-s"));

        const unaffected = await cmdNew("feat/eligible", "main", { ...OPTS, cwd: repo.dir });
        const checkout = readProvenance(unaffected)?.checkout;
        expect(checkout?.mode).toBe(targetAttributes ? "clone" : "git");
        if (clonefile && targetAttributes) expect(checkout?.cloned).toBe(1);
        expect(await Bun.file(join(unaffected, "README.md")).text()).toBe("fixture\n");
      } finally {
        repo.rm();
      }
    },
  );

  test.if(process.platform === "darwin")(
    "preserves sparse patterns inherited from the primary",
    async () => {
      const repo = makeRepo();
      try {
        repo.write("keep/file", "included\n");
        repo.write("omit/file", "excluded\n");
        const head = repo.commit("add directories");
        repo.git("sparse-checkout", "set", "keep");
        const lane = await cmdNew("feat/sparse", "main", { ...OPTS, cwd: repo.dir });
        const plain = repo.addWorktree("plain-sparse", { detachAt: head });
        expect(readProvenance(lane)?.checkout).toEqual({
          mode: "git",
          cloned: 0,
          rewritten: 0,
          reason: "sparse checkout",
        });
        expect(repo.gitIn(lane, "ls-files", "-v")).toBe(repo.gitIn(plain, "ls-files", "-v"));
        expect(existsSync(join(lane, "keep", "file"))).toBe(true);
        expect(existsSync(join(lane, "omit", "file"))).toBe(false);
        expect(repo.gitIn(lane, "status", "--porcelain")).toBe("");
      } finally {
        repo.rm();
      }
    },
  );

  test.if(clonefile && targetAttributes)(
    "clones files and lets Git fill paths blocked by a primary file or symlink",
    async () => {
      const repo = makeRepo();
      try {
        repo.git("checkout", "-b", "target");
        repo.write("file-to-dir/child", "target directory\n");
        repo.write("symlink-to-dir/child", "target without symlinks\n");
        repo.write("dir-to-file", "target file\n");
        const head = repo.commit("target files");
        repo.git("checkout", "main");
        repo.write("file-to-dir", "primary file\n");
        repo.write("dir-to-file/child", "primary directory\n");
        repo.write("outside/child", "must stay outside the lane\n");
        symlinkSync("outside", join(repo.dir, "symlink-to-dir"));

        const lane = await cmdNew("feat/clone", "target", { ...OPTS, cwd: repo.dir });
        const plain = repo.addWorktree("plain", { detachAt: head });
        expect(readProvenance(lane)).toMatchObject({
          phase: "ready",
          checkout: { mode: "clone", cloned: 1, rewritten: 3 },
        });
        expect(repo.gitIn(lane, "status", "--porcelain")).toBe("");
        expect(repo.gitIn(lane, "ls-files", "-s")).toBe(repo.gitIn(plain, "ls-files", "-s"));
        for (const path of [
          "README.md",
          "file-to-dir/child",
          "symlink-to-dir/child",
          "dir-to-file",
        ]) {
          expect(await Bun.file(join(lane, path)).text()).toBe(
            await Bun.file(join(plain, path)).text(),
          );
        }
        expect(existsSync(join(lane, "outside"))).toBe(false);
      } finally {
        repo.rm();
      }
    },
  );

  test.if(process.platform === "darwin")(
    "uses the standard checkout for target attributes",
    async () => {
      const repo = makeRepo();
      try {
        repo.git("checkout", "-b", "converted");
        repo.write(".gitattributes", "*.md eol=crlf\n");
        repo.commit("add checkout conversion");
        repo.git("checkout", "main");
        const lane = await cmdNew("feat/converted", "converted", { ...OPTS, cwd: repo.dir });
        expect(readProvenance(lane)?.checkout).toEqual({
          mode: "git",
          cloned: 0,
          rewritten: 0,
          reason: targetAttributes
            ? "Git checkout attribute: eol"
            : "could not inspect target Git attributes",
        });
        expect(await Bun.file(join(lane, "README.md")).text()).toBe("fixture\r\n");
      } finally {
        repo.rm();
      }
    },
  );

  test.if(process.platform === "darwin")(
    "uses the standard checkout for a target gitlink",
    async () => {
      const repo = makeRepo();
      try {
        const head = repo.git("rev-parse", "HEAD").trim();
        repo.git("update-index", "--add", "--cacheinfo", `160000,${head},module`);
        repo.git("commit", "-m", "add gitlink");
        const lane = await cmdNew("feat/gitlink", "main", { ...OPTS, cwd: repo.dir });
        expect(readProvenance(lane)?.checkout).toEqual({
          mode: "git",
          cloned: 0,
          rewritten: 0,
          reason: "target tree contains gitlinks",
        });
        expect(lstatSync(join(lane, "module")).isDirectory()).toBe(true);
        expect(repo.gitIn(lane, "status", "--porcelain")).toBe("");
      } finally {
        repo.rm();
      }
    },
  );

  test("honors an explicit --no-checkout using the standard Git path", async () => {
    const repo = makeRepo();
    try {
      const lane = await cmdNew("feat/no-checkout", "main", {
        ...OPTS,
        cwd: repo.dir,
        extraFlags: ["--no-checkout"],
      });
      expect(readProvenance(lane)?.checkout?.mode).toBe("git");
      expect(existsSync(join(lane, "README.md"))).toBe(false);
      expect(repo.gitIn(lane, "ls-files")).toBe("");
    } finally {
      repo.rm();
    }
  });

  test.if(process.platform === "darwin")("honors the user-config clone opt-out", async () => {
    const repo = makeRepo();
    const previous = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = join(repo.root, "config");
      const configDir = join(process.env.XDG_CONFIG_HOME, "wt");
      mkdirSync(configDir, { recursive: true });
      await Bun.write(join(configDir, "config.toml"), "[create]\nclone = false\n");
      const lane = await cmdNew("feat/opt-out", "main", { ...OPTS, cwd: repo.dir });
      expect(readProvenance(lane)?.checkout).toEqual({
        mode: "git",
        cloned: 0,
        rewritten: 0,
        reason: "disabled by create.clone in user config",
      });
      expect(await Bun.file(join(lane, "README.md")).text()).toBe("fixture\n");
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
      repo.rm();
    }
  });

  test.if(process.platform !== "darwin")("uses the standard checkout outside macOS", async () => {
    const repo = makeRepo();
    try {
      const lane = await cmdNew("feat/plain", "main", { ...OPTS, cwd: repo.dir });
      expect(readProvenance(lane)?.checkout).toEqual({
        mode: "git",
        cloned: 0,
        rewritten: 0,
        reason: "APFS cloning requires macOS",
      });
      expect(await Bun.file(join(lane, "README.md")).text()).toBe("fixture\n");
      expect(repo.gitIn(lane, "status", "--porcelain")).toBe("");
    } finally {
      repo.rm();
    }
  });

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

  test("restores a fast-forwarded branch when the destination already contains files", async () => {
    const repo = makeRepo();
    try {
      repo.git("branch", "fix/stale");
      const head = repo.git("rev-parse", "fix/stale").trim();
      repo.git("commit", "--allow-empty", "-m", "advance main");
      const destination = join(repo.root, "repo-worktrees", "fix-stale");
      mkdirSync(destination, { recursive: true });
      await Bun.write(join(destination, "keep.txt"), "existing data\n");
      await expect(cmdNew("fix/stale", "main", { ...OPTS, cwd: repo.dir })).rejects.toThrow();
      expect(repo.git("rev-parse", "fix/stale").trim()).toBe(head);
      expect(await Bun.file(join(destination, "keep.txt")).text()).toBe("existing data\n");
      expect(repo.git("worktree", "list", "--porcelain")).not.toContain(destination);
    } finally {
      repo.rm();
    }
  });

  test("restores a fast-forwarded branch when another branch's lane occupies the destination", async () => {
    const repo = makeRepo();
    try {
      repo.git("branch", "feat/foo");
      const head = repo.git("rev-parse", "feat/foo").trim();
      repo.git("commit", "--allow-empty", "-m", "advance main");
      const destination = join(repo.root, "repo-worktrees", "feat-foo");
      repo.git("worktree", "add", "-b", "feat-foo", destination, "main");
      await expect(cmdNew("feat/foo", "main", { ...OPTS, cwd: repo.dir })).rejects.toThrow();
      expect(repo.git("rev-parse", "feat/foo").trim()).toBe(head);
      expect(repo.gitIn(destination, "branch", "--show-current").trim()).toBe("feat-foo");
    } finally {
      repo.rm();
    }
  });

  test("keeps a fast-forwarded branch when a failing hook leaves the lane registered", async () => {
    const repo = makeRepo();
    const warning = spyOn(console, "error").mockImplementation(() => {});
    try {
      repo.git("branch", "fix/stale");
      repo.write("base.txt", "new base content\n");
      const baseHead = repo.commit("advance main");
      const hooks = join(repo.root, "hooks");
      mkdirSync(hooks);
      const hook = join(hooks, "post-checkout");
      await Bun.write(hook, "#!/bin/sh\nexit 1\n");
      chmodSync(hook, 0o755);
      repo.git("config", "core.hooksPath", hooks);
      const destination = join(repo.root, "repo-worktrees", "fix-stale");
      await expect(cmdNew("fix/stale", "main", { ...OPTS, cwd: repo.dir })).rejects.toThrow();
      expect(repo.git("rev-parse", "fix/stale").trim()).toBe(baseHead);
      expect(repo.gitIn(destination, "rev-parse", "HEAD").trim()).toBe(baseHead);
      expect(repo.git("worktree", "list", "--porcelain")).toContain(destination);
      expect(repo.gitIn(destination, "status", "--porcelain").trim()).toBe("");
      expect(await Bun.file(join(destination, "base.txt")).text()).toBe("new base content\n");
      expect(warning).toHaveBeenCalledWith(
        `  ✗ Worktree exists at ${destination}, but setup did not complete; keeping fix/stale unchanged`,
      );
    } finally {
      warning.mockRestore();
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
    const warning = spyOn(console, "error").mockImplementation(() => {});
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
      expect(warning).toHaveBeenCalledWith(
        "  ! Reusing topic unchanged: 1 commit behind main with 1 unique commit (squash-merged? delete the branch to start from main)",
      );
      expect(readProvenance(wtDir)?.source).toEqual({
        kind: "local",
        ref: "refs/heads/topic",
        head: localHead,
      });
    } finally {
      warning.mockRestore();
      repo.rm();
    }
  });

  test("reuses an ahead-only local branch without a divergence warning", async () => {
    const repo = makeRepo();
    const warning = spyOn(console, "error").mockImplementation(() => {});
    try {
      repo.git("checkout", "-b", "topic");
      repo.write("local.txt", "local\n");
      const localHead = repo.commit("local topic");
      repo.git("checkout", "main");
      const wtDir = await cmdNew("topic", "main", { ...OPTS, cwd: repo.dir });
      expect(repo.gitIn(wtDir, "rev-parse", "HEAD").trim()).toBe(localHead);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
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
