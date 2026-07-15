#!/usr/bin/env bun
// Release driver (birdfeed pattern): build artifacts from a clean origin/main
// checkout, then idempotently tag, create the GitHub release, and upload.
// Usage: bun scripts/release-artifacts.ts [vX.Y.Z]

import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pkg from "../package.json" with { type: "json" };

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const releaseRoot = join(repoRoot, "dist", "release");
const version = String(pkg.version);
const expectedTag = `v${version}`;
const requestedTag = process.argv[2];

if (requestedTag === "--help" || requestedTag === "-h") {
  console.log(`Usage: bun scripts/release-artifacts.ts [${expectedTag}]`);
  process.exit(0);
}

if (requestedTag && requestedTag !== expectedTag) {
  console.error(`Release tag must match package.json version: expected ${expectedTag}, got ${requestedTag}`);
  process.exit(1);
}

const tag = expectedTag;

function run(command: string, args: ReadonlyArray<string>) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command: string, args: ReadonlyArray<string>) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout.trim();
}

function succeeds(command: string, args: ReadonlyArray<string>) {
  return spawnSync(command, args, { cwd: repoRoot, stdio: "ignore" }).status === 0;
}

run("git", ["fetch", "origin", "main", "--tags"]);

const head = capture("git", ["rev-parse", "HEAD"]);
const originMain = capture("git", ["rev-parse", "origin/main"]);
const status = capture("git", ["status", "--porcelain"]);

if (head !== originMain) {
  console.error(`Release must run from origin/main. HEAD=${head}, origin/main=${originMain}`);
  process.exit(1);
}

if (status) {
  console.error("Release must run from a clean worktree.");
  console.error(status);
  process.exit(1);
}

// --os/--cpu '*': fetch native deps for every platform so cross-compiled
// binaries (opentui) link correctly.
run("bun", ["install", "--frozen-lockfile", "--os", "*", "--cpu", "*"]);
run("bun", ["run", "typecheck"]);
run("bun", ["test"]);
run("bun", ["scripts/build-release-artifacts.ts"]);

const artifactNames = (await readdir(releaseRoot)).filter(
  (name) => name.endsWith(".tar.gz") || name === "SHA256SUMS",
);
if (artifactNames.length === 0) {
  console.error(`No release artifacts found in ${releaseRoot}`);
  process.exit(1);
}

if (succeeds("git", ["rev-parse", "--verify", `refs/tags/${tag}`])) {
  const tagCommit = capture("git", ["rev-list", "-n", "1", tag]);
  if (tagCommit !== head) {
    console.error(`Tag ${tag} points to ${tagCommit}, expected ${head}`);
    process.exit(1);
  }
} else {
  run("git", ["tag", "-a", tag, "-m", `wt ${tag}`]);
}

if (!succeeds("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`])) {
  run("git", ["push", "origin", tag]);
}

if (!succeeds("gh", ["release", "view", tag])) {
  run("gh", ["release", "create", tag, "--title", tag, "--generate-notes"]);
}

run("gh", ["release", "upload", tag, ...artifactNames.map((n) => join(releaseRoot, n)), "--clobber"]);
