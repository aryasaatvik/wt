import { expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measurePrivateBytes } from "../src/apfs-measure.ts";
import { privateBytes } from "../src/apfs.ts";

const apfsTempDir =
  process.platform === "darwin" && Bun.spawnSync(["/bin/df", "-T", "apfs", tmpdir()]).success;

test.skipIf(!apfsTempDir)("counts APFS private bytes and deduplicates hard links", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wt-apfs-"));
  const lib = dlopen("/usr/lib/libSystem.B.dylib", {
    clonefile: {
      args: [FFIType.cstring, FFIType.cstring, FFIType.i32],
      returns: FFIType.i32,
    },
  });

  try {
    const checkout = join(directory, "checkout");
    mkdirSync(checkout);
    mkdirSync(join(checkout, "nested"));
    const size = 128 * 1024;
    const original = join(directory, "original");
    const clone = join(checkout, "clone");
    const copy = join(checkout, "copy");
    const encoder = new TextEncoder();
    writeFileSync(original, Buffer.alloc(size, 1));
    expect(
      lib.symbols.clonefile(encoder.encode(original + "\0"), encoder.encode(clone + "\0"), 0),
    ).toBe(0);
    symlinkSync(directory, join(checkout, "external"));
    expect(privateBytes(checkout)).toBe(0);

    copyFileSync(original, copy);
    linkSync(copy, join(checkout, "nested", "hard-link"));
    expect(await measurePrivateBytes(checkout, [])).toBe(size);
    expect(privateBytes(checkout, new Set([join(checkout, "nested"), copy]))).toBe(0);
  } finally {
    lib.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
