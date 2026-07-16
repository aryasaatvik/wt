// Fixture harness: builds throwaway git repos in temp dirs so tests can
// exercise wt against real git state. Every fixture is isolated from the
// user's global git config and cleaned up by the caller via rm().

import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "bun";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@test",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@test",
};

export class FixtureRepo {
  readonly root: string;
  readonly dir: string;

  /** @param root temp dir owning everything; @param dir the repo checkout */
  constructor(root: string, dir: string) {
    this.root = root;
    this.dir = dir;
  }

  /** Run git in the repo; throws on failure with stderr in the message. */
  git(...args: string[]): string {
    return this.exec(this.dir, ["git", ...args]);
  }

  /** Run git in an arbitrary path under the fixture (e.g. a worktree). */
  gitIn(cwd: string, ...args: string[]): string {
    return this.exec(cwd, ["git", ...args]);
  }

  /** Write a file (relative to the repo) creating parent dirs. */
  write(rel: string, content: string): void {
    const abs = join(this.dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  commit(message: string): string {
    this.git("add", "-A");
    this.git("commit", "-m", message);
    return this.git("rev-parse", "HEAD").trim();
  }

  /** Add a worktree as a sibling under `<name>-worktrees/`, mirroring wt's layout. */
  addWorktree(slug: string, opts?: { branch?: string; detachAt?: string }): string {
    const wtDir = join(this.root, "repo-worktrees", slug);
    mkdirSync(dirname(wtDir), { recursive: true });
    if (opts?.detachAt) {
      this.git("worktree", "add", "--detach", wtDir, opts.detachAt);
    } else {
      this.git("worktree", "add", "-b", opts?.branch ?? slug, wtDir);
    }
    return wtDir;
  }

  /**
   * Create a bare origin at <root>/origin.git, push main, and set origin/HEAD
   * so default-branch resolution works like a real clone.
   */
  addOrigin(): string {
    const originDir = join(this.root, "origin.git");
    this.exec(this.root, ["git", "init", "--bare", "-b", "main", originDir]);
    this.git("remote", "add", "origin", originDir);
    this.git("push", "-u", "origin", "main");
    this.git("remote", "set-head", "origin", "main");
    return originDir;
  }

  rm(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  private exec(cwd: string, cmd: string[]): string {
    const r = spawnSync(cmd, { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
    if (!r.success) {
      throw new Error(`${cmd.join(" ")} failed in ${cwd}:\n${r.stderr.toString()}`);
    }
    return r.stdout.toString();
  }
}

/** Create a repo with one initial commit on `main`. */
export function makeRepo(): FixtureRepo {
  // realpath so fixture paths match git's canonicalization (/var → /private/var on macOS)
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "wt-fixture-")));
  const dir = join(root, "repo");
  mkdirSync(dir);
  const repo = new FixtureRepo(root, dir);
  repo.gitIn(dir, "init", "-b", "main");
  repo.write("README.md", "fixture\n");
  repo.commit("initial");
  return repo;
}
