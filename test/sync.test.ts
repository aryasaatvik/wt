import { describe, expect, test } from "bun:test";
import { isExcluded } from "../src/sync.ts";
import { slugFor } from "../src/create.ts";

describe("slugFor", () => {
  test("replaces every slash with a dash", () => {
    expect(slugFor("x/my-feature")).toBe("x-my-feature");
    expect(slugFor("feat/a/b")).toBe("feat-a-b");
    expect(slugFor("plain")).toBe("plain");
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

  test("keeps the files wt exists to sync", () => {
    expect(isExcluded(".env")).toBe(false);
    expect(isExcluded("apps/api/.env.local")).toBe(false);
    expect(isExcluded(".dev.vars")).toBe(false);
    expect(isExcluded(".scratchpad/notes.md")).toBe(false);
    expect(isExcluded(".vscode/settings.json")).toBe(false);
  });
});
