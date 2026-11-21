import { promises as fsp } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Clearable, Root } from "./categories";
import type { Item } from "./scan";

/**
 * One item handled while clearing.
 */
export interface CleanProgress {
  /**
   * Path that was just handled.
   */
  path: string;
  /**
   * Bytes it freed; 0 when it could not be removed.
   */
  freed: number;
}

/**
 * What clearing a category did.
 */
export interface CleanResult {
  freed: number;
  removed: number;
  /**
   * Paths that could not be removed (in use, or protected by the system).
   */
  skipped: string[];
}

/**
 * Everything directly inside the category's folders: the things that would be
 * removed. Sizes come from the scan where it measured them.
 */
export async function plan(category: Clearable, known: Item[], roots: Root[]): Promise<Item[]> {
  const sizes = new Map(known.map((item) => [item.path, item.size]));
  const rootPaths = new Set(roots.map((r) => r.path));
  const items: Item[] = [];
  for (const root of roots) {
    if (root.category !== category) continue;
    let names: string[];
    try {
      names = await fsp.readdir(root.path);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(root.path, name);
      if (rootPaths.has(path)) continue;
      let bytes = sizes.get(path);
      let dir = true;
      try {
        const stat = await fsp.lstat(path);
        dir = stat.isDirectory();
        bytes ??= stat.blocks * 512;
      } catch {
        continue;
      }
      items.push({ path, size: bytes, dir });
    }
  }
  return items.sort((a, b) => b.size - a.size);
}

/**
 * True only for a path strictly inside one of the category's own folders.
 */
export function inside(category: Clearable, path: string, roots: Root[]): boolean {
  const target = resolve(path);
  return roots.some(
    (root) => root.category === category && target.startsWith(resolve(root.path) + sep),
  );
}

/**
 * Deletes the planned items for good, checking each one is still inside the
 * category's folders right before it goes.
 */
export async function clean(
  category: Clearable,
  items: Item[],
  roots: Root[],
  onProgress: (progress: CleanProgress) => void = () => {},
): Promise<CleanResult> {
  const result: CleanResult = { freed: 0, removed: 0, skipped: [] };
  for (const item of items) {
    let freed = 0;
    if (!inside(category, item.path, roots)) {
      result.skipped.push(item.path);
    } else {
      try {
        await fsp.rm(item.path, { recursive: true, force: true });
        freed = item.size;
        result.freed += freed;
        result.removed += 1;
      } catch {
        // In use or protected. Whatever was removed before the failure is
        // picked up when the category is measured again afterwards.
        result.skipped.push(item.path);
      }
    }
    onProgress({ path: item.path, freed });
  }
  return result;
}
