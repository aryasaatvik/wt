import { dlopen, read } from "bun:ffi";
import { accessSync, closeSync, constants as fsConstants, fstatSync, realpathSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

interface TrackedFile {
  path: string;
  symlink: boolean;
}

export type ClonePlan = { files: TrackedFile[] } | { reason: string };

const CONVERSION_ATTRIBUTES = new Set([
  "filter",
  "text",
  "crlf",
  "eol",
  "ident",
  "working-tree-encoding",
]);

async function git(dir: string, args: string[], stdin?: Buffer, attrSource?: string) {
  const process = Bun.spawn(["git", "-C", dir, ...args], {
    stdin,
    stdout: "pipe",
    stderr: "pipe",
    env: attrSource ? { ...Bun.env, GIT_ATTR_SOURCE: attrSource } : undefined,
  });
  const [stdout, stderr, code] = await Promise.all([
    process.stdout.bytes(),
    process.stderr.text(),
    process.exited,
  ]);
  return { stdout: Buffer.from(stdout), stderr, code };
}

export async function planClone(
  primary: string,
  head: string,
  flags: string[],
  platform = process.platform,
): Promise<ClonePlan> {
  if (platform !== "darwin") return { reason: "APFS cloning requires macOS" };
  if (flags.length) return { reason: "extra Git worktree flags" };
  if (process.umask() & 0o500) return { reason: "umask masks owner read or execute bits" };
  if (
    ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_ATTR_SOURCE"].some(
      (key) => Bun.env[key] !== undefined,
    )
  )
    return { reason: "Git environment overrides the checkout" };

  // worktree add discovers hooks in the creating checkout, then executes them
  // in the new worktree. Leave real hooks to Git so discovery and failure match.
  const [hooks, tree] = await Promise.all([
    git(primary, ["hook", "list", "-z", "post-checkout"]),
    git(primary, ["ls-tree", "-rz", "--full-tree", head]),
  ]);
  if (tree.code) return { reason: "could not inspect target tree" };
  if (!hooks.stdout.length && (hooks.code === 1 || hooks.code === 129)) {
    // Exit 1 can mean either an empty list or a Git version without the hook
    // command. Both need the executable check in the effective hooks dir.
    const hook = await git(primary, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "hooks/post-checkout",
    ]);
    if (hook.code) return { reason: "could not inspect Git post-checkout hook" };
    try {
      accessSync(hook.stdout.toString().replace(/\n$/, ""), fsConstants.X_OK);
      return { reason: "Git post-checkout hook" };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error.code !== "ENOENT" && error.code !== "ENOTDIR" && error.code !== "EACCES")
      ) {
        return { reason: "could not inspect Git post-checkout hook" };
      }
    }
  } else if (hooks.code !== 0 || !hooks.stdout.length) {
    return { reason: "could not inspect Git post-checkout hook" };
  } else if (hooks.stdout.length) {
    const entries = hooks.stdout.toString().split("\0").filter(Boolean);
    if (entries.some((entry) => !entry.startsWith("disabled\t"))) {
      return { reason: "Git post-checkout hook" };
    }
    // A configured hook name can itself contain a tab. Check the ambiguous
    // names so Git's display prefix cannot hide an actual enabled hook.
    const names = await git(primary, [
      "config",
      "--null",
      "--name-only",
      "--get-regexp",
      "^hook\\..*\\.event$",
    ]);
    if (names.code !== 0 && names.code !== 1)
      return { reason: "could not inspect Git post-checkout hook" };
    const keys = new Set(names.stdout.toString().split("\0"));
    if (entries.some((entry) => keys.has(`hook.${entry}.event`))) {
      return { reason: "Git post-checkout hook" };
    }
  }

  const listing = tree.stdout.toString();
  if (!tree.stdout.equals(Buffer.from(listing))) return { reason: "tracked paths are not UTF-8" };
  const files: TrackedFile[] = [];
  const spellings = new Map<string, string>();
  for (const entry of listing.split("\0")) {
    if (!entry) continue;
    const mode = entry.slice(0, 6);
    if (mode === "160000") return { reason: "target tree contains gitlinks" };
    if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
      return { reason: "unsupported tracked file mode" };
    }
    const path = entry.slice(entry.indexOf("\t") + 1);
    let prefix = "";
    for (const part of path.split("/")) {
      if (!part || part === "." || part === ".." || part.toLowerCase() === ".git") {
        return { reason: "unsupported tracked path" };
      }
      prefix += "/" + part;
      const folded = prefix.normalize("NFD").toLowerCase();
      const spelling = spellings.get(folded);
      if (spelling && spelling !== prefix) return { reason: "tracked path spellings may collide" };
      spellings.set(folded, prefix);
    }
    files.push({ path, symlink: mode === "120000" });
  }
  return { files };
}

