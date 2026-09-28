import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { removeLane } from "../src/picker.ts";
import { makeRepo } from "./harness.ts";

describe("picker removeLane", () => {
  test("removes a lane with a clean submodule and reports the retained Git data", async () => {
    const module = makeRepo();
    const repo = makeRepo();
    try {
      repo.git("-c", "protocol.file.allow=always", "submodule", "add", module.dir, "vendor/module");
      repo.commit("add submodule");
      const wt = repo.addWorktree("with-module", { branch: "feat/module" });
      repo.gitIn(wt, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
      const result = await removeLane("with-module", wt, repo.dir);
      expect(result.removed).toBe(true);
      expect(result.status).toMatch(/^removed with-module · submodule Git data retained at .*wt-submodules-.*modules$/);
      expect(existsSync(wt)).toBe(false);
      expect(repo.git("config", "--get", "submodule.vendor/module.url").trim()).toBe(module.dir);
    } finally {
      repo.rm();
      module.rm();
    }
  });

  test("skips a lane whose submodule has untracked files", async () => {
    const module = makeRepo();
    const repo = makeRepo();
    try {
      repo.git("-c", "protocol.file.allow=always", "submodule", "add", module.dir, "vendor/module");
      repo.commit("add submodule");
      const wt = repo.addWorktree("with-module", { branch: "feat/module" });
      repo.gitIn(wt, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
      await Bun.write(join(wt, "vendor/module/untracked.txt"), "keep\n");
      const result = await removeLane("with-module", wt, repo.dir);
      expect(result).toEqual({
        removed: false,
        status: "skipped with-module: submodule vendor/module has changes, untracked, or ignored files",
      });
      expect(existsSync(join(wt, "vendor/module/untracked.txt"))).toBe(true);
    } finally {
      repo.rm();
      module.rm();
    }
  });
});
