import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdDu } from "../src/du.ts";
import { measureDiskUsage } from "../src/disk.ts";
import { makeRepo } from "./harness.ts";

describe("owned disk accounting", () => {
  test("separates checkout, linked submodule metadata, and shared Git storage", async () => {
    const repo = makeRepo();
    const module = makeRepo();
    try {
      repo.git("-c", "protocol.file.allow=always", "submodule", "add", module.dir, "vendor/module");
      repo.commit("add submodule");
      const lane = repo.addWorktree("lane", { branch: "feat/lane" });
      repo.gitIn(lane, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");

      const nested = join(lane, "vendor/module");
      const nestedGitDir = repo.gitIn(nested, "rev-parse", "--absolute-git-dir").trim();
      mkdirSync(nestedGitDir, { recursive: true });
      writeFileSync(join(nestedGitDir, "lane-private.bin"), "x".repeat(128 * 1024));
      writeFileSync(join(lane, "checkout-only.bin"), "y".repeat(64 * 1024));

      const reports = await measureDiskUsage(repo.dir, "fresh");
      const primary = reports.find((report) => report.primary)!;
      const linked = reports.find((report) => report.branch === "feat/lane")!;

      expect(primary.usage.checkoutKb).toBeGreaterThan(0);
      expect(primary.usage.privateGitKb).toBe(0);
      expect(linked.usage.checkoutKb).toBeGreaterThanOrEqual(64);
      expect(linked.usage.privateGitKb).toBeGreaterThanOrEqual(128);
      expect(linked.usage.ownedKb).toBe(linked.usage.checkoutKb + linked.usage.privateGitKb);
      expect(linked.usage.sharedKb).toBeGreaterThan(0);

      const cachePath = join(repo.gitIn(lane, "rev-parse", "--absolute-git-dir").trim(), "wt-size.json");
      expect(JSON.parse(readFileSync(cachePath, "utf8")).version).toBe(2);

      const json = JSON.parse(await cmdDu({ cwd: repo.dir, target: "feat/lane", json: true, fresh: false }));
      expect(json).toHaveLength(1);
      expect(json[0].usage).toEqual(expect.objectContaining({
        checkoutKb: linked.usage.checkoutKb,
        privateGitKb: linked.usage.privateGitKb,
        ownedKb: linked.usage.ownedKb,
      }));
    } finally {
      repo.rm();
      module.rm();
    }
  });
});
