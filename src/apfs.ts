import { dlopen, FFIType, read } from "bun:ffi";
import { type Dirent, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { constants } from "node:os";

const ATTR_CMN_RETURNED_ATTRS = 0x80000000;
const ATTR_CMN_FSID = 0x00000004;
const ATTR_CMN_FILEID = 0x02000000;
const ATTR_VOL_INFO = 0x80000000;
const ATTR_VOL_FSTYPENAME = 0x00100000;
const ATTR_FILE_LINKCOUNT = 0x00000001;
const ATTR_CMNEXT_PRIVATESIZE = 0x00000008;
const FSOPT_NOFOLLOW = 0x01;
const FSOPT_ATTR_CMN_EXTENDED = 0x20;

function attributes(common: number, volume: number, file: number, extended: number): Uint8Array {
  // Darwin's struct attrlist uses five 32-bit attribute groups after the header.
  const list = new Uint8Array(24);
  const view = new DataView(list.buffer);
  view.setUint16(0, 5, true);
  view.setUint32(4, common, true);
  view.setUint32(8, volume, true);
  view.setUint32(16, file, true);
  view.setUint32(20, extended, true);
  return list;
}

function openLibSystem() {
  try {
    return dlopen("/usr/lib/libSystem.B.dylib", {
      __error: { args: [], returns: FFIType.ptr },
      getattrlist: {
        args: [FFIType.cstring, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32],
        returns: FFIType.i32,
      },
    });
  } catch {
    return null;
  }
}

/** Returns null when Darwin cannot supply private bytes for the whole tree. */
export function privateBytes(
  root: string,
  excludedPaths: ReadonlySet<string> = new Set(),
): number | null {
  if (process.platform !== "darwin" || !lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    return null;
  }
  const lib = openLibSystem();
  if (!lib) return null;

  try {
    const { getattrlist, __error } = lib.symbols;
    // errno is thread-local and must be checked immediately after a failed syscall.
    const errno = __error();
    if (!errno) return null;
    const encoder = new TextEncoder();
    const volume = attributes(0, ATTR_VOL_INFO | ATTR_VOL_FSTYPENAME, 0, 0);
    const volumeBuffer = new Uint8Array(64);
    if (
      getattrlist(
        encoder.encode(root + "\0"),
        volume,
        volumeBuffer,
        volumeBuffer.length,
        FSOPT_NOFOLLOW,
      ) !== 0
    ) {
      return null;
    }
    // A volume string is an attrreference_t after the four-byte record length.
    const volumeView = new DataView(volumeBuffer.buffer);
    const nameStart = 4 + volumeView.getInt32(4, true);
    const nameLength = volumeView.getUint32(8, true);
    if (
      nameLength !== 5 ||
      new TextDecoder().decode(volumeBuffer.subarray(nameStart, nameStart + nameLength)) !==
        "apfs\0"
    ) {
      return null;
    }

    const common = ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_FSID | ATTR_CMN_FILEID;
    const requested = attributes(common, 0, ATTR_FILE_LINKCOUNT, ATTR_CMNEXT_PRIVATESIZE);
    // Length, returned attribute set, fsid, file ID, link count, private bytes.
    const buffer = new Uint8Array(52);
    const view = new DataView(buffer.buffer);
    const options = FSOPT_NOFOLLOW | FSOPT_ATTR_CMN_EXTENDED;
    const hardLinks = new Map<bigint, Set<bigint>>();
    const pending = [root];
    let bytes = 0;
    let dir: string | undefined;
    while ((dir = pending.pop()) !== undefined) {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (excludedPaths.has(path)) continue;
        if (entry.isDirectory()) {
          pending.push(path);
        } else if (entry.isFile()) {
          if (
            getattrlist(encoder.encode(path + "\0"), requested, buffer, buffer.length, options) !==
            0
          ) {
            if (read.i32(errno) === constants.errno.ENOENT) continue;
            return null;
          }
          if (
            (view.getUint32(4, true) & common) >>> 0 !== common >>> 0 ||
            (view.getUint32(16, true) & ATTR_FILE_LINKCOUNT) === 0 ||
            (view.getUint32(20, true) & ATTR_CMNEXT_PRIVATESIZE) === 0
          ) {
            return null;
          }
          if (view.getUint32(40, true) > 1) {
            const fsid = view.getBigUint64(24, true);
            const fileId = view.getBigUint64(32, true);
            let seen = hardLinks.get(fsid);
            if (seen?.has(fileId)) continue;
            if (!seen) hardLinks.set(fsid, (seen = new Set()));
            seen.add(fileId);
          }
          bytes += Number(view.getBigInt64(44, true));
        }
      }
    }
    return bytes;
  } finally {
    lib.close();
  }
}
