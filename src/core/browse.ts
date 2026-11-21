import { promises as fsp } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { CategoryId, Root } from "./categories";
import { isWhole, type Usage } from "./classify";
import { dust, dustBytes, folderSize, type Children, type DustNode, type Item } from "./scan";

/**
 * A running listing or culprit search.
 */
export interface ListHandle {
  cancel(): void;
}

/**
 * Folder sizes measured on the way to a culprit. Opening one of those folders
 * later reuses them instead of measuring again, so diving in is instant.
 */
const known = new Map<string, number>();

/**
 * Drops remembered sizes for a path, everything inside it, and every folder above it.
 */
export function forgetSizes(path: string): void {
  for (const key of known.keys()) {
    if (key === path || key.startsWith(path + "/") || path.startsWith(key + "/")) known.delete(key);
  }
}

/**
 * Drops every remembered size, before a rescan.
 */
export function forgetAllSizes(): void {
  known.clear();
}

/**
 * Signature of a folder lister, so the UI can be driven by fakes in tests.
 */
export type ListFolder = (
  path: string,
  onUpdate: (items: Item[], done: boolean, current: string) => void,
) => ListHandle;

/**
 * Measures everything directly inside a folder: loose files straight away,
 * subfolders with dust, a few at a time. Calls back with the list so far,
 * largest first, and once more with done = true.
 */
export function listFolder(
  path: string,
  onUpdate: (items: Item[], done: boolean, current: string) => void,
): ListHandle {
  const children: Children = new Set();
  let cancelled = false;
  const items: Item[] = [];
  const sorted = () => [...items].sort((a, b) => b.size - a.size);

  const run = async () => {
    let entries;
    try {
      entries = await fsp.readdir(path, { withFileTypes: true });
    } catch {
      if (!cancelled) onUpdate([], true, "");
      return;
    }
    const folders: string[] = [];
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        folders.push(child);
        continue;
      }
      try {
        const stat = await fsp.lstat(child);
        items.push({ path: child, size: stat.blocks * 512, dir: false });
      } catch {
        // vanished
      }
    }
    if (cancelled) return;
    onUpdate(sorted(), folders.length === 0, folders[0] ?? "");

    let next = 0;
    const worker = async () => {
      while (!cancelled && next < folders.length) {
        const folder = folders[next++];
        if (!folder) return;
        const bytes = known.get(folder) ?? (await folderSize(folder, children)).bytes;
        if (cancelled) return;
        items.push({ path: folder, size: bytes, dir: true });
        onUpdate(sorted(), false, folder);
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (!cancelled) onUpdate(sorted(), true, "");
  };
  void run();

  return {
    cancel() {
      cancelled = true;
      for (const child of children) child.kill();
    },
  };
}

// ---- culprits -------------------------------------------------------------

/**
 * Where the space inside a folder is.
 */
export interface Culprit {
  /**
   * Folders, then maybe one file, each holding most of the one before it. Empty when the space is spread out.
   */
  chain: Item[];
  /**
   * The biggest things directly inside, for when no single one dominates.
   */
  top: Item[];
}

/**
 * Signature of a culprit finder, so the UI can be driven by fakes in tests.
 */
export type FindCulprit = (path: string, onDone: (culprit: Culprit) => void) => ListHandle;

/**
 * A child holding at least this share of its parent counts as "where the space is".
 */
const DOMINANT = 0.5;
const DEPTH = 12;

