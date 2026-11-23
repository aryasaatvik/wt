import { dlopen } from "bun:ffi";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type FixtureRepo, makeRepo } from "./harness.ts";

function checkoutCapabilities() {
  const repo = makeRepo();
  try {
    const targetAttributes = Bun.spawnSync([
      "git",
      "-C",
      repo.dir,
      "check-attr",
      "--source=HEAD",
      "-a",
      "--",
      "README.md",
    ]).success;
    if (process.platform !== "darwin") return { targetAttributes, clonefile: false };

    const native = dlopen("/usr/lib/libSystem.B.dylib", {
      clonefile: { args: ["ptr", "ptr", "u32"], returns: "int" },
    });
    try {
      const source = Buffer.from(join(repo.dir, "README.md") + "\0");
      const dest = Buffer.from(join(repo.root, "clone-probe") + "\0");
      return { targetAttributes, clonefile: native.symbols.clonefile(source, dest, 1) === 0 };
    } finally {
      native.close();
    }
  } finally {
    repo.rm();
  }
}

export const { targetAttributes, clonefile } = checkoutCapabilities();

export async function runWithGitFailure(repo: FixtureRepo, blockedCommand: string, branch: string) {
  const git = Bun.which("git");
  if (!git) throw new Error("fixture requires Git");
  const bin = join(repo.root, "bin");
  mkdirSync(bin);
  const shim = join(bin, "git");
  await Bun.write(
    shim,
    `#!/bin/sh
for arg do
  if [ "$arg" = "$WT_FIXTURE_BLOCKED_GIT_COMMAND" ]; then
    echo 'fixture Git command unavailable' >&2
    exit 1
  fi
done
exec "$WT_FIXTURE_GIT" "$@"
`,
  );
  chmodSync(shim, 0o755);
  return Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "../src/index.ts"),
      "new",
      branch,
      "main",
      "--no-install",
    ],
    {
      cwd: repo.dir,
      env: {
        ...Bun.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        WT_FIXTURE_GIT: git,
        WT_FIXTURE_BLOCKED_GIT_COMMAND: blockedCommand,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        XDG_CONFIG_HOME: join(repo.root, "config"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}
