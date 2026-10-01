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

test("conversion uses evidence under a symlinked primary root without following nested links", async () => {
  const { repo, lane } = fixture();
  try {
    const storage = join(repo.root, "xdg-notes");
    mkdirSync(storage);
    symlinkSync(storage, join(repo.dir, ".scratchpad"));
    writeFileSync(join(storage, "same.md"), "same");
    writeFileSync(join(lane, ".scratchpad/same.md"), "same");
    writeFileSync(join(lane, ".scratchpad/unique.md"), "unique");
    const plan = await planScratchpadMigration(repo.dir, "lane");
    expect(plan.entries.find((entry) => entry.path === "same.md")!.status).toBe("identical");
    writeFileSync(join(storage, "preserved.md"), "unique");
    symlinkSync("preserved.md", join(storage, "alias.md"));
    const decision = { path: "unique.md", sourceHash: hash("unique"), disposition: "preserved" as const, reason: "retain unique note", evidence: { path: "alias.md", hash: hash("unique") } };
    plan.resolutions.push(decision);
    await expect(applyScratchpadMigration(repo.dir, "lane", plan)).rejects.toThrow("canonical evidence");
    decision.evidence.path = "preserved.md";
    await applyScratchpadMigration(repo.dir, "lane", plan);
    expect((await runSafetyPipeline(lane, repo.dir)).ok).toBe(true);
    expect(readFileSync(join(lane, ".scratchpad/preserved.md"), "utf8")).toBe("unique");
  } finally { repo.rm(); }
});

test("review resolutions report the invalid field and expected evidence shape", async () => {
  const { repo, lane } = fixture();
  try {
    writeFileSync(join(lane, ".scratchpad/note.md"), "lane facts");
    repo.write(".scratchpad/canonical.md", "canonical facts");
    const plan = await planScratchpadMigration(repo.dir, "lane");
    plan.resolutions.push({
      path: "note.md",
      sourceHash: plan.entries[0]!.hash!,
      disposition: "integrated",
      reason: "The facts are in the canonical note.",
      evidence: { path: "canonical.md", hash: hash("canonical facts") },
    });

    const cases = [
      { name: "missing sourceHash", change: { sourceHash: undefined }, error: "resolution.sourceHash must match the preview entry hash" },
      { name: "invalid sourceHash", change: { sourceHash: "wrong" }, error: "resolution.sourceHash must match the preview entry hash" },
      { name: "unknown disposition", change: { disposition: "discarded" }, error: "resolution.disposition must be integrated, superseded, or preserved" },
      { name: "missing reason", change: { reason: undefined }, error: "resolution.reason must be a non-empty string" },
      { name: "blank reason", change: { reason: "  " }, error: "resolution.reason must be a non-empty string" },
      { name: "missing evidence", change: { evidence: undefined }, error: "resolution.evidence must be { path: <canonical relative regular file>, hash: <SHA-256 hex> }" },
      { name: "invalid evidence", change: { evidence: { path: "canonical.md", hash: "wrong" } }, error: "resolution.evidence must be { path: <canonical relative regular file>, hash: <SHA-256 hex> }" },
    ];
    for (const { name, change, error } of cases) {
      const invalid = structuredClone(plan);
      Object.assign(invalid.resolutions[0]!, change);
      await expect(applyScratchpadMigration(repo.dir, "lane", invalid), name).rejects.toThrow(error);
    }
    expect(existsSync(join(lane, ".scratchpad/note.md"))).toBe(true);
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
