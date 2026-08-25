import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slugFor } from "../src/create.ts";
import { classifyCopy, isAllowed, isExcluded, isEnvFile, syncFiles } from "../src/sync.ts";

describe("slugFor", () => {
  test("replaces every slash with a dash", () => {
    expect(slugFor("x/my-feature")).toBe("x-my-feature");
    expect(slugFor("feat/a/b")).toBe("feat-a-b");
    expect(slugFor("plain")).toBe("plain");
  });
});

describe("isAllowed", () => {
  test("keeps the files wt exists to sync", () => {
    expect(isAllowed(".env")).toBe(true);
    expect(isAllowed("apps/api/.env.local")).toBe(true);
    expect(isAllowed(".dev.vars")).toBe(true);
    expect(isAllowed("apps/web/.dev.vars")).toBe(true);
    expect(isAllowed(".scratchpad/notes.md")).toBe(true);
    expect(isAllowed(".vscode/settings.json")).toBe(true);
    expect(isAllowed(".idea/workspace.xml")).toBe(true);
    expect(isAllowed(".zed/settings.json")).toBe(true);
    expect(isAllowed(".claude/settings.local.json")).toBe(true);
  });

  test("drops artifact trees and unrelated gitignored files", () => {
    expect(isAllowed("apps/e2e/runs/local/billing-refund-permanent-ses-rejection-releases-the-reserved-autumn-unit")).toBe(false);
    expect(isAllowed(".alchemy/local/aws/lambda/Api/index.js")).toBe(false);
    expect(isAllowed("builder-config.json")).toBe(false);
    expect(isAllowed(".DS_Store")).toBe(false);
    expect(isAllowed(".env.example")).toBe(false);
  });
});

describe("isEnvFile", () => {
  test("matches env files, never examples", () => {
    expect(isEnvFile(".env")).toBe(true);
    expect(isEnvFile("apps/api/.env.local")).toBe(true);
    expect(isEnvFile(".env.example")).toBe(false);
  });
});

describe("isExcluded", () => {
  test("matches components as prefixes", () => {
    expect(isExcluded("DerivedData/foo")).toBe(true);
    expect(isExcluded("app/DerivedDataDevice/foo")).toBe(true);
    expect(isExcluded("node_modules/pkg/index.js")).toBe(true);
    expect(isExcluded("apps/web/node_modules/x")).toBe(true);
    expect(isExcluded("apps/web/.next/build/x")).toBe(true);
  });

  test("matches multi-component entries at directory boundaries", () => {
    expect(isExcluded(".claude/worktrees/lane/file")).toBe(true);
    expect(isExcluded("sub/.claude/worktrees/lane")).toBe(true);
    expect(isExcluded(".claude/settings.json")).toBe(false);
  });

  test("does not treat allowlisted config as excluded", () => {
    expect(isExcluded(".env")).toBe(false);
    expect(isExcluded("apps/api/.env.local")).toBe(false);
    expect(isExcluded(".dev.vars")).toBe(false);
    expect(isExcluded(".scratchpad/notes.md")).toBe(false);
    expect(isExcluded(".vscode/settings.json")).toBe(false);
  });

  test("prefix matching applies to directories only, never the file component", () => {
    expect(isExcluded("builder-config.json")).toBe(false);
    expect(isExcluded("app/buildinfo.txt")).toBe(false);
    expect(isExcluded("builder-cache/artifact.bin")).toBe(true);
    expect(isExcluded("distcache/objects/a")).toBe(true);
  });
});

describe("syncFiles", () => {
  test("recreates dangling symlinks without calling rsync on them", async () => {
    const src = mkdtempSync(join(tmpdir(), "wt-sync-src-"));
    const dest = mkdtempSync(join(tmpdir(), "wt-sync-dst-"));
    mkdirSync(join(src, ".scratchpad"), { recursive: true });
    writeFileSync(join(src, ".env"), "A=1\n");
    symlinkSync("missing-target", join(src, ".scratchpad/stale-link"));

    expect(classifyCopy(src, ".scratchpad/stale-link")).toBe("symlink");
    expect(classifyCopy(src, ".env")).toBe("rsync");

    const landed = await syncFiles(src, dest, [".env", ".scratchpad/stale-link"], false);
    expect(landed).toEqual([".env", ".scratchpad/stale-link"]);
    expect(existsSync(join(dest, ".env"))).toBe(true);
    expect(lstatSync(join(dest, ".scratchpad/stale-link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dest, ".scratchpad/stale-link"))).toBe("missing-target");
  });

  test("skips paths that vanished between listing and copy", async () => {
    const src = mkdtempSync(join(tmpdir(), "wt-sync-src-"));
    const dest = mkdtempSync(join(tmpdir(), "wt-sync-dst-"));
    expect(classifyCopy(src, "gone.env")).toBe("skip");
    const landed = await syncFiles(src, dest, ["gone.env"], false);
    expect(landed).toEqual([]);
  });
});
