import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planScratchpadMigration, applyScratchpadMigration } from "../src/scratchpad-migration.ts";
import { runSafetyPipeline } from "../src/safety.ts";
import { cmdRm } from "../src/rm.ts";
import { makeRepo } from "./harness.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function fixture() {
  const repo = makeRepo();
  repo.write(".gitignore", ".scratchpad/\n");
  repo.commit("ignore notes");
  const lane = repo.addWorktree("lane");
  mkdirSync(join(lane, ".scratchpad"));
  return { repo, lane };
}

test("preview is read-only; identical copies convert and removal never archives", async () => {
  const { repo, lane } = fixture();
  try {
    repo.write(".scratchpad/note.md", "same");
    writeFileSync(join(lane, ".scratchpad/note.md"), "same");
    const plan = await planScratchpadMigration(repo.dir, "lane");
    expect(plan.entries[0]!.status).toBe("identical");
    expect((await runSafetyPipeline(lane, repo.dir)).ok).toBe(false);
    await applyScratchpadMigration(repo.dir, "lane", plan);
    await applyScratchpadMigration(repo.dir, "lane", plan); // safe retry after success
    expect((await runSafetyPipeline(lane, repo.dir)).ok).toBe(true);
    await cmdRm("lane", { cwd: repo.dir, deleteBranch: false });
    expect(readFileSync(join(repo.dir, ".scratchpad/note.md"), "utf8")).toBe("same");
    expect(existsSync(join(repo.dir, ".scratchpad/archive"))).toBe(false);
  } finally { repo.rm(); }
});

test("unique binary evidence requires preservation or an explicit documented disposition", async () => {
  const { repo, lane } = fixture();
  try {
    writeFileSync(join(lane, ".scratchpad/result.bin"), "unique\0bytes");
    const plan = await planScratchpadMigration(repo.dir, "lane");
    await expect(applyScratchpadMigration(repo.dir, "lane", plan)).rejects.toThrow("unreconciled");
    repo.write(".scratchpad/validation/result.bin", "unique\0bytes");
    plan.resolutions.push({ path: "result.bin", sourceHash: plan.entries[0]!.hash!, disposition: "preserved", reason: "test evidence belongs with validation", evidence: { path: "validation/result.bin", hash: hash("unique\0bytes") } });
    await applyScratchpadMigration(repo.dir, "lane", plan);
    expect(readFileSync(join(repo.dir, ".scratchpad/validation/result.bin"), "utf8")).toBe("unique\0bytes");
  } finally { repo.rm(); }
});

test("source edits, added files and changed canonical witnesses invalidate the reviewed plan", async () => {
  const { repo, lane } = fixture();
  try {
    repo.write(".scratchpad/note.md", "same");
    writeFileSync(join(lane, ".scratchpad/note.md"), "same");
    const plan = await planScratchpadMigration(repo.dir, "lane");
    writeFileSync(join(lane, ".scratchpad/note.md"), "changed");
    await expect(applyScratchpadMigration(repo.dir, "lane", plan)).rejects.toThrow("snapshot changed");
    writeFileSync(join(lane, ".scratchpad/note.md"), "same");
    repo.write(".scratchpad/note.md", "new canonical facts");
    await expect(applyScratchpadMigration(repo.dir, "lane", plan)).rejects.toThrow("unreconciled");
    writeFileSync(join(lane, ".scratchpad/new.bin"), "new");
    await expect(applyScratchpadMigration(repo.dir, "lane", plan)).rejects.toThrow("snapshot changed");
    expect(existsSync(join(lane, ".scratchpad/new.bin"))).toBe(true);
  } finally { repo.rm(); }
});

test("symlink meaning is reviewed explicitly and canonical evidence cannot escape through links", async () => {
  const { repo, lane } = fixture();
  try {
    symlinkSync(".", join(lane, ".scratchpad/cycle"));
    const plan = await planScratchpadMigration(repo.dir, "lane");
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]!.kind).toBe("symlink");
    repo.write(".scratchpad/closure.md", "Obsolete cyclic link; no evidence target.");
    const resolution = { path: "cycle", sourceHash: plan.entries[0]!.hash!, disposition: "superseded" as const, reason: "obsolete cyclic alias", evidence: { path: "closure.md", hash: hash("Obsolete cyclic link; no evidence target.") } };
    plan.resolutions.push(resolution);
    symlinkSync(repo.root, join(repo.dir, ".scratchpad/external"));
    resolution.evidence.path = "external/anything";
    await expect(applyScratchpadMigration(repo.dir, "lane", plan)).rejects.toThrow("canonical evidence");
    resolution.evidence.path = "../README.md";
    await expect(applyScratchpadMigration(repo.dir, "lane", plan)).rejects.toThrow("invalid canonical");
    resolution.evidence.path = "closure.md";
    await applyScratchpadMigration(repo.dir, "lane", plan);
    expect(existsSync(join(repo.dir, ".scratchpad/cycle"))).toBe(false);
  } finally { repo.rm(); }
});

test("interrupted conversion retains original, blocks rm and resumes from the recovery directory", async () => {
  const { repo, lane } = fixture();
  try {
    repo.write(".scratchpad/note.md", "same");
    writeFileSync(join(lane, ".scratchpad/note.md"), "same");
    const plan = await planScratchpadMigration(repo.dir, "lane");
    const gitDir = repo.gitIn(lane, "rev-parse", "--absolute-git-dir").trim();
    const backup = join(gitDir, "wt-scratchpad-original");
    renameSync(join(lane, ".scratchpad"), backup); // interrupted after rename
    expect((await runSafetyPipeline(lane, repo.dir)).ok).toBe(false);
    await expect(cmdRm("lane", { cwd: repo.dir, deleteBranch: false })).rejects.toThrow();
    await applyScratchpadMigration(repo.dir, "lane", plan);
    expect(existsSync(backup)).toBe(false);
    expect(readFileSync(join(lane, ".scratchpad/note.md"), "utf8")).toBe("same");
    expect((await runSafetyPipeline(lane, repo.dir)).ok).toBe(true);
  } finally { repo.rm(); }
});