export async function cloneCheckoutReason(
  lane: string,
  head: string,
  files: TrackedFile[],
): Promise<string | undefined> {
  const paths = Buffer.from(files.map(({ path }) => path + "\0").join(""));
  const [config, root, attributes] = await Promise.all([
    git(lane, [
      "config",
      "--null",
      "--get-regexp",
      "^core\\.(sparsecheckout|autocrlf|symlinks|protecthfs)$",
    ]),
    git(lane, ["rev-parse", "--show-toplevel"]),
    git(lane, ["check-attr", "--source", head, "-a", "-z", "--stdin"], paths),
  ]);
  if (root.code || root.stdout.toString() !== realpathSync.native(lane) + "\n") {
    return "Git is configured to use a different worktree root";
  }
  if (config.code !== 0 && config.code !== 1) return "could not inspect worktree Git config";
  // A valueless Git boolean is true. The last value wins for repeated keys.
  const settings = new Map(
    config.stdout
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const newline = entry.indexOf("\n");
        return newline < 0 ? [entry, "true"] : [entry.slice(0, newline), entry.slice(newline + 1)];
      }),
  );
  const isFalse = (value: string) => /^(?:|0|no|off|false)$/i.test(value);
  if (!isFalse(settings.get("core.sparsecheckout") ?? "false")) return "sparse checkout";
  if (!isFalse(settings.get("core.autocrlf") ?? "false")) return "core.autocrlf conversion";
  if (isFalse(settings.get("core.symlinks") ?? "true") && files.some(({ symlink }) => symlink)) {
    return "core.symlinks is disabled for tracked symlinks";
  }
  if (isFalse(settings.get("core.protecthfs") ?? "true"))
    return "Git macOS path protection is disabled";
  if (attributes.code) return "could not inspect target Git attributes";
  const fields = attributes.stdout.toString().split("\0");
  for (let i = 1; i < fields.length; i += 3) {
    if (CONVERSION_ATTRIBUTES.has(fields[i]!)) return `Git checkout attribute: ${fields[i]}`;
  }
}

export async function checkoutWithGit(lane: string): Promise<void> {
  // On a freshly registered lane, read-tree uses Git's checkout machinery
  // and refuses to overwrite a file that appeared since registration.
  const result = await git(lane, [
    `--work-tree=${lane}`,
    "-c",
    "submodule.recurse=false",
    "read-tree",
    "-m",
    "-u",
    "HEAD",
  ]);
  if (result.code) throw new Error(`Git checkout failed: ${result.stderr.trim()}`);
}

interface CloneBatch {
  kind: "wt-clone-checkout";
  primary: string;
  lane: string;
  files: TrackedFile[];
  stop: Int32Array<SharedArrayBuffer>;
  umask: number;
}

const DARWIN = {
  directory: 0x00100000,
  symlink: 0x00200000,
  noFollowAny: 0x20000000,
  nonblock: 0x00000004,
  cloneNoFollow: 0x0001,
  cloneNoOwnerCopy: 0x0002,
  fileFlags: 0x00040000,
  compressed: 0x00000020,
};

function cString(path: string): Buffer {
  return Buffer.from(path + "\0");
}

