import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { originDefault } from "../src/git.ts";
import { pickPr, prForCommit, prStateFor, remoteRepos, scanWorktrees, type PrInfo } from "../src/scan.ts";
import { makeRepo } from "./harness.ts";

describe("prStateFor", () => {
  const prs: PrInfo[] = [
    { headRefName: "feat/a", state: "OPEN", number: 12 },
    { headRefName: "feat/b", state: "MERGED", number: 8 },
    { headRefName: "feat/c", state: "CLOSED", number: 5 },
  ];
  const listing = { prs, complete: true };

  test("maps gh states and misses", () => {
    expect(prStateFor("feat/a", listing)).toEqual({ prState: "open", prNumber: 12 });
    expect(prStateFor("feat/b", listing)).toEqual({ prState: "merged", prNumber: 8 });
    expect(prStateFor("feat/c", listing)).toEqual({ prState: "closed", prNumber: 5 });
    expect(prStateFor("feat/none", listing)).toEqual({ prState: "none", prNumber: null });
    expect(prStateFor(null, listing)).toEqual({ prState: "none", prNumber: null });
  });

  test("degrades to unknown when gh data is unavailable", () => {
    expect(prStateFor("feat/a", null)).toEqual({ prState: "unknown", prNumber: null });
  });

  test("a miss in a truncated listing is unknown, not none", () => {
    expect(prStateFor("feat/none", { prs, complete: false })).toEqual({
      prState: "unknown",
      prNumber: null,
    });
    expect(prStateFor("feat/a", { prs, complete: false })).toEqual({ prState: "open", prNumber: 12 });
  });
});

describe("pickPr", () => {
  test("open outranks merged outranks closed", () => {
    expect(pickPr([{ prState: "merged", prNumber: 1 }, { prState: "open", prNumber: 2 }])).toEqual({
      prState: "open",
      prNumber: 2,
    });
    expect(pickPr([{ prState: "closed", prNumber: 3 }, { prState: "merged", prNumber: 4 }])).toEqual({
      prState: "merged",
      prNumber: 4,
    });
    expect(pickPr([])).toBeNull();
  });
});

describe("remoteRepos", () => {
  test("parses GitHub remotes, origin first, and skips non-GitHub ones", async () => {
    const repo = makeRepo();
    try {
      repo.git("remote", "add", "upstream", "https://github.com/acme/widgets.git");
      repo.git("remote", "add", "origin", "git@github.com:me/widgets.git");
      repo.git("remote", "add", "mirror", "https://git.example.com/me/widgets.git");
      expect(await remoteRepos(repo.dir)).toEqual([
        { name: "origin", nwo: "me/widgets" },
        { name: "upstream", nwo: "acme/widgets" },
      ]);
    } finally {
      repo.rm();
    }
  });
});

describe("prForCommit", () => {
  test("keeps the result unknown when any remote lookup fails", async () => {
    const repo = makeRepo();
    try {
      const bin = join(repo.root, "bin");
      mkdirSync(bin);
      const gh = join(bin, "gh");
      writeFileSync(
        gh,
        `#!/bin/sh
case "$2" in
  repos/acme/widgets/*) printf '4\\tmerged\\n' ;;
  *) exit 1 ;;
esac
`,
      );
      chmodSync(gh, 0o755);
      expect(
        await prForCommit(
          [
            { name: "origin", nwo: "acme/widgets" },
            { name: "backup", nwo: "me/widgets" },
          ],
          "abc123",
          { PATH: `${bin}:/usr/bin:/bin` },
        ),
      ).toEqual({ prState: "unknown", prNumber: null });
    } finally {
      repo.rm();
    }
  });
});

