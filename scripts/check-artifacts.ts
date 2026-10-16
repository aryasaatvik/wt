// Exercise the distributable without Bun, installed wt, or source on its PATH.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "bun";
import pkg from "../package.json" with { type: "json" };
import { makeRepo } from "../test/harness.ts";

const releaseRoot = resolve(import.meta.dir, "../dist/release");
const temp = mkdtempSync(join(tmpdir(), "wt-artifact-"));
const repo = makeRepo();
try {
  const tools = join(temp, "bin");
  mkdirSync(tools);
  const git = Bun.which("git");
  assert(git, "git is required for the offline fixture");
  symlinkSync(git, join(tools, "git"));
  const env = {
    ...process.env,
    PATH: tools,
    XDG_CONFIG_HOME: join(temp, "config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const smoke = (binary: string) => {
    const help = spawnSync([binary, "--help"], { cwd: temp, env });
    assert.equal(help.exitCode, 0, help.stderr.toString());
    assert.match(help.stdout.toString(), /Usage:/);
    const listing = spawnSync([binary, "ls", "--json", "--no-size"], { cwd: repo.dir, env });
    assert.equal(listing.exitCode, 0, listing.stderr.toString());
    const records: unknown = JSON.parse(listing.stdout.toString());
    assert(Array.isArray(records) && records.length === 1);
    assert.equal(records[0].path, repo.dir);
    assert.equal(records[0].branch, "main");
    assert.equal(records[0].dirty, false);
  };
  smoke(resolve(import.meta.dir, "../dist/wt"));
  const sums = readFileSync(join(releaseRoot, "SHA256SUMS"), "utf8").trim().split("\n");
  const labels = ["darwin-arm64", "linux-x64", "linux-arm64"];
  assert.equal(sums.length, labels.length);
  for (const label of labels) {
    const name = `wt-v${pkg.version}-${label}.tar.gz`;
    const archive = join(releaseRoot, name);
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    assert(sums.includes(`${digest}  ${name}`), `checksum mismatch: ${name}`);
    const unpacked = join(temp, label);
    mkdirSync(unpacked);
    const extraction = spawnSync(["tar", "-xzf", archive, "-C", unpacked]);
    assert.equal(extraction.exitCode, 0, extraction.stderr.toString());
    assert(readFileSync(join(unpacked, "wt")).length > 0);
    assert.equal(
      readFileSync(join(unpacked, "completions/wt.zsh"), "utf8"),
      readFileSync(resolve(import.meta.dir, "../completions/wt.zsh"), "utf8"),
    );
    assert.match(readFileSync(join(unpacked, "README.txt"), "utf8"), /No bun runtime needed/);
    if (label === `${process.platform}-${process.arch}`) {
      smoke(join(unpacked, "wt"));
      console.log(`Executed extracted ${label} binary; other targets checked as archives only.`);
    }
  }
  console.log("Compiled host CLI and release archives validated (offline, no Bun on PATH).");
} finally {
  repo.rm();
  rmSync(temp, { recursive: true, force: true });
}
