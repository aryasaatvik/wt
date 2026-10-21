import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cmdNew, readProvenance } from "../src/create.ts";
import { cmdRm } from "../src/rm.ts";
import { runSafetyPipeline } from "../src/safety.ts";
import { ensureSharedScratchpad, scratchpadState } from "../src/scratchpad.ts";
import { planSync, applySyncPlan } from "../src/sync.ts";
import { measureDiskUsage } from "../src/disk.ts";
import { makeRepo } from "./harness.ts";

test("new worktrees share writes, remain clean and remove without archiving canonical content", async () => {
  const repo = makeRepo();
  try {
    repo.write(".gitignore", ".scratchpad/\n");
    repo.commit("ignore local notes");
    repo.write(".scratchpad/note.md", "primary\n");
    const opts = { cwd: repo.dir, verbose: false, install: false, extraFlags: [] };
    const first = await cmdNew("first", "main", opts);
    const second = await cmdNew("second", "main", opts);
    expect(lstatSync(join(first, ".scratchpad")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(first, ".scratchpad"))).toBe(join(repo.dir, ".scratchpad"));
    writeFileSync(join(first, ".scratchpad/note.md"), "shared update\n");
    expect(readFileSync(join(second, ".scratchpad/note.md"), "utf8")).toBe("shared update\n");
    // Even a cyclic link in shared history is irrelevant to removal.
    symlinkSync(".", join(repo.dir, ".scratchpad/cycle"));
    expect((await runSafetyPipeline(first, repo.dir)).ok).toBe(true);
    expect(repo.gitIn(first, "status", "--porcelain")).toBe("");
    await cmdRm("first", { cwd: repo.dir, deleteBranch: false });
    expect(existsSync(first)).toBe(false);
    expect(readFileSync(join(second, ".scratchpad/note.md"), "utf8")).toBe("shared update\n");
    expect(existsSync(join(repo.dir, ".scratchpad/archive"))).toBe(false);
    expect(repo.git("branch", "--list", "first")).toContain("first");
  } finally {
    repo.rm();
  }
});

test("sync excludes Scratchpad even when explicitly selected and forced", async () => {
  const repo = makeRepo();
  try {
    repo.write(".gitignore", ".scratchpad/\n");
    repo.write(".worktreeinclude", ".scratchpad/\n");
    repo.commit("manifest");
    repo.write(".scratchpad/note.md", "canonical");
    const lane = repo.addWorktree("lane");
    await ensureSharedScratchpad(repo.dir, lane);
    const plan = await planSync(repo.dir, lane, { force: true });
    expect(plan.actions).toEqual([]);
    expect(await applySyncPlan(plan)).toEqual([]);
    expect(lstatSync(join(lane, ".scratchpad")).isSymbolicLink()).toBe(true);
  } finally {
    repo.rm();
  }
});

test.each(["legacy", "manifest"])(
  "%s sync ignores nested evidence repositories beneath the shared Scratchpad link",
  async (mode) => {
    const repo = makeRepo();
    try {
      repo.write(".gitignore", ".scratchpad/\n.env\n.scratchpad-copy/\n");
      if (mode === "manifest") {
        repo.write(".worktreeinclude", "/.env\n/.scratchpad/\n/.scratchpad-copy/**\n");
      }
      repo.commit("sync policy");
      repo.write(".env", "FIXTURE=1\n");
      repo.write(".scratchpad/evidence/project/README.md", "retained evidence\n");
      repo.gitIn(join(repo.dir, ".scratchpad/evidence/project"), "init", "-b", "main");
      repo.write(".scratchpad-copy/README.md", "separate directory\n");
      const lane = repo.addWorktree("lane");
      await ensureSharedScratchpad(repo.dir, lane);

      const plan = await planSync(repo.dir, lane, {
        force: true,
        config: { requireInclude: false, exclude: [] },
      });
      expect(plan.mode).toBe(mode);
      expect(plan.actions.some(({ path }) => path.startsWith(".scratchpad/"))).toBe(false);
      expect(await applySyncPlan(plan)).toEqual(
        mode === "manifest" ? [".env", ".scratchpad-copy/README.md"] : [".env"],
      );
      expect(readFileSync(join(lane, ".env"), "utf8")).toBe("FIXTURE=1\n");
      expect(realpathSync(join(lane, ".scratchpad"))).toBe(join(repo.dir, ".scratchpad"));
      expect(readFileSync(join(lane, ".scratchpad/evidence/project/README.md"), "utf8")).toBe(
        "retained evidence\n",
      );
    } finally {
      repo.rm();
    }
  },
);