describe("scanWorktrees", () => {
  const cache = (ownedKb: number, measuredAt = new Date().toISOString()) => JSON.stringify({
    version: 2,
    measuredAt,
    usage: { checkoutKb: ownedKb, privateGitKb: 0, ownedKb, sharedKb: 1 },
  });
  test("probes dirty, detached, ahead/behind, size, and age", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      expect(originDefault(repo.dir)).toBe("main");
      const firstHead = repo.git("rev-parse", "HEAD").trim();

      // ahead lane: branch worktree with one unpushed commit
      const aheadWt = repo.addWorktree("feat-ahead", { branch: "feat/ahead" });
      repo.gitIn(aheadWt, "commit", "--allow-empty", "-m", "ahead commit");

      // advance main on origin, then a detached lane pinned at the old head is behind
      repo.git("commit", "--allow-empty", "-m", "main moves on");
      repo.git("push", "origin", "main");
      const behindWt = repo.addWorktree("lane-behind", { detachAt: firstHead });

      // dirty lane
      const dirtyWt = repo.addWorktree("feat-dirty", { branch: "feat/dirty" });
      await Bun.write(`${dirtyWt}/junk.txt`, "dirty\n");

      const records = await scanWorktrees(repo.dir);
      const by = (slug: string) => records.find((r) => r.slug === slug)!;

      expect(records.find((r) => r.primary)?.path).toBe(repo.dir);

      const ahead = by("feat-ahead");
      expect(ahead.branch).toBe("feat/ahead");
      expect(ahead.compareRef).toBe("origin/main");
      expect(ahead.ahead).toBe(1);
      expect(ahead.dirty).toBe(false);

      const behind = by("lane-behind");
      expect(behind.detached).toBe(true);
      expect(behind.branch).toBeNull();
      expect(behind.behind).toBeGreaterThanOrEqual(1);
      expect(behind.ahead).toBe(0);

      const dirty = by("feat-dirty");
      expect(dirty.dirty).toBe(true);
      expect(dirty.dirtyCount).toBe(1);

      for (const r of records) {
        expect(r.sizeKb).toBeGreaterThan(0);
        expect(r.lastCommitAt).toBeTruthy();
        // fixture origin is a local bare repo: gh has no GitHub remote to
        // query, so PR state must degrade to "unknown", never throw
        expect(r.prState).toBe("unknown");
      }
    } finally {
      repo.rm();
    }
  });

  test("caches sizes in each worktree's gitdir and reuses fresh entries", async () => {
    const repo = makeRepo();
    try {
      const lane = repo.addWorktree("lane", { branch: "lane" });
      const cachePathFor = (dir: string) =>
        join(repo.gitIn(dir, "rev-parse", "--absolute-git-dir").trim(), "wt-size.json");

      // first scan measures and writes the cache
      const first = await scanWorktrees(repo.dir);
      for (const r of first) {
        expect(r.sizeCached).toBe(false);
        expect(r.sizeKb).toBeGreaterThan(0);
      }
      const primaryCache = cachePathFor(repo.dir);
      const laneCache = cachePathFor(lane);
      expect(primaryCache).toContain("/.git/wt-size.json");
      expect(laneCache).toContain("/.git/worktrees/");
      expect(existsSync(primaryCache)).toBe(true);
      expect(existsSync(laneCache)).toBe(true);

      // a fresh cache entry is served as-is — seed a sentinel value to prove it
      writeFileSync(laneCache, cache(424242));
      const second = await scanWorktrees(repo.dir);
      const cached = second.find((r) => r.slug === "lane")!;
      expect(cached.sizeKb).toBe(424242);
      expect(cached.sizeCached).toBe(true);

      // One corrupt cache does not invalidate a different lane's valid cache.
      writeFileSync(primaryCache, "not json{");
      const mixed = await scanWorktrees(repo.dir);
      const stillCached = mixed.find((r) => r.slug === "lane")!;
      expect(stillCached.sizeKb).toBe(424242);
      expect(stillCached.sizeCached).toBe(true);

      // --fresh ignores a valid cache and rewrites it
      const forced = await scanWorktrees(repo.dir, { sizeMode: "fresh" });
      const remeasured = forced.find((r) => r.slug === "lane")!;
      expect(remeasured.sizeCached).toBe(false);
      expect(remeasured.sizeKb).not.toBe(424242);
      expect(JSON.parse(readFileSync(laneCache, "utf8")).usage.ownedKb).not.toBe(424242);
    } finally {
      repo.rm();
    }
  });

  test("expired and corrupt cache entries are remeasured, skip mode measures nothing", async () => {
    const repo = makeRepo();
    try {
      const lane = repo.addWorktree("lane", { branch: "lane" });
      const laneCache = join(repo.gitIn(lane, "rev-parse", "--absolute-git-dir").trim(), "wt-size.json");

      // entry older than the 24h TTL — remeasure and refresh the file
      const stale = new Date(Date.now() - 25 * 3600_000).toISOString();
      writeFileSync(laneCache, cache(424242, stale));
      const afterStale = (await scanWorktrees(repo.dir)).find((r) => r.slug === "lane")!;
      expect(afterStale.sizeCached).toBe(false);
      expect(afterStale.sizeKb).not.toBe(424242);

      // future-dated entry (clock jumped backward) counts as stale, not
      // perpetually fresh
      const future = new Date(Date.now() + 3600_000).toISOString();
      writeFileSync(laneCache, cache(424242, future));
      const afterFuture = (await scanWorktrees(repo.dir)).find((r) => r.slug === "lane")!;
      expect(afterFuture.sizeCached).toBe(false);
      expect(afterFuture.sizeKb).not.toBe(424242);

      // corrupt cache must degrade to a fresh du, never throw
      writeFileSync(laneCache, "not json{");
      const afterCorrupt = (await scanWorktrees(repo.dir)).find((r) => r.slug === "lane")!;
      expect(afterCorrupt.sizeCached).toBe(false);
      expect(afterCorrupt.sizeKb).toBeGreaterThan(0);

      // skip mode: no size, and the (now valid) cache file is left untouched
      writeFileSync(laneCache, cache(424242));
      const skipped = (await scanWorktrees(repo.dir, { sizeMode: "skip" })).find((r) => r.slug === "lane")!;
      expect(skipped.sizeKb).toBeNull();
      expect(skipped.sizeCached).toBe(false);
      expect(JSON.parse(readFileSync(laneCache, "utf8")).usage.ownedKb).toBe(424242);
    } finally {
      repo.rm();
    }
  });

  test("degrades PR state to unknown when gh is not on PATH", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      const records = await scanWorktrees(repo.dir, { env: { PATH: "/usr/bin:/bin" } });
      expect(records[0]?.prState).toBe("unknown");
    } finally {
      repo.rm();
    }
  });

  test("resolves a truncated branch-list miss by commit", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      repo.git("remote", "set-url", "origin", "https://github.com/acme/widgets.git");
      const lane = repo.addWorktree("feat-live", { branch: "feat/live" });
      repo.gitIn(lane, "commit", "--allow-empty", "-m", "live work");

      const bin = join(repo.root, "bin");
      mkdirSync(bin);
      const gh = join(bin, "gh");
      writeFileSync(
        gh,
        `#!/bin/sh
if [ "$1" = "pr" ]; then
  printf '['
  i=1
  while [ "$i" -le 1000 ]; do
    [ "$i" -gt 1 ] && printf ','
    printf '{"headRefName":"archive/%s","state":"CLOSED","number":%s}' "$i" "$i"
    i=$((i + 1))
  done
  printf ']\\n'
else
  printf '42\\topen\\n'
fi
`,
      );
      chmodSync(gh, 0o755);

      const records = await scanWorktrees(repo.dir, {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        sizeMode: "skip",
      });
      const live = records.find((r) => r.slug === "feat-live");
      expect(live?.prState).toBe("open");
      expect(live?.prNumber).toBe(42);
    } finally {
      repo.rm();
    }
  });

  test("an open PR on another remote outranks an origin branch match", async () => {
    const repo = makeRepo();
    try {
      repo.addOrigin();
      repo.git("remote", "set-url", "origin", "https://github.com/acme/widgets.git");
      repo.git("remote", "add", "backup", "https://github.com/me/widgets.git");
      const lane = repo.addWorktree("feat-live", { branch: "feat/live" });
      repo.gitIn(lane, "commit", "--allow-empty", "-m", "live work");

      const bin = join(repo.root, "bin");
      mkdirSync(bin);
      const gh = join(bin, "gh");
      writeFileSync(
        gh,
        `#!/bin/sh
if [ "$1" = "pr" ]; then
  printf '[{"headRefName":"feat/live","state":"MERGED","number":4}]\\n'
elif echo "$2" | grep -q 'repos/acme/widgets/'; then
  printf '4\\tmerged\\n'
else
  printf '9\\topen\\n'
fi
`,
      );
      chmodSync(gh, 0o755);

      const records = await scanWorktrees(repo.dir, {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        sizeMode: "skip",
      });
      const live = records.find((r) => r.slug === "feat-live");
      expect(live?.prState).toBe("open");
      expect(live?.prNumber).toBe(9);
    } finally {
      repo.rm();
    }
  });
});
