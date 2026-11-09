import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdRm } from "../src/rm.ts";
import {
  mcpWorkspaceKey,
  planXcodeOutputs,
  readWorkspacePath,
  readXcodeEnabled,
  removeXcodeOutputs,
  type Activity,
  type XcodeEnv,
} from "../src/xcode.ts";
import { makeRepo } from "./harness.ts";

const idle = async (): Promise<Activity> => ({ openFiles: [], processes: [] });

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A build folder with an Xcode-style XML info.plist. */
function buildFolder(dir: string, workspacePath: string): string {
  mkdirSync(join(dir, "Build", "Products"), { recursive: true });
  writeFileSync(join(dir, "Build", "Products", "App.o"), "object\n");
  writeFileSync(
    join(dir, "info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>LastAccessedDate</key>
\t<date>2026-11-09T18:57:34Z</date>
\t<key>WorkspacePath</key>
\t<string>${escapeXml(workspacePath)}</string>
</dict>
</plist>
`,
  );
  return dir;
}

/** An XcodeBuildMCP workspace with the MCP's usual layout and these builds. */
function mcpWorkspace(library: string, name: string, builds: string[] = []): string {
  const dir = join(library, "XcodeBuildMCP", "workspaces", name);
  for (const sub of ["locks", "logs", "result-bundles", "state", "test-products"])
    mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, "logs", "build.log"), "log\n");
  builds.forEach((source, i) => buildFolder(join(dir, "DerivedData", `App${i}-abc${i}`), source));
  return dir;
}

function xcodeDerived(library: string, name: string, source: string): string {
  return buildFolder(join(library, "Xcode", "DerivedData", name), source);
}

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "wt-xcode-")));
  const library = join(root, "Library", "Developer");
  const lane = join(root, "repo-worktrees", "pip-lane");
  mkdirSync(lane, { recursive: true });
  const env: XcodeEnv = { platform: "darwin", libraryRoot: library, activity: idle };
  return {
    root,
    library,
    lane,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("mcpWorkspaceKey", () => {
  test("matches XcodeBuildMCP's slug and sha256 prefix", () => {
    // Observed on a real machine for this checkout path.
    expect(
      mcpWorkspaceKey(
        "/Users/aryasaatvik/Developer/grand-prix-worktrees/pip-city-comet-polish-review",
      ),
    ).toBe("pip-city-comet-polish-review-2631b337090c");
    expect(mcpWorkspaceKey("/x/Turbo Lanes")).toMatch(/^Turbo-Lanes-[0-9a-f]{12}$/);
    expect(mcpWorkspaceKey("/x/.hidden")).toMatch(/^hidden-[0-9a-f]{12}$/);
  });
});

describe("readWorkspacePath", () => {
  test("decodes XML entities and ignores relative or missing paths", () => {
    const f = fixture();
    try {
      const folder = buildFolder(join(f.root, "dd"), "/a/R&D <x>/App.xcodeproj");
      expect(readWorkspacePath(folder)).toBe("/a/R&D <x>/App.xcodeproj");
      buildFolder(folder, "relative/App.xcodeproj");
      expect(readWorkspacePath(folder)).toBeNull();
      expect(readWorkspacePath(join(f.root, "missing"))).toBeNull();
    } finally {
      f.cleanup();
    }
  });
});

describe("planXcodeOutputs", () => {
  test("selects only outputs owned by the worktree", async () => {
    const f = fixture();
    try {
      const inLane = (rel: string) => join(f.lane, rel);
      const elsewhere = join(f.root, "repo", "App", "App.xcodeproj");
      const ownKey = mcpWorkspaceKey(f.lane);
      // Exact key and builds inside the lane: the whole workspace goes.
      const keyed = mcpWorkspace(f.library, ownKey, [inLane("Turbo Lanes/Turbo Lanes.xcodeproj")]);
      // Root unknown (no ancestor hashes to it), every build in the lane.
      const evidence = mcpWorkspace(f.library, "tools-000000000000", [inLane("App.xcworkspace")]);
      // Same directory name, different root, no builds: never a name-only match.
      const sameName = mcpWorkspace(f.library, mcpWorkspaceKey(join(f.root, "other", "pip-lane")));
      // Workspace of the primary that once built a lane project: only that build.
      const primaryRoot = join(f.root, "repo");
      const primary = mcpWorkspace(f.library, mcpWorkspaceKey(primaryRoot), [
        elsewhere,
        inLane("App/App.xcodeproj"),
      ]);
      // Prefix trap: a sibling whose path starts with the lane's.
      const sibling = mcpWorkspace(f.library, "pip-lane-2-111111111111", [
        join(f.root, "repo-worktrees", "pip-lane-2", "App.xcodeproj"),
      ]);
      const xcodeOwn = xcodeDerived(f.library, "App-aaaa", inLane("App/App.xcodeproj"));
      const xcodeOther = xcodeDerived(f.library, "App-bbbb", elsewhere);
      const noMeta = join(f.library, "Xcode", "DerivedData", "App-cccc");
      mkdirSync(noMeta, { recursive: true });

      const plan = await planXcodeOutputs(f.lane, f.env);
      expect(plan.skipped).toEqual([]);
      expect(plan.outputs.map((o) => [o.kind, o.path]).sort()).toEqual(
        [
          ["workspace", keyed],
          ["workspace", evidence],
          ["derived-data", join(primary, "DerivedData", "App1-abc1")],
          ["derived-data", xcodeOwn],
        ].sort(),
      );
      expect(plan.outputs.every((o) => (o.kb ?? 0) > 0)).toBe(true);
      for (const kept of [sameName, sibling, xcodeOther, noMeta, primary])
        expect(plan.outputs.some((o) => o.path === kept)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  test("finds the lane's workspace by key when it has no build folders", async () => {
    const f = fixture();
    try {
      const keyed = mcpWorkspace(f.library, mcpWorkspaceKey(f.lane));
      const renamed = join(f.library, "MobileBuildMCP", "workspaces");
      mkdirSync(renamed, { recursive: true });
      const plan = await planXcodeOutputs(f.lane, f.env);
      expect(plan.outputs.map((o) => o.path)).toEqual([keyed]);
    } finally {
      f.cleanup();
    }
  });

  test("keeps a keyed workspace that also built a project outside the lane", async () => {
    const f = fixture();
    try {
      const keyed = mcpWorkspace(f.library, mcpWorkspaceKey(f.lane), [
        join(f.lane, "App.xcodeproj"),
        join(f.root, "elsewhere", "Lib.xcodeproj"),
      ]);
      const plan = await planXcodeOutputs(f.lane, f.env);
      expect(plan.outputs.map((o) => o.path)).toEqual([join(keyed, "DerivedData", "App0-abc0")]);
    } finally {
      f.cleanup();
    }
  });

  test("never follows symlinks", async () => {
    const f = fixture();
    try {
      const outside = buildFolder(join(f.root, "outside"), join(f.lane, "App.xcodeproj"));
      mkdirSync(join(f.library, "Xcode", "DerivedData"), { recursive: true });
      symlinkSync(outside, join(f.library, "Xcode", "DerivedData", "App-link"));
      const workspaces = join(f.library, "XcodeBuildMCP", "workspaces");
      mkdirSync(workspaces, { recursive: true });
      const linked = join(workspaces, mcpWorkspaceKey(f.lane));
      symlinkSync(join(f.root, "outside"), linked);
      const plan = await planXcodeOutputs(f.lane, f.env);
      expect(plan.outputs).toEqual([]);
      expect(plan.skipped).toEqual([{ path: linked, reason: "symlink, not followed" }]);
    } finally {
      f.cleanup();
    }
  });

  test("does nothing off macOS or without the directories", async () => {
    const f = fixture();
    try {
      mcpWorkspace(f.library, mcpWorkspaceKey(f.lane), [join(f.lane, "App.xcodeproj")]);
      expect(await planXcodeOutputs(f.lane, { ...f.env, platform: "linux" })).toEqual({
        outputs: [],
        skipped: [],
      });
      expect(
        await planXcodeOutputs(f.lane, { ...f.env, libraryRoot: join(f.root, "absent") }),
      ).toEqual({ outputs: [], skipped: [] });
    } finally {
      f.cleanup();
    }
  });

  test("reports an unreadable library instead of throwing", async () => {
    const f = fixture();
    const workspaces = join(f.library, "XcodeBuildMCP", "workspaces");
    try {
      mkdirSync(workspaces, { recursive: true });
      chmodSync(workspaces, 0o000);
      const plan = await planXcodeOutputs(f.lane, f.env);
      expect(plan.outputs).toEqual([]);
      expect(plan.skipped[0]?.reason).toStartWith("cannot scan:");
    } finally {
      chmodSync(workspaces, 0o755);
      f.cleanup();
    }
  });

  test("previews busy outputs as skipped", async () => {
    const f = fixture();
    try {
      const open = mcpWorkspace(f.library, mcpWorkspaceKey(f.lane));
      const building = xcodeDerived(f.library, "App-aaaa", join(f.lane, "App.xcodeproj"));
      const activity = async (): Promise<Activity> => ({
        openFiles: [{ pid: 7, path: join(open, "logs", "build.log") }],
        processes: [{ pid: 9, command: `/usr/bin/xcodebuild -project ${f.lane}/App.xcodeproj` }],
      });
      const plan = await planXcodeOutputs(f.lane, { ...f.env, activity }, { checkActivity: true });
      expect(plan.outputs).toEqual([]);
      expect(plan.skipped.map((s) => [s.path, s.reason]).sort()).toEqual(
        [
          [open, `open file ${join(open, "logs", "build.log")} (pid 7)`],
          [building, "running xcodebuild (pid 9) references the worktree"],
        ].sort(),
      );
    } finally {
      f.cleanup();
    }
  });
});

describe("removeXcodeOutputs", () => {
  test("removes idle outputs without following symlinks inside them", async () => {
    const f = fixture();
    try {
      const keyed = mcpWorkspace(f.library, mcpWorkspaceKey(f.lane), [
        join(f.lane, "App.xcodeproj"),
      ]);
      const precious = join(f.root, "precious");
      mkdirSync(precious);
      writeFileSync(join(precious, "keep.txt"), "keep\n");
      symlinkSync(precious, join(keyed, "test-products", "link"));
      const plan = await planXcodeOutputs(f.lane, f.env);
      const result = await removeXcodeOutputs(plan, [f.lane], f.env);
      expect(result.removed.map((o) => o.path)).toEqual([keyed]);
      expect(result.skipped).toEqual([]);
      expect(existsSync(keyed)).toBe(false);
      expect(existsSync(join(precious, "keep.txt"))).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  test("keeps outputs that became busy, unverifiable, or replaced", async () => {
    const f = fixture();
    try {
      const keyed = mcpWorkspace(f.library, mcpWorkspaceKey(f.lane));
      const own = xcodeDerived(f.library, "App-aaaa", join(f.lane, "App.xcodeproj"));
      const plan = await planXcodeOutputs(f.lane, f.env);
      expect(plan.outputs).toHaveLength(2);

      const blind = await removeXcodeOutputs(plan, [f.lane], {
        ...f.env,
        activity: async () => ({ openFiles: null, processes: [] }),
      });
      expect(blind.removed).toEqual([]);
      expect(blind.skipped.map((s) => s.reason)).toEqual([
        "cannot list open files (lsof unavailable)",
        "cannot list open files (lsof unavailable)",
      ]);

      renameSync(own, `${own}.old`);
      buildFolder(own, join(f.lane, "App.xcodeproj"));
      const swiftc = async (): Promise<Activity> => ({
        openFiles: [],
        processes: [
          { pid: 3, command: `swift-frontend -frontend -c ${keyed}/DerivedData/x.swift` },
        ],
      });
      const result = await removeXcodeOutputs(plan, [f.lane], { ...f.env, activity: swiftc });
      expect(result.removed).toEqual([]);
      expect(result.skipped.map((s) => [s.path, s.reason]).sort()).toEqual(
        [
          [keyed, "running swift-frontend (pid 3) references the worktree"],
          [own, "changed since planning"],
        ].sort(),
      );
      expect(existsSync(keyed) && existsSync(own)).toBe(true);
    } finally {
      f.cleanup();
    }
  });
});

describe("readXcodeEnabled", () => {
  test("reads [remove] xcode and defaults to enabled", () => {
    const f = fixture();
    try {
      const env = { XDG_CONFIG_HOME: f.root };
      expect(readXcodeEnabled(env)).toBe(true);
      mkdirSync(join(f.root, "wt"));
      writeFileSync(join(f.root, "wt", "config.toml"), "[remove]\nxcode = false\n");
      expect(readXcodeEnabled(env)).toBe(false);
      writeFileSync(join(f.root, "wt", "config.toml"), '[remove]\nxcode = "no"\n');
      expect(() => readXcodeEnabled(env)).toThrow("remove.xcode must be a boolean");
    } finally {
      f.cleanup();
    }
  });
});

describe("wt rm with Xcode outputs", () => {
  function captureOutput<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
    const lines: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    console.error = console.log;
    return fn()
      .then((result) => ({ out: lines.join("\n"), result }))
      .finally(() => {
        console.log = log;
        console.error = error;
      });
  }

  test("--dry-run lists outputs and sizes; removal deletes them with the lane", async () => {
    const repo = makeRepo();
    const f = fixture();
    try {
      const wt = repo.addWorktree("pip-lane", { branch: "pip/lane" });
      const keyed = mcpWorkspace(f.library, mcpWorkspaceKey(wt), [join(wt, "App.xcodeproj")]);
      const own = xcodeDerived(f.library, "App-aaaa", join(wt, "App.xcodeproj"));
      const other = xcodeDerived(f.library, "App-bbbb", join(repo.dir, "App.xcodeproj"));

      const dry = await captureOutput(() =>
        cmdRm("pip/lane", { deleteBranch: false, cwd: repo.dir, dryRun: true, xcode: f.env }),
      );
      expect(dry.out).toContain("Would remove worktree");
      expect(dry.out).toContain("Would remove Xcode build outputs");
      expect(dry.out).toContain(keyed);
      expect(dry.out).toContain(own);
      expect(dry.out).not.toContain(other);
      expect(existsSync(wt) && existsSync(keyed) && existsSync(own)).toBe(true);

      const real = await captureOutput(() =>
        cmdRm("pip/lane", { deleteBranch: false, cwd: repo.dir, xcode: f.env }),
      );
      expect(real.out).toContain("Removed Xcode build outputs");
      expect(existsSync(wt) || existsSync(keyed) || existsSync(own)).toBe(false);
      expect(existsSync(other)).toBe(true);
    } finally {
      repo.rm();
      f.cleanup();
    }
  });

  test("opt-out keeps outputs", async () => {
    const repo = makeRepo();
    const f = fixture();
    try {
      const wt = repo.addWorktree("pip-lane", { branch: "pip/lane" });
      const keyed = mcpWorkspace(f.library, mcpWorkspaceKey(wt), [join(wt, "App.xcodeproj")]);
      // The test preload sets [remove] xcode = false, so the default reads it.
      await captureOutput(() => cmdRm("pip/lane", { deleteBranch: false, cwd: repo.dir }));
      expect(existsSync(wt)).toBe(false);
      expect(existsSync(keyed)).toBe(true);
    } finally {
      repo.rm();
      f.cleanup();
    }
  });
});