function cloneBatch({ primary, lane, files, stop, umask }: CloneBatch): number {
  const native = dlopen("/usr/lib/libSystem.B.dylib", {
    open: { args: ["ptr", "int"], returns: "int" },
    openat: { args: ["int", "ptr", "int"], returns: "int" },
    mkdirat: { args: ["int", "ptr", "u32"], returns: "int" },
    fclonefileat: { args: ["int", "int", "ptr", "u32"], returns: "int" },
    flistxattr: { args: ["int", "ptr", "usize", "int"], returns: "i64" },
    fgetattrlist: { args: ["int", "ptr", "ptr", "usize", "u32"], returns: "int" },
    __error: { args: [], returns: "ptr" },
  });
  const { open, openat, mkdirat, fclonefileat, flistxattr, fgetattrlist, __error } = native.symbols;
  const directory = DARWIN.directory | DARWIN.noFollowAny;
  const root = open(cString(lane), directory);
  let source = -1;
  let target = -1;
  let parent: string | undefined;
  let cloned = 0;
  // struct attrlist: five u32 bitmaps following bitmapcount (u16) and reserved (u16).
  const attrs = new Uint32Array([5, DARWIN.fileFlags, 0, 0, 0, 0]);
  const flags = new Uint32Array(2);
  const provenance = cString("com.apple.provenance");
  const xattrs = Buffer.alloc(provenance.length);
  try {
    if (root < 0) throw new Error(`could not open new worktree directory: ${lane}`);
    for (const file of files) {
      if (Atomics.load(stop, 0)) break;
      const name = basename(file.path);
      // Keep the lane's attribute rules under Git's control throughout verification.
      if (name.toLowerCase() === ".gitattributes") continue;
      const dir = dirname(file.path);
      if (dir !== parent) {
        if (source >= 0) closeSync(source);
        if (target >= 0 && target !== root) closeSync(target);
        parent = dir;
        source = open(cString(`${primary}/${dir}`), directory);
        target = -1;
        if (source < 0) continue;
        // Walk from a directory descriptor so a symlink can never redirect mkdir or cloning.
        let current = root;
        for (const component of dir === "." ? [] : dir.split("/")) {
          const path = cString(component);
          mkdirat(current, path, 0o777);
          const next = openat(current, path, directory);
          if (current !== root) closeSync(current);
          current = next;
          if (current < 0) break;
        }
        // Keep the root open across batches of files in different directories.
        target = current;
      }
      if (source < 0 || target < 0) continue;

      const leaf = cString(name);
      // Pin the exact entry before checking its type. clonefile can otherwise
      // recursively clone a directory swapped in between the check and the call.
      const fd = openat(source, leaf, DARWIN.symlink | DARWIN.nonblock);
      if (fd < 0) continue;
      try {
        const stat = fstatSync(fd);
        if (file.symlink ? !stat.isSymbolicLink() : !stat.isFile()) continue;
        if (!file.symlink) {
          const gitMode = (stat.mode & 0o100 ? 0o777 : 0o666) & ~umask;
          if ((stat.mode & 0o7777) !== gitMode) continue;
        }
        // clonefile copies metadata that Git would never take from the primary.
        // macOS adds provenance to newly created files as well, including Git checkouts.
        const xattrSize = Number(flistxattr(fd, xattrs, xattrs.length, 0));
        if (xattrSize !== 0 && (xattrSize !== provenance.length || !xattrs.equals(provenance)))
          continue;
        if (fgetattrlist(fd, attrs, flags, flags.byteLength, 0) !== 0) continue;
        if (flags[1]! & ~DARWIN.compressed) continue;

        if (fclonefileat(fd, target, leaf, DARWIN.cloneNoFollow | DARWIN.cloneNoOwnerCopy) === 0) {
          cloned++;
        } else {
          const errno = read.i32(__error()!);
          if (errno === constants.errno.EXDEV || errno === constants.errno.ENOTSUP) {
            Atomics.compareExchange(stop, 0, 0, errno);
            break;
          }
        }
      } finally {
        closeSync(fd);
      }
    }
    return cloned;
  } finally {
    if (source >= 0) closeSync(source);
    if (target >= 0 && target !== root) closeSync(target);
    if (root >= 0) closeSync(root);
    native.close();
  }
}

