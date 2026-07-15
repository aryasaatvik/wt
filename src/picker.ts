// Interactive `wt ls` picker (TTY only), following lsdev's opentui pattern.
//
// Keys: j/k or arrows move (shift = fast) · x remove (y/N confirm, runs the
//       safety pipeline) · o open in editor · enter print path and exit
//       · v toggle verdicts · r rescan · q quit
//
// `x` rather than `d`/`k`: matching lsdev, a destructive action should not
// sit on a vim movement key.

import type { CliRenderer, TextRenderable as TextRenderableT } from "@opentui/core";
import { basename } from "node:path";
import { resolvePrimaryRepo } from "./git.ts";
import {
  aheadBehindLabel,
  branchLabel,
  dirtyLabel,
  humanAge,
  humanSize,
  prLabel,
  withVerdicts,
  type LsRecord,
} from "./ls.ts";
import { scanWorktrees } from "./scan.ts";
import { runSafetyPipeline } from "./safety.ts";
import { pad, runAsync } from "./term.ts";

export interface PickerOptions {
  cwd: string;
  verdicts?: boolean;
}

export async function runPicker(opts: PickerOptions): Promise<void> {
  // Imported lazily so table/JSON paths never pay for opentui.
  const { createCliRenderer, TextRenderable, ScrollBoxRenderable, StyledText, fg, bg, bold: b } =
    await import("@opentui/core");

  // Same palette as lsdev's TUI.
  const GREEN = "#4ade80", YELLOW = "#facc15", CYAN = "#67e8f9", RED = "#f87171";
  const TEXT = "#d1d5db", BRIGHT = "#e5e7eb", MUTED = "#6b7280", SEL_BG = "#1f2937";

  const repoRoot = resolvePrimaryRepo(opts.cwd);
  let showVerdicts = Boolean(opts.verdicts);
  let records: LsRecord[] = [];
  let selectedIndex = 0;
  let status = "";
  let pending: LsRecord | null = null;
  let busy = false;

  const renderer: CliRenderer = await createCliRenderer();

  const header = new TextRenderable(renderer, { id: "header", content: "", flexShrink: 0 });
  const colhead = new TextRenderable(renderer, { id: "colhead", content: "", fg: MUTED, flexShrink: 0 });
  const scroll = new ScrollBoxRenderable(renderer, { id: "list", flexGrow: 1, flexShrink: 1, minHeight: 3 });
  const detail = new TextRenderable(renderer, { id: "detail", content: "", fg: MUTED, flexShrink: 0 });
  const footer = new TextRenderable(renderer, { id: "footer", content: "", fg: MUTED, flexShrink: 0 });
  renderer.root.add(header);
  renderer.root.add(colhead);
  renderer.root.add(scroll);
  renderer.root.add(detail);
  renderer.root.add(footer);
  const rowTexts: TextRenderableT[] = [];

  function widths() {
    const w = {
      slug: 8,
      branch: 6,
      dirty: 5,
      ab: 2,
      pr: 2,
      size: 4,
      age: 3,
      verdict: 7,
    };
    for (const r of records) {
      w.slug = Math.max(w.slug, r.slug.length + (r.primary ? 10 : 0));
      w.branch = Math.max(w.branch, branchLabel(r).length);
      w.dirty = Math.max(w.dirty, dirtyLabel(r).length);
      w.ab = Math.max(w.ab, aheadBehindLabel(r).length);
      w.pr = Math.max(w.pr, prLabel(r).length);
      w.size = Math.max(w.size, humanSize(r.sizeKb).length);
      w.age = Math.max(w.age, humanAge(r.lastCommitAt).length);
      w.verdict = Math.max(w.verdict, (r.verdict ?? "-").length);
    }
    return w;
  }

  function rowLine(r: LsRecord, w: ReturnType<typeof widths>, sel: boolean) {
    const S = (s: string, color: string, isBold = false) => {
      const ch = fg(color)(isBold ? b(s) : s);
      return sel ? bg(SEL_BG)(ch) : ch;
    };
    const chunks = [
      S(sel ? " ▸ " : "   ", CYAN),
      S("● ", r.dirty ? RED : r.detached ? YELLOW : GREEN),
      S(pad(r.primary ? `${r.slug} (primary)` : r.slug, w.slug), BRIGHT, true),
      S("  " + pad(branchLabel(r), w.branch), r.detached ? YELLOW : TEXT),
      S("  " + pad(dirtyLabel(r), w.dirty), r.dirty ? RED : MUTED),
      S("  " + pad(aheadBehindLabel(r), w.ab), TEXT),
      S("  " + pad(prLabel(r), w.pr), r.prState === "open" ? CYAN : r.prState === "merged" ? GREEN : MUTED),
      S("  " + pad(humanSize(r.sizeKb), w.size), TEXT),
      S("  " + pad(humanAge(r.lastCommitAt), w.age), MUTED),
    ];
    if (showVerdicts) chunks.push(S("  " + pad(r.verdict ?? "-", w.verdict), MUTED));
    if (sel) {
      const used = chunks.reduce((n, ch) => n + ch.text.length, 0);
      if (used < renderer.terminalWidth) chunks.push(S(" ".repeat(renderer.terminalWidth - used), TEXT));
    }
    return new StyledText(chunks);
  }

  function paint() {
    header.content = new StyledText([
      fg(BRIGHT)(b(`\n  wt · ${basename(repoRoot)}`)),
      fg(MUTED)(`   ${records.length} worktree(s)${showVerdicts ? " · verdicts" : ""}\n`),
    ]);
    const w = widths();
    colhead.content =
      `     ${pad("WORKTREE", w.slug)}  ${pad("BRANCH", w.branch)}  ${pad("DIRTY", w.dirty)}  ` +
      `${pad("±", w.ab)}  ${pad("PR", w.pr)}  ${pad("SIZE", w.size)}  ${pad("AGE", w.age)}` +
      (showVerdicts ? `  ${pad("VERDICT", w.verdict)}` : "");

    while (rowTexts.length < Math.max(records.length, 1)) {
      const tr = new TextRenderable(renderer, { id: `row-${rowTexts.length}`, height: 1, flexShrink: 0 });
      rowTexts.push(tr);
      scroll.add(tr);
    }
    while (rowTexts.length > Math.max(records.length, 1)) {
      const tr = rowTexts.pop()!;
      scroll.content.remove(tr);
      tr.destroy();
    }
    if (records.length) {
      records.forEach((r, i) => (rowTexts[i]!.content = rowLine(r, w, i === selectedIndex)));
    } else {
      rowTexts[0]!.content = new StyledText([fg(MUTED)("   no worktrees")]);
    }

    const vh = Math.max(1, scroll.viewport.height || 1);
    if (selectedIndex < scroll.scrollTop) scroll.scrollTop = selectedIndex;
    else if (selectedIndex >= scroll.scrollTop + vh) scroll.scrollTop = selectedIndex - vh + 1;

    const sel = records[selectedIndex];
    detail.content = sel ? `\n  ${sel.path}` : "";

    if (pending) {
      footer.content = `\n  remove ${pending.slug}? runs safety pipeline first  [y/N]\n`;
    } else {
      footer.content =
        `\n  j/k move · x remove · o editor · enter path · v verdicts · r rescan · q quit` +
        `${status ? "    " + status : ""}\n`;
    }
  }

  async function refresh(keepIndex = true) {
    const idx = keepIndex ? selectedIndex : 0;
    busy = true;
    status = "scanning…";
    paint();
    let rs: LsRecord[] = await scanWorktrees(repoRoot);
    if (showVerdicts) rs = await withVerdicts(rs);
    records = rs;
    selectedIndex = records.length ? Math.min(idx, records.length - 1) : 0;
    busy = false;
    status = "";
    paint();
  }

  function quit(printPath?: string): never {
    renderer.stop();
    renderer.destroy();
    if (printPath) console.log(printPath);
    process.exit(0);
  }

  async function removeSelected(r: LsRecord) {
    busy = true;
    status = `checking ${r.slug}…`;
    paint();
    const safety = await runSafetyPipeline(r.path, repoRoot);
    if (!safety.ok) {
      const first = safety.flags[0]!;
      const more = safety.flags.length > 1 ? ` (+${safety.flags.length - 1} more)` : "";
      busy = false;
      status = `skipped ${r.slug}: [${first.kind}] ${first.detail}${more}`;
      paint();
      return;
    }
    const rm = await runAsync(["git", "-C", repoRoot, "worktree", "remove", r.path]);
    if (!rm.ok) {
      busy = false;
      status = `failed: ${rm.stderr.trim().split("\n")[0] ?? "git worktree remove error"}`;
      paint();
      return;
    }
    const salvage = safety.salvaged.length ? ` · salvaged ${safety.salvaged.length} note(s)` : "";
    status = `removed ${r.slug}${salvage}`;
    await refresh();
  }

  renderer.keyInput.on("keypress", (key) => {
    if (pending) {
      // Confirmation is modal: anything that isn't an explicit yes cancels.
      const row = pending;
      pending = null;
      if (key.name === "y") void removeSelected(row);
      else {
        status = "cancelled";
        paint();
      }
      return;
    }

    if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) quit();
    if (busy) return;

    const row = records[selectedIndex] ?? null;
    const move = (delta: number) => {
      if (!records.length) return;
      const next = Math.max(0, Math.min(records.length - 1, selectedIndex + delta));
      if (next === selectedIndex) return;
      selectedIndex = next;
      status = "";
      paint();
    };

    switch (key.name) {
      case "j":
      case "down":
        move(key.shift ? 5 : 1);
        return;
      case "k":
      case "up":
        move(key.shift ? -5 : -1);
        return;
      case "g":
        move(key.shift ? records.length : -records.length);
        return;
      case "x":
        if (!row) return;
        if (row.primary) {
          status = "refusing: that is the primary checkout";
          paint();
          return;
        }
        pending = row;
        paint();
        return;
      case "o":
        if (row) {
          const editor = process.env.EDITOR || process.env.VISUAL || "code";
          Bun.spawn([editor, row.path], { stdout: "ignore", stderr: "ignore" });
          status = `opened ${row.slug} in ${basename(editor)}`;
          paint();
        }
        return;
      case "return":
      case "enter":
        if (row) quit(row.path);
        return;
      case "v":
        showVerdicts = !showVerdicts;
        void refresh();
        return;
      case "r":
        void refresh();
        return;
    }
  });

  await refresh(false);
}
