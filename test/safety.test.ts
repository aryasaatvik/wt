import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cmdRm } from "../src/rm.ts";
import { describeEnvDrift, envDriftLosesContent, envKeys, parseEnvAssignments, runSafetyPipeline } from "../src/safety.ts";
import { isEnvFile } from "../src/sync.ts";
import { makeRepo, type FixtureRepo } from "./harness.ts";

function writeIn(_repo: FixtureRepo, dir: string, rel: string, content: string, mtime?: Date) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (mtime) utimesSync(abs, mtime, mtime);
}

describe("env helpers", () => {
  test("isEnvFile matches env files, never examples", () => {
    expect(isEnvFile(".env")).toBe(true);
    expect(isEnvFile("apps/api/.env.local")).toBe(true);
    expect(isEnvFile("apps/web/.dev.vars")).toBe(true);
    expect(isEnvFile(".env.example")).toBe(false);
    expect(isEnvFile("node_modules/mimetext/.env.sample")).toBe(false);
    expect(isEnvFile("config.json")).toBe(false);
  });

  test("envKeys extracts names only", () => {
    const keys = envKeys("FOO=secret1\nexport BAR='x'\n# comment\nBAZ =1\n");
    expect([...keys].sort()).toEqual(["BAR", "BAZ", "FOO"]);
  });

  test("describeEnvDrift reports names, never values", () => {
    const drift = describeEnvDrift(".env", "A=wt-secret\nB=2\n", "B=2\nC=pri-secret\n")!;
    expect(drift).toContain("only in worktree: A");
    expect(drift).toContain("only in primary: C");
    expect(drift).not.toContain("wt-secret");
    expect(drift).not.toContain("pri-secret");
    expect(describeEnvDrift(".env", "A=1\n", "A=1\n")).toBeNull();
    expect(describeEnvDrift(".env", "A=1\n", "A=2\n")).toContain("values differ");
  });
});

describe("envDriftLosesContent", () => {
  test("is lossless when every lane assignment is present in the primary", () => {
    expect(envDriftLosesContent("A=1\n", "A=1\nB=2\n# note\n")).toBe(false);
    expect(envDriftLosesContent("# only comments\n\n", "A=1\n")).toBe(false);
  });

  test("loses content on a lane-only key, a differing value, or a missing primary file", () => {
    expect(envDriftLosesContent("A=1\nC=3\n", "A=1\nB=2\n")).toBe(true);
    expect(envDriftLosesContent("A=2\n", "A=1\n")).toBe(true);
    expect(envDriftLosesContent("A=1\n", null)).toBe(true);
  });

  test("treats unclassifiable lane content as loss", () => {
    expect(envDriftLosesContent("A=1\ncontinue-line\n", "A=1\n")).toBe(true);
  });
});

describe("parseEnvAssignments", () => {
  test("extracts normalized key/value pairs and flags unparsed lines", () => {
    const parsed = parseEnvAssignments("export A=1\nB = two\n# c\n\nC='x'\n");
    expect(parsed.map.get("A")).toBe("1");
    expect(parsed.map.get("B")).toBe("two");
    expect(parsed.map.get("C")).toBe("'x'");
    expect(parsed.unparsed).toBe(false);
    expect(parseEnvAssignments("A=1\nmultiline\n").unparsed).toBe(true);
  });
});