if (!isMainThread && workerData?.kind === "wt-clone-checkout") {
  const batch: CloneBatch = workerData;
  parentPort?.postMessage(cloneBatch(batch));
  // In a compiled executable the worker enters through the bundled CLI module.
  // Exit the worker before evaluation can reach the command dispatcher.
  process.exit(0);
}

export interface CheckoutRecord {
  mode: "clone" | "git";
  cloned: number;
  rewritten: number;
  reason?: string;
}

export async function checkoutClone(
  primary: string,
  lane: string,
  head: string,
  files: TrackedFile[],
  record: CheckoutRecord,
): Promise<void> {
  const destination = realpathSync.native(lane);
  const rev = await git(lane, ["rev-parse", "--show-toplevel", "HEAD"]);
  if (rev.code || rev.stdout.toString() !== `${destination}\n${head}\n`) {
    throw new Error("worktree root or HEAD changed during creation");
  }

  // Read a fresh index with no stat cache. Git must compare even same-size files
  // with matching mtimes, and an executable bit remains significant here.
  const verify = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.ignoreStat=false",
    "-c",
    "core.filemode=true",
    "-c",
    "core.trustctime=true",
    "-c",
    "core.checkStat=default",
    "-c",
    "core.protectHFS=true",
  ];
  const readTree = await git(lane, [...verify, "read-tree", head]);
  if (readTree.code) throw new Error(`git read-tree failed: ${readTree.stderr.trim()}`);

  const stop = new Int32Array(new SharedArrayBuffer(4));
  const chunkSize = Math.max(256, Math.ceil(files.length / 8));
  const batches: Promise<number>[] = [];
  for (let i = 0; i < files.length; i += chunkSize) {
    const batch: CloneBatch = {
      kind: "wt-clone-checkout",
      primary,
      lane: destination,
      files: files.slice(i, i + chunkSize),
      stop,
      umask: process.umask(),
    };
    batches.push(
      new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: batch });
        let cloned: number | undefined;
        let failure: unknown;
        worker.on("message", (count: number) => {
          cloned = count;
        });
        worker.on("error", (error) => {
          failure = error;
        });
        worker.on("exit", (code) => {
          if (!failure && code === 0 && cloned !== undefined) resolve(cloned);
          else reject(failure ?? new Error(`APFS clone worker exited with code ${code}`));
        });
      }),
    );
  }
  const results = await Promise.allSettled(batches);
  for (const result of results) {
    if (result.status === "fulfilled") record.cloned += result.value;
    else record.reason = `APFS clone worker unavailable: ${String(result.reason)}`;
  }
  const errno = Atomics.load(stop, 0);
  if (errno)
    record.reason =
      errno === constants.errno.EXDEV
        ? "source and destination are on different volumes"
        : "volume does not support APFS cloning";

  const diff = async () => {
    const result = await git(
      lane,
      [...verify, "diff-files", "-z", "--name-only", "--"],
      undefined,
      head,
    );
    if (result.code) throw new Error(`git diff-files failed: ${result.stderr.trim()}`);
    return result.stdout;
  };
  const refresh = await git(lane, [...verify, "update-index", "-q", "--refresh"], undefined, head);
  // Git returns 1 for paths that need updating, which diff-files enumerates.
  if ((refresh.code !== 0 && refresh.code !== 1) || refresh.stderr) {
    throw new Error(`git update-index --refresh failed: ${refresh.stderr.trim()}`);
  }
  const mismatches = await diff();
  if (mismatches.length) {
    const rewritten = await git(
      lane,
      [...verify, "checkout-index", "-f", "-u", "-z", "--stdin"],
      mismatches,
      head,
    );
    if (rewritten.code || rewritten.stderr) {
      throw new Error(`git checkout-index failed: ${rewritten.stderr.trim()}`);
    }
    record.rewritten = mismatches.reduce((count, byte) => count + Number(byte === 0), 0);
    if ((await diff()).length) throw new Error("tracked files still differ after checkout");
  }
  const verifiedHead = await git(lane, ["rev-parse", "HEAD"]);
  if (verifiedHead.code || verifiedHead.stdout.toString().trim() !== head) {
    throw new Error("worktree HEAD changed during checkout");
  }
}
