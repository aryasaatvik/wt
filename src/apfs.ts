import { dlopen, FFIType, read } from "bun:ffi";
import { closeSync, constants as fs, lstatSync, openSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { constants } from "node:os";

const ATTR_CMN_RETURNED_ATTRS = 0x80000000;
const ATTR_CMN_ERROR = 0x20000000;
const ATTR_CMN_NAME = 0x00000001;
const ATTR_CMN_OBJTYPE = 0x00000008;
const ATTR_CMN_FSID = 0x00000004;
const ATTR_CMN_FILEID = 0x02000000;
const ATTR_VOL_INFO = 0x80000000;
const ATTR_VOL_FSTYPENAME = 0x00100000;
const ATTR_DIR_ALLOCSIZE = 0x00000008;
const ATTR_FILE_LINKCOUNT = 0x00000001;
const ATTR_FILE_ALLOCSIZE = 0x00000004;
const ATTR_CMNEXT_PRIVATESIZE = 0x00000008;
const FSOPT_NOFOLLOW = 0x01;
const FSOPT_ATTR_CMN_EXTENDED = 0x20;
const VREG = 1;
const VDIR = 2;

export interface ApfsUsage {
  privateBytes: number;
  allocatedBytes: number;
}

function attributes(
  common: number,
  volume: number,
  dir: number,
  file: number,
  extended: number,
): Uint8Array {
  // Darwin's struct attrlist uses five 32-bit attribute groups after the header.
  const list = new Uint8Array(24);
  const view = new DataView(list.buffer);
  view.setUint16(0, 5, true);
  view.setUint32(4, common, true);
  view.setUint32(8, volume, true);
  view.setUint32(12, dir, true);
  view.setUint32(16, file, true);
  view.setUint32(20, extended, true);
  return list;
}

function openLibSystem() {
  try {
    return dlopen("/usr/lib/libSystem.B.dylib", {
      __error: { args: [], returns: FFIType.ptr },
      getattrlistbulk: {
        args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
      getattrlist: {
        args: [FFIType.cstring, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32],
        returns: FFIType.i32,
      },
    });
  } catch {
    return null;
  }
}

/** Returns null when Darwin cannot supply both sizes for the tree. */
export function scanApfsUsage(
  root: string,
  excludedPaths: ReadonlySet<string> = new Set(),
): ApfsUsage | null {
  if (process.platform !== "darwin" || !lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    return null;
  }
  const lib = openLibSystem();
  if (!lib) return null;

  try {
    const { getattrlist, getattrlistbulk, __error } = lib.symbols;
    // errno is thread-local and must be checked immediately after a failed syscall.
    const errno = __error();
    if (!errno) return null;
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    const volume = attributes(0, ATTR_VOL_INFO | ATTR_VOL_FSTYPENAME, 0, 0, 0);
    const volumeBuffer = new Uint8Array(64);
    if (
      getattrlist(
        Buffer.from(root + "\0"),
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
      decoder.decode(volumeBuffer.subarray(nameStart, nameStart + nameLength)) !== "apfs\0"
    ) {
      return null;
    }

    const common =
      ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_NAME | ATTR_CMN_FSID | ATTR_CMN_OBJTYPE | ATTR_CMN_FILEID;
    const file = ATTR_FILE_LINKCOUNT | ATTR_FILE_ALLOCSIZE;
    const requested = attributes(
      common | ATTR_CMN_ERROR,
      0,
      ATTR_DIR_ALLOCSIZE,
      file,
      ATTR_CMNEXT_PRIVATESIZE,
    );
    const buffer = new Uint8Array(64 * 1024);
    const view = new DataView(buffer.buffer);
    const exclusions = new Map<string, Set<string>>();
    for (const path of excludedPaths) {
      const parent = dirname(path);
      let names = exclusions.get(parent);
      if (!names) exclusions.set(parent, (names = new Set()));
      names.add(basename(path));
    }

    const hardLinks = new Map<bigint, Set<bigint>>();
    const pending = [root];
    let privateBytes = 0;
    let allocatedBytes = 0;
    let dir: string | undefined;
    while ((dir = pending.pop()) !== undefined) {
      let fd: number;
      try {
        fd = openSync(dir, fs.O_RDONLY | fs.O_DIRECTORY | fs.O_NOFOLLOW);
      } catch (error) {
        if (error instanceof Error && "code" in error) {
          if (error.code === "ENOENT") continue;
          // The entry was replaced with a different type after enumeration.
          if (error.code === "ENOTDIR" || error.code === "ELOOP") continue;
        }
        throw error;
      }

      try {
        const excluded = exclusions.get(dir);
        let count: number;
        while (
          (count = getattrlistbulk(fd, requested, buffer, buffer.length, FSOPT_ATTR_CMN_EXTENDED)) >
          0
        ) {
          let offset = 0;
          for (let i = 0; i < count; i++) {
            const start = offset;
            if (start + 24 > buffer.length) return null;
            const length = view.getUint32(start, true);
            offset += length;
            if (length < 24 || offset > buffer.length) return null;

            // Each record begins with its length, attribute_set_t, and optional errno.
            const returned = view.getUint32(start + 4, true);
            let field = start + 24;
            if (returned & ATTR_CMN_ERROR) {
              if (field + 4 > offset) return null;
              const error = view.getUint32(field, true);
              if (error === constants.errno.ENOENT) continue;
              if (error !== 0) return null;
              field += 4;
            }
            // The fixed common fields are name reference, fsid, type, and file ID.
            if ((returned & common) >>> 0 !== common >>> 0 || field + 28 > offset) return null;
            const type = view.getUint32(field + 16, true);
            let name = "";
            if (type === VDIR || excluded) {
              const nameStart = field + view.getInt32(field, true);
              const nameLength = view.getUint32(field + 4, true);
              if (nameStart < field + 28 || nameLength < 1 || nameStart + nameLength > offset)
                return null;
              name = decoder.decode(buffer.subarray(nameStart, nameStart + nameLength - 1));
              if (excluded?.has(name)) continue;
            }
            if (type === VDIR) {
              if ((view.getUint32(start + 12, true) & ATTR_DIR_ALLOCSIZE) !== 0) {
                if (field + 36 > offset) return null;
                allocatedBytes += Number(view.getBigInt64(field + 28, true));
              }
              pending.push(join(dir, name));
              continue;
            }

            // File fields follow the common fields in link count, allocation, private size order.
            const hasPrivateSize =
              (view.getUint32(start + 20, true) & ATTR_CMNEXT_PRIVATESIZE) !== 0;
            if ((view.getUint32(start + 16, true) & file) !== file || field + 40 > offset)
              return null;
            if (type === VREG && (!hasPrivateSize || field + 48 > offset)) return null;
            if (view.getUint32(field + 28, true) > 1) {
              const fsid = view.getBigUint64(field + 8, true);
              const fileId = view.getBigUint64(field + 20, true);
              let seen = hardLinks.get(fsid);
              if (seen?.has(fileId)) continue;
              if (!seen) hardLinks.set(fsid, (seen = new Set()));
              seen.add(fileId);
            }
            allocatedBytes += Number(view.getBigInt64(field + 32, true));
            if (type === VREG) privateBytes += Number(view.getBigInt64(field + 40, true));
          }
        }
        if (count < 0 && read.i32(errno) !== constants.errno.ENOENT) return null;
      } finally {
        closeSync(fd);
      }
    }
    return { privateBytes, allocatedBytes };
  } finally {
    lib.close();
  }
}
