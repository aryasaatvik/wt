import { describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, readFileSync, readlinkSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  type CheckoutRecord,
  checkoutClone,
  cloneCheckoutReason,
  planClone,
} from "../src/clone.ts";
import { readProvenance } from "../src/create.ts";
import { clonefile, targetAttributes } from "./clone-fixture.ts";
import { makeRepo } from "./harness.ts";

describe("clone checkout eligibility", () => {
  test("keeps the standard Git path on another platform or with extra flags", async () => {
    expect(await planClone("/missing", "HEAD", [], "linux")).toEqual({
      reason: "APFS cloning requires macOS",
    });
    for (const flag of ["--no-checkout", "--detach", "-f"]) {
      expect(await planClone("/missing", "HEAD", [flag], "darwin")).toEqual({
        reason: "extra Git worktree flags",
      });
    }
  });

  test.if(targetAttributes)(
    "finds checkout attributes in the target commit even when absent from the primary",
    async () => {
      const repo = makeRepo();
      try {
        repo.git("checkout", "-b", "attributes");
        repo.write(".gitattributes", "*.md eol=crlf\n");
        const head = repo.commit("add attributes");
        repo.git("checkout", "main");
        const plan = await planClone(repo.dir, head, [], "darwin");
        if ("reason" in plan) throw new Error(plan.reason);
        expect(await cloneCheckoutReason(repo.dir, head, plan.files)).toBe(
          "Git checkout attribute: eol",
        );
      } finally {
        repo.rm();
      }
    },
  );

  test("finds gitlinks in the target tree", async () => {
    const repo = makeRepo();
    try {
      const commit = repo.git("rev-parse", "HEAD").trim();
      repo.git("update-index", "--add", "--cacheinfo", `160000,${commit},nested`);
      repo.git("commit", "-m", "add gitlink");
      expect(await planClone(repo.dir, "HEAD", [], "darwin")).toEqual({
        reason: "target tree contains gitlinks",
      });
    } finally {
      repo.rm();
    }
  });

  test("checks effective sparse checkout and implicit CRLF conversion", async () => {
    const repo = makeRepo();
    try {
      const plan = await planClone(repo.dir, "HEAD", [], "darwin");
      if ("reason" in plan) throw new Error(plan.reason);
      for (const [key, value, reason] of [
        ["core.sparseCheckout", "true", "sparse checkout"],
        ["core.autocrlf", "input", "core.autocrlf conversion"],
      ]) {
        repo.git("config", key!, value!);
        expect(await cloneCheckoutReason(repo.dir, "HEAD", plan.files)).toBe(reason);
        repo.git("config", "--unset", key!);
      }
    } finally {
      repo.rm();
    }
  });
});

test.if(clonefile)("uses Git to repair cloned bytes and mode", async () => {
  const repo = makeRepo();
  try {
    repo.write("dir/-file\nname", "good\n");
    repo.write("executable", "#!/bin/sh\n");
    chmodSync(join(repo.dir, "executable"), 0o755);
    symlinkSync("unresolved", join(repo.dir, "link"));
    const head = repo.commit("tracked files");
    const plain = repo.addWorktree("plain", { detachAt: head });
    const path = join(repo.dir, "dir/-file\nname");
    const { atime, mtime } = lstatSync(path);
    repo.write("dir/-file\nname", "evil\n");
    utimesSync(path, atime, mtime);
    chmodSync(join(repo.dir, "executable"), 0o644);
    repo.git("config", "core.filemode", "false");

    const plan = await planClone(repo.dir, head, []);
    if ("reason" in plan) throw new Error(plan.reason);
    const lane = join(repo.root, "clone");
    repo.git("worktree", "add", "--no-checkout", "-b", "clone", lane, head);
    const report: CheckoutRecord = { mode: "clone", cloned: 0, rewritten: 0 };
    await checkoutClone(repo.dir, lane, head, plan.files, report);
    expect(report).toEqual({ mode: "clone", cloned: 4, rewritten: 2 });
    expect(repo.gitIn(lane, "status", "--porcelain")).toBe("");
    expect(repo.gitIn(lane, "ls-files", "-s")).toBe(repo.gitIn(plain, "ls-files", "-s"));
    for (const file of plan.files) {
      const actual = join(lane, file.path);
      const expected = join(plain, file.path);
      expect(lstatSync(actual).mode).toBe(lstatSync(expected).mode);
      if (file.symlink) expect(readlinkSync(actual)).toBe(readlinkSync(expected));
      else expect(readFileSync(actual)).toEqual(readFileSync(expected));
    }
  } finally {
    repo.rm();
  }
});

test.if(clonefile && targetAttributes)(
  "runs the APFS clone worker from the compiled CLI",
  async () => {
    const repo = makeRepo();
    try {
      const binary = join(repo.root, "wt");
      const build = Bun.spawnSync(
        [process.execPath, "build", "src/index.ts", "--compile", "--outfile", binary],
        { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
      );
      expect(build.stderr.toString()).not.toContain("error:");
      expect(build.exitCode).toBe(0);
      const run = Bun.spawnSync([binary, "new", "feat/standalone", "main", "--no-install"], {
        cwd: repo.dir,
        env: {
          ...Bun.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          XDG_CONFIG_HOME: join(repo.root, "config"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.stderr.toString()).toBe("");
      expect(run.exitCode).toBe(0);
      const lane = join(repo.root, "repo-worktrees", "feat-standalone");
      expect(readProvenance(lane)?.checkout).toEqual({
        mode: "clone",
        cloned: 1,
        rewritten: 0,
      });
      expect(repo.gitIn(lane, "status", "--porcelain")).toBe("");
    } finally {
      repo.rm();
    }
  },
);
