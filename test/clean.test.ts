import { afterEach, beforeEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cannotRemove } from "../src/core/browse";
import type { Root } from "../src/core/categories";
import { clean, inside, plan } from "../src/core/clean";

let root = "";
let roots: Root[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "fix-storage-clean-"));
  roots = [
    { path: join(root, "Caches"), category: "caches" },
    { path: join(root, "Documents"), category: "documents" },
  ];
  await fs.mkdir(join(root, "Caches", "com.app"), { recursive: true });
  await fs.writeFile(join(root, "Caches", "com.app", "blob"), Buffer.alloc(8192, 1));
  await fs.writeFile(join(root, "Caches", "loose.db"), "x");
  await fs.mkdir(join(root, "Documents"), { recursive: true });
  await fs.writeFile(join(root, "Documents", "keep.txt"), "mine");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("inside only accepts paths strictly within the category's own folders", () => {
  expect(inside("caches", join(root, "Caches", "com.app"), roots)).toBe(true);
  expect(inside("caches", join(root, "Caches"), roots)).toBe(false);
  expect(inside("caches", join(root, "Caches", "..", "Documents", "keep.txt"), roots)).toBe(false);
  expect(inside("caches", join(root, "Documents", "keep.txt"), roots)).toBe(false);
  expect(inside("trash", join(root, "Caches", "com.app"), roots)).toBe(false);
});

test("plan lists what is directly inside the category's folders, largest first, using scan sizes", async () => {
  const known = [{ path: join(root, "Caches", "com.app"), size: 1e6, dir: true }];
  const items = await plan("caches", known, roots);
  expect(items.map((i) => i.path)).toEqual([
    join(root, "Caches", "com.app"),
    join(root, "Caches", "loose.db"),
  ]);
  expect(items[0]?.dir).toBe(true);
  expect(items[1]?.dir).toBe(false);
});

test("clean removes planned items and refuses anything outside the category", async () => {
  const items = await plan("caches", [], roots);
  const outsider = { path: join(root, "Documents", "keep.txt"), size: 4, dir: false };
  const progress: string[] = [];
  const result = await clean("caches", [...items, outsider], roots, (p) => progress.push(p.path));
  expect(result.removed).toBe(2);
  expect(result.skipped).toEqual([outsider.path]);
  expect(progress).toHaveLength(3);
  expect(await fs.readdir(join(root, "Caches"))).toEqual([]);
  expect(await fs.readFile(outsider.path, "utf8")).toBe("mine");
});

test("cannotRemove protects roots, system folders and anything outside the roots", () => {
  const home = join(root, "home");
  expect(cannotRemove(join(root, "Caches"), roots, home)).toContain("needs this folder");
  expect(cannotRemove("/System/Library/Foo", roots, home)).toBe("macOS manages this.");
  expect(cannotRemove("/tmp/elsewhere", roots, home)).toBe(
    "Outside the folders this tool looks at.",
  );
  expect(cannotRemove(join(root, "Caches", "com.app"), roots, home)).toBeNull();
  expect(cannotRemove("relative/path", roots, home)).toBe("Not a real path.");
});