async function looseFiles(path: string): Promise<Item[]> {
  let entries;
  try {
    entries = await fsp.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: Item[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    try {
      const stat = await fsp.lstat(join(path, entry.name));
      files.push({ path: join(path, entry.name), size: stat.blocks * 512, dir: false });
    } catch {
      // vanished
    }
  }
  return files.sort((a, b) => b.size - a.size);
}

/**
 * Builds a culprit from dust's folder sizes: follows the biggest child down for as
 * long as it holds most of its parent.
 */
export function culpritFrom(
  path: string,
  sizes: Map<string, number>,
): { chain: Item[]; bottom: string; bottomSize: number; kids: Map<string, Item[]> } {
  const kids = new Map<string, Item[]>();
  for (const [dir, bytes] of sizes) {
    if (dir === path) continue;
    const parent = dirname(dir);
    const list = kids.get(parent) ?? [];
    list.push({ path: dir, size: bytes, dir: true });
    kids.set(parent, list);
  }
  const chain: Item[] = [];
  let current = path;
  let currentSize = sizes.get(path) ?? 0;
  for (let depth = 0; depth < DEPTH; depth++) {
    const best = (kids.get(current) ?? []).reduce<Item | null>(
      (a, b) => (!a || b.size > a.size ? b : a),
      null,
    );
    if (!best || best.size < currentSize * DOMINANT) break;
    chain.push(best);
    current = best.path;
    currentSize = best.size;
    if (isWhole(best.path)) break;
  }
  return { chain, bottom: current, bottomSize: currentSize, kids };
}

/**
 * Finds where the space inside a folder actually is: measures every subfolder
 * in one dust walk, then follows the biggest child down.
 */
export function findCulprit(path: string, onDone: (culprit: Culprit) => void): ListHandle {
  let cancelled = false;
  const children: Children = new Set();

  const run = async () => {
    // Folders only (-D), up to DEPTH levels down; dust keeps the biggest entries.
    const { tree } = await dust(path, ["-D", "-d", String(DEPTH), "-n", "2000"], children);
    if (cancelled) return;
    const sizes = new Map<string, number>();
    const visit = (node: DustNode) => {
      sizes.set(node.name, dustBytes(node.size));
      node.children.forEach(visit);
    };
    if (tree) visit(tree);
    for (const [dir, bytes] of sizes) known.set(dir, bytes);

    const { chain, bottom, bottomSize, kids } = culpritFrom(path, sizes);
    // A single huge file at the bottom (a video, a disk image) is the real answer.
    const last = chain[chain.length - 1];
    if (!last || !isWhole(last.path)) {
      const biggestFile = (await looseFiles(bottom))[0];
      if (biggestFile && biggestFile.size >= bottomSize * DOMINANT) chain.push(biggestFile);
    }
    const top = [...(kids.get(path) ?? []), ...(await looseFiles(path))]
      .sort((a, b) => b.size - a.size)
      .slice(0, 3);
    if (!cancelled) onDone({ chain, top });
  };
  void run();

  return {
    cancel() {
      cancelled = true;
      for (const child of children) child.kill();
    },
  };
}

// ---- when things were last used --------------------------------------------

/**
 * Signature of a usage lookup, so the UI can be driven by fakes in tests.
 */
export type LookUpUsage = (paths: string[]) => Promise<Map<string, Usage>>;

/**
 * Parses an mdls date ("2024-03-02 13:37:29 +0000"), or NaN.
 */
export function parseMdlsDate(value: string | undefined): number {
  if (!value || value === "(null)") return Number.NaN;
  return Date.parse(value.replace(" +0000", "Z").replace(" ", "T"));
}

/**
 * Last-opened dates from Spotlight where it has one (apps, documents, media),
 * otherwise the modification time.
 */
export async function usage(paths: string[]): Promise<Map<string, Usage>> {
  const result = new Map<string, Usage>();
  for (let i = 0; i < paths.length; i += 40) {
    const batch = paths.slice(i, i + 40);
    let opened: string[] = [];
    try {
      const proc = Bun.spawn(["mdls", "-raw", "-name", "kMDItemLastUsedDate", ...batch], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const values = (await new Response(proc.stdout).text()).split("\0");
      await proc.exited;
      if (values.length === batch.length) opened = values;
    } catch {
      // no Spotlight; fall back to modification times
    }
    for (let j = 0; j < batch.length; j++) {
      const path = batch[j];
      if (!path) continue;
      const at = parseMdlsDate(opened[j]);
      if (Number.isFinite(at)) {
        result.set(path, { at, kind: "opened" });
        continue;
      }
      try {
        const stat = await fsp.stat(path);
        result.set(path, { at: stat.mtimeMs, kind: "changed" });
      } catch {
        // vanished
      }
    }
  }
  return result;
}

// ---- acting on one item -------------------------------------------------

/**
 * Folders whose removal would break macOS or the user's account, whatever is inside.
 */
function protectedPaths(roots: Root[], home: string): Set<string> {
  const lib = (name: string) => join(home, "Library", name);
  return new Set(
    [
      ...roots.map((r) => r.path),
      "/",
      home,
      "/System",
      "/Library",
      "/usr",
      "/usr/local/bin",
      "/usr/local/lib",
      "/opt/homebrew/bin",
      "/opt/homebrew/lib",
      join(home, "Library"),
      lib("Keychains"),
      lib("Preferences"),
      lib("Mail"),
      lib("Messages"),
      lib("Accounts"),
      lib("Cookies"),
      lib("Calendars"),
      lib("Safari"),
      lib("Photos"),
      lib("Biome"),
    ].map((p) => resolve(p)),
  );
}

/**
 * Why an item cannot be removed, or null when it can.
 */
export function cannotRemove(path: string, roots: Root[], home: string): string | null {
  if (!path.startsWith("/")) return "Not a real path.";
  const target = resolve(path);
  if (protectedPaths(roots, home).has(target)) return "macOS or your account needs this folder.";
  if (target.startsWith("/System/") || target.startsWith("/private/")) return "macOS manages this.";
  const inRoots = roots.some((root) => target.startsWith(resolve(root.path) + sep));
  if (!inRoots) return "Outside the folders this tool looks at.";
  return null;
}

/**
 * True when the item lives where permanent deletion is fine: caches and the Trash.
 */
export function deletesForGood(category: CategoryId): boolean {
  return category === "caches" || category === "trash";
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(err.trim() || `${cmd[0]} exited with ${code}`);
}

/**
 * Moves a file or folder to the Trash, where it can be put back from Finder,
 * and returns roughly where it went.
 */
export async function moveToTrash(path: string, home: string): Promise<string> {
  const hasTrash = await fsp.access("/usr/bin/trash").then(
    () => true,
    () => false,
  );
  if (hasTrash) {
    await run(["/usr/bin/trash", path]);
  } else {
    await run([
      "osascript",
      "-e",
      "on run argv",
      "-e",
      'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
      "-e",
      "end run",
      path,
    ]);
  }
  return trashPathFor(path, home);
}

/**
 * Where moving an item to the Trash puts it, near enough to list it there.
 */
export function trashPathFor(path: string, home: string): string {
  return join(home, ".Trash", basename(path));
}

/**
 * Deletes for good. Only used for caches and things already in the Trash.
 */
export async function deleteForGood(path: string): Promise<void> {
  await fsp.rm(path, { recursive: true, force: true });
}

/**
 * Shows the item in Finder.
 */
export async function reveal(path: string): Promise<void> {
  await run(["open", "-R", path]);
}