describe("runSafetyPipeline", () => {
  test("retains local Scratchpad copies for explicit reconciliation", async () => {
    const repo = makeRepo();
    try {
      const wt = repo.addWorktree("lane", { branch: "lane" });
      writeIn(repo, wt, ".scratchpad/research/unique.md", "only in lane\n");
      const result = await runSafetyPipeline(wt, repo.dir, { date: "2026-07-15" });
      expect(result.ok).toBe(false);
      expect(result.salvaged).toEqual([]);
      const dest = join(repo.dir, ".scratchpad/archive/2026-07-15-worktree-salvage/lane/research/unique.md");
      expect(existsSync(dest)).toBe(false);
      expect(readFileSync(join(wt, ".scratchpad/research/unique.md"), "utf8")).toBe("only in lane\n");
    } finally {
      repo.rm();
    }
  });

  test("flags worktree-newer conflicting mds and does not salvage them", async () => {
    const repo = makeRepo();
    try {
      const wt = repo.addWorktree("lane", { branch: "lane" });
      const old = new Date("2026-01-01");
      writeIn(repo, repo.dir, ".scratchpad/plan.md", "primary version\n", old);
      writeIn(repo, wt, ".scratchpad/plan.md", "lane version, newer\n");
      const result = await runSafetyPipeline(wt, repo.dir, { date: "2026-07-15" });
      expect(result.ok).toBe(false);
      expect(result.flags.map((f) => f.kind)).toContain("scratchpad-conflict");
      expect(result.salvaged).toEqual([]);
    } finally {
      repo.rm();
    }
  });

  test("flags env drift by key names only", async () => {
    const repo = makeRepo();
    try {
      writeIn(repo, repo.dir, ".env", "SHARED=1\n");
      const wt = repo.addWorktree("lane", { branch: "lane" });
      writeIn(repo, wt, ".env", "SHARED=1\nLANE_ONLY_SECRET=super-secret-value\n");
      const result = await runSafetyPipeline(wt, repo.dir);
      expect(result.ok).toBe(false);
      const drift = result.flags.find((f) => f.kind === "env-drift")!;
      expect(drift.detail).toContain("LANE_ONLY_SECRET");
      expect(drift.detail).not.toContain("super-secret-value");
    } finally {
      repo.rm();
    }
  });

  test("allows removal when the lane env is covered by the primary", async () => {
    const repo = makeRepo();
    try {
      writeIn(repo, repo.dir, ".env", "SHARED=1\nPRIMARY_ONLY=2\n");
      const wt = repo.addWorktree("lane", { branch: "lane" });
      writeIn(repo, wt, ".env", "SHARED=1\n");
      const result = await runSafetyPipeline(wt, repo.dir);
      expect(result.flags.filter((f) => f.kind === "env-drift")).toEqual([]);
    } finally {
      repo.rm();
    }
  });

  test("blocks when a lane value differs from the primary", async () => {
    const repo = makeRepo();
    try {
      writeIn(repo, repo.dir, ".env", "SHARED=1\n");
      const wt = repo.addWorktree("lane", { branch: "lane" });
      writeIn(repo, wt, ".env", "SHARED=2\n");
      const result = await runSafetyPipeline(wt, repo.dir);
      const drift = result.flags.find((f) => f.kind === "env-drift")!;
      expect(drift.detail).toContain("values differ");
      expect(drift.detail).not.toContain("SHARED=2");
    } finally {
      repo.rm();
    }
  });

  test("blocks when the lane env file is missing from the primary", async () => {
    const repo = makeRepo();
    try {
      const wt = repo.addWorktree("lane", { branch: "lane" });
      writeIn(repo, wt, ".env.local", "LANE_ONLY_SECRET=super-secret-value\n");
      const result = await runSafetyPipeline(wt, repo.dir);
      const drift = result.flags.find((f) => f.kind === "env-drift")!;
      expect(drift.detail).toContain("missing in primary");
      expect(drift.detail).not.toContain("super-secret-value");
    } finally {
      repo.rm();
    }
  });

  test("dry run reports a local-copy blocker without copying", async () => {
    const repo = makeRepo();
    try {
      const wt = repo.addWorktree("lane", { branch: "lane" });
      writeIn(repo, wt, ".scratchpad/unique.md", "x\n");
      const result = await runSafetyPipeline(wt, repo.dir, { dryRun: true, date: "2026-07-15" });
      expect(result.salvaged).toEqual([]);
      expect(result.ok).toBe(false);
      expect(existsSync(join(repo.dir, ".scratchpad/archive"))).toBe(false);
    } finally {
      repo.rm();
    }
  });

  test("cmdRm blocks on env drift WITHOUT writing archive copies", async () => {
    const repo = makeRepo();
    try {
      writeIn(repo, repo.dir, ".env", "A=1\n");
      const wt = repo.addWorktree("lane", { branch: "lane" });
      writeIn(repo, wt, ".env", "A=1\nB=2\n");
      writeIn(repo, wt, ".scratchpad/unique.md", "would salvage on a clean removal\n");
      await expect(cmdRm("lane", { deleteBranch: false, cwd: repo.dir })).rejects.toThrow();
      expect(existsSync(wt)).toBe(true);
      // blocked removal must leave no orphaned salvage copies behind
      expect(existsSync(join(repo.dir, ".scratchpad/archive"))).toBe(false);
    } finally {
      repo.rm();
    }
  });

  test("cmdRm honors expectHead", async () => {
    const repo = makeRepo();
    try {
      const wt = repo.addWorktree("lane", { branch: "lane" });
      repo.gitIn(wt, "commit", "--allow-empty", "-m", "moved");
      await expect(
        cmdRm("lane", { deleteBranch: false, cwd: repo.dir, expectHead: "0000000" }),
      ).rejects.toThrow();
      expect(existsSync(wt)).toBe(true);
    } finally {
      repo.rm();
    }
  });
});