test.each(["legacy", "manifest"])(
  "%s creation reaches install and post-install with nested Scratchpad evidence repositories",
  async (mode) => {
    const repo = makeRepo();
    try {
      repo.write(".gitignore", ".scratchpad/\n.env\n");
      repo.write("package.json", '{"packageManager":"bun@1.4.3"}\n');
      repo.write("wt.toml", '[create]\npostInstall = "bun run build"\n');
      if (mode === "manifest") repo.write(".worktreeinclude", "/.env\n/.scratchpad/\n");
      repo.commit("creation policy");
      repo.write(".env", "FIXTURE=1\n");
      repo.write(".scratchpad/evidence/project/README.md", "retained evidence\n");
      repo.gitIn(join(repo.dir, ".scratchpad/evidence/project"), "init", "-b", "main");
      const phases: string[] = [];

      const lane = await cmdNew("lane", "main", {
        cwd: repo.dir,
        verbose: false,
        install: true,
        extraFlags: [],
        installRunner: async (path) => {
          expect(readFileSync(join(path, ".env"), "utf8")).toBe("FIXTURE=1\n");
          phases.push("install");
          return 0;
        },
        postInstallRunner: async (_path, command) => {
          expect(command).toBe("bun run build");
          phases.push("post-install");
          return 0;
        },
      });

      expect(phases).toEqual(["install", "post-install"]);
      expect(readProvenance(lane)?.phase).toBe("ready");
      expect(readProvenance(lane)?.syncedFiles).toEqual([".env"]);
      expect(realpathSync(join(lane, ".scratchpad"))).toBe(join(repo.dir, ".scratchpad"));
      expect(readFileSync(join(lane, ".scratchpad/evidence/project/README.md"), "utf8")).toBe(
        "retained evidence\n",
      );
    } finally {
      repo.rm();
    }
  },
);

test("a primary link to external storage supports creation, shared writes and safe removal", async () => {
  const repo = makeRepo();
  try {
    const storage = join(repo.root, "xdg-notes");
    mkdirSync(storage);
    symlinkSync(storage, join(repo.dir, ".scratchpad"));
    writeFileSync(join(storage, "note.md"), "canonical");
    const lane = await cmdNew("lane", "main", {
      cwd: repo.dir,
      verbose: false,
      install: false,
      extraFlags: [],
    });
    expect(scratchpadState(repo.dir, lane)).toEqual({ kind: "shared" });
    expect(realpathSync(join(lane, ".scratchpad"))).toBe(storage);
    writeFileSync(join(lane, ".scratchpad/note.md"), "shared update");
    expect(readFileSync(join(storage, "note.md"), "utf8")).toBe("shared update");
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(repo.gitIn(lane, "status", "--porcelain")).toBe("");
    await cmdRm("lane", { cwd: repo.dir, deleteBranch: false });
    expect(existsSync(lane)).toBe(false);
    expect(lstatSync(join(repo.dir, ".scratchpad")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(storage, "note.md"), "utf8")).toBe("shared update");
  } finally {
    repo.rm();
  }
});

test.each(["missing", "file", "cycle", "not-directory"])(
  "invalid primary link (%s) blocks setup and removal",
  async (target) => {
    const repo = makeRepo();
    try {
      repo.write("file", "not a directory");
      const destination =
        target === "cycle" ? ".scratchpad" : target === "not-directory" ? "file/notes" : target;
      symlinkSync(destination, join(repo.dir, ".scratchpad"));
      const lane = repo.addWorktree("lane");
      expect(scratchpadState(repo.dir, lane).kind).toBe("invalid");
      await expect(ensureSharedScratchpad(repo.dir, lane)).rejects.toThrow(
        "must resolve to a directory",
      );
      expect((await runSafetyPipeline(lane, repo.dir)).ok).toBe(false);
      expect(lstatSync(join(repo.dir, ".scratchpad")).isSymbolicLink()).toBe(true);
    } finally {
      repo.rm();
    }
  },
);

test("broken and foreign shared links veto removal without following them", async () => {
  const repo = makeRepo();
  try {
    const lane = repo.addWorktree("lane");
    await ensureSharedScratchpad(repo.dir, lane);
    unlinkSync(join(lane, ".scratchpad"));
    symlinkSync("missing", join(lane, ".scratchpad"));
    expect((await runSafetyPipeline(lane, repo.dir)).ok).toBe(false);
    unlinkSync(join(lane, ".scratchpad"));
    symlinkSync(repo.root, join(lane, ".scratchpad"));
    await expect(cmdRm("lane", { cwd: repo.dir, deleteBranch: false })).rejects.toThrow();
    expect(existsSync(lane)).toBe(true);
  } finally {
    repo.rm();
  }
});

test("sharing never replaces tracked or existing local Scratchpad content", async () => {
  const repo = makeRepo();
  try {
    repo.write(".scratchpad/note.md", "tracked");
    repo.commit("tracked notes");
    const lane = repo.addWorktree("lane");
    await expect(ensureSharedScratchpad(repo.dir, lane)).rejects.toThrow("tracked");
    expect(readFileSync(join(lane, ".scratchpad/note.md"), "utf8")).toBe("tracked");
  } finally {
    repo.rm();
  }
});

test("shared Scratchpad bytes are charged to primary only", async () => {
  const repo = makeRepo();
  try {
    const lane = repo.addWorktree("lane");
    await ensureSharedScratchpad(repo.dir, lane);
    const before = await measureDiskUsage(repo.dir, "fresh");
    repo.write(".scratchpad/large.bin", "x".repeat(2 * 1024 * 1024));
    const after = await measureDiskUsage(repo.dir, "fresh");
    expect(after.find((r) => r.path === lane)!.usage!.checkoutKb).toBe(
      before.find((r) => r.path === lane)!.usage!.checkoutKb,
    );
    expect(after.find((r) => r.primary)!.usage!.checkoutKb).toBeGreaterThan(
      before.find((r) => r.primary)!.usage!.checkoutKb + 1000,
    );
  } finally {
    repo.rm();
  }
});
