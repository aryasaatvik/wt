#!/usr/bin/env bun
// Build per-platform compiled binaries + tarballs (birdfeed release pattern).
// Usage: bun scripts/build-release-artifacts.ts [target ...]

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { $ } from "bun";

import pkg from "../package.json" with { type: "json" };

type ReleaseTarget = {
  readonly label: string;
  readonly bunTarget: string;
};

const TARGETS: Record<string, ReleaseTarget> = {
  "darwin-arm64": { label: "darwin-arm64", bunTarget: "bun-darwin-arm64" },
  "linux-x64": { label: "linux-x64", bunTarget: "bun-linux-x64-baseline" },
  "linux-arm64": { label: "linux-arm64", bunTarget: "bun-linux-arm64" },
};

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const RELEASE_ROOT = join(REPO_ROOT, "dist", "release");
const version = String(pkg.version);

function selectedTargets(): ReleaseTarget[] {
  const explicit = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const labels = explicit.length > 0 ? explicit : Object.keys(TARGETS);
  return labels.map((label) => {
    const target = TARGETS[label];
    if (!target) {
      throw new Error(`Unknown release target '${label}'. Expected one of: ${Object.keys(TARGETS).join(", ")}`);
    }
    return target;
  });
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function buildTarget(target: ReleaseTarget) {
  const artifactName = `wt-v${version}-${target.label}`;
  const stagingDir = join(RELEASE_ROOT, artifactName);
  const executablePath = join(stagingDir, "wt");
  const archivePath = join(RELEASE_ROOT, `${artifactName}.tar.gz`);

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(join(stagingDir, "completions"), { recursive: true });

  await $`bun build src/index.ts --compile --target=${target.bunTarget} --outfile=${executablePath}`.cwd(
    REPO_ROOT,
  );
  await chmod(executablePath, 0o755);
  await copyFile(join(REPO_ROOT, "completions", "wt.zsh"), join(stagingDir, "completions", "wt.zsh"));

  await writeFile(
    join(stagingDir, "README.txt"),
    [
      `wt ${version} (${target.label})`,
      "",
      "Install:",
      "  install -m 0755 wt ~/.local/bin/wt",
      "  cp completions/wt.zsh ~/.zsh/completions/wt.zsh   # optional",
      "",
      "Validate:",
      "  wt --help",
      "  wt ls --plain",
      "",
      "Requires git and rsync on PATH. No bun runtime needed.",
      "",
    ].join("\n"),
  );

  await rm(archivePath, { force: true });
  await $`tar -czf ${archivePath} -C ${stagingDir} .`;

  const digest = await sha256(archivePath);
  console.log(`${digest}  ${relative(RELEASE_ROOT, archivePath)}`);
  return { archive: archivePath, digest };
}

await rm(RELEASE_ROOT, { recursive: true, force: true });
await mkdir(RELEASE_ROOT, { recursive: true });

const results = [];
for (const target of selectedTargets()) {
  results.push(await buildTarget(target));
}

await writeFile(
  join(RELEASE_ROOT, "SHA256SUMS"),
  results.map((r) => `${r.digest}  ${relative(RELEASE_ROOT, r.archive)}`).join("\n") + "\n",
);