/** Temp XDG config home carrying a `[sync] exclude` list, isolated per call. */
function configEnv(exclude: string[]): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "wt-config-"));
  mkdirSync(join(home, "wt"), { recursive: true });
  writeFileSync(
    join(home, "wt", "config.toml"),
    `[sync]\nexclude = [${exclude.map((p) => JSON.stringify(p)).join(", ")}]\n`,
  );
  return { ...process.env, XDG_CONFIG_HOME: home };
}

function markerFiles(wt: string, repo: FixtureRepo, syncedFiles: string[]): void {
  const gitDir = repo.gitIn(wt, "rev-parse", "--absolute-git-dir").trim();
  const now = new Date().toISOString();
  writeFileSync(
    join(gitDir, "wt.json"),
    JSON.stringify({ createdAt: now, updatedAt: now, branch: "lane", base: "main", phase: "ready", syncedFiles }) + "\n",
  );
}

describe("runSafetyPipeline env-drift honors sync.exclude", () => {
  test("suppresses matching paths and keeps non-matching drift (walk fallback)", async () => {
    const repo = makeRepo();
    try {
      writeIn(repo, repo.dir, ".env", "A=1\n");
      const wt = repo.addWorktree("lane", { branch: "lane" });
      writeIn(repo, wt, ".env", "A=1\nB=2\n");
      writeIn(repo, wt, "other/.env", "A=1\nB=2\n");
      writeIn(repo, wt, ".deepsec/.env.json", "A=1\nB=2\n");
      const result = await runSafetyPipeline(wt, repo.dir, { env: configEnv([".deepsec"]) });
      const details = result.flags.filter((f) => f.kind === "env-drift").map((f) => f.detail);
      expect(details.some((d) => d.startsWith(".env: "))).toBe(true);
      expect(details.some((d) => d.startsWith("other/.env: "))).toBe(true);
      expect(details.some((d) => d.includes(".deepsec/"))).toBe(false);
    } finally {
      repo.rm();
    }
  });

  test("hard exclusions suppress drift without user config", async () => {
    const repo = makeRepo();
    try {
      const wt = repo.addWorktree("lane", { branch: "lane" });
      writeIn(repo, wt, ".conductor/.env", "A=1\nB=2\n");
      const result = await runSafetyPipeline(wt, repo.dir);
      expect(result.flags.filter((f) => f.kind === "env-drift")).toEqual([]);
    } finally {
      repo.rm();
    }
  });

  test("gitignore negation re-includes an explicitly kept path", async () => {
    const repo = makeRepo();
    try {
      const wt = repo.addWorktree("lane", { branch: "lane" });
      writeIn(repo, wt, ".deepsec/.env.drop.json", "A=1\nB=2\n");
      writeIn(repo, wt, ".deepsec/.env.keep.json", "A=1\nB=2\n");
      const env = configEnv([".deepsec/.env.drop.json", "!.deepsec/.env.keep.json"]);
      const result = await runSafetyPipeline(wt, repo.dir, { env });
      const details = result.flags.filter((f) => f.kind === "env-drift").map((f) => f.detail);
      expect(details.some((d) => d.includes(".env.drop.json"))).toBe(false);
      expect(details.some((d) => d.includes(".env.keep.json"))).toBe(true);
    } finally {
      repo.rm();
    }
  });

  test("provenance-backed candidates honor sync.exclude too", async () => {
    const repo = makeRepo();
    try {
      const wt = repo.addWorktree("lane", { branch: "lane" });
      markerFiles(wt, repo, [".env", ".deepsec/.env.json"]);
      writeIn(repo, wt, ".env", "A=1\nB=2\n");
      writeIn(repo, wt, ".deepsec/.env.json", "A=1\nB=2\n");
      const result = await runSafetyPipeline(wt, repo.dir, { env: configEnv([".deepsec"]) });
      const details = result.flags.filter((f) => f.kind === "env-drift").map((f) => f.detail);
      expect(details.some((d) => d.startsWith(".env: "))).toBe(true);
      expect(details.some((d) => d.includes(".deepsec/"))).toBe(false);
    } finally {
      repo.rm();
    }
  });
});
