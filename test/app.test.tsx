/** @jsxImportSource @opentui/react */
import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { Root } from "../src/core/categories";
import type { CleanProgress } from "../src/core/clean";
import { emptySnapshot, type Item, type ScanSnapshot } from "../src/core/scan";
import { App } from "../src/ui/app";
import { Store, type Deps } from "../src/ui/store";

const HOME = "/Users/test";
const ROOTS: Root[] = [
  { path: HOME + "/Library/Caches", category: "caches" },
  { path: HOME + "/Documents", category: "documents" },
];

function finishedScan(): ScanSnapshot {
  const scan = {
    ...emptySnapshot(),
    phase: "done" as const,
    total: 500e9,
    used: 300e9,
    available: 200e9,
    measured: 120e9,
  };
  scan.sizes.caches = 20e9;
  scan.sizes.documents = 100e9;
  scan.items.caches = [{ path: HOME + "/Library/Caches/com.example.big", size: 20e9, dir: true }];
  scan.items.documents = [{ path: HOME + "/Documents/projects", size: 100e9, dir: true }];
  return scan;
}

function fakeDeps(calls: { clean: Item[][]; removed: string[] }): Deps {
  return {
    home: HOME,
    roots: ROOTS,
    startScan: (_roots, onUpdate) => {
      const scan = finishedScan();
      queueMicrotask(() => onUpdate(scan));
      return { cancel() {}, done: Promise.resolve(scan) };
    },
    listFolder: (path, onUpdate) => {
      queueMicrotask(() =>
        onUpdate([{ path: path + "/node_modules", size: 60e9, dir: true }], true, ""),
      );
      return { cancel() {} };
    },
    findCulprit: () => ({ cancel() {} }),
    usage: async () => new Map(),
    diskSpace: async () => ({ total: 500e9, used: 280e9, available: 220e9 }),
    measure: async () => 0,
    plan: async (category, known) => known.filter(() => category === "caches"),
    clean: async (_category, items, _roots, onProgress: (p: CleanProgress) => void) => {
      calls.clean.push(items);
      for (const item of items) onProgress({ path: item.path, freed: item.size });
      return { freed: items.reduce((s, i) => s + i.size, 0), removed: items.length, skipped: [] };
    },
    moveToTrash: async (path) => (calls.removed.push(path), HOME + "/.Trash/x"),
    deleteForGood: async (path) => void calls.removed.push(path),
    reveal: async () => {},
    confirmMs: 60_000,
    enrichMs: 60_000,
  };
}

/**
 * testRender turns on React's act() environment. The store updates React from
 * timers and promises, as it does in the real app, so act() would only add noise.
 */
async function render(
  node: Parameters<typeof testRender>[0],
  size: { width: number; height: number },
) {
  const t = await testRender(node, size);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  return t;
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function setup() {
  const calls = { clean: [] as Item[][], removed: [] as string[] };
  const store = new Store(fakeDeps(calls));
  const t = await render(<App store={store} onQuit={() => {}} />, { width: 120, height: 32 });
  cleanup = async () => {
    store.stop();
    await t.dispose();
  };
  store.rescan();
  await t.waitForFrame((frame) => frame.includes("scan complete"));
  const press = async (key: string) => {
    t.mockInput.pressKey(key);
    await Bun.sleep(5);
    await t.renderOnce();
    return t.captureCharFrame();
  };
  return { t, store, calls, press };
}

test("a finished scan shows the disk totals, every category and what is safe to clear", async () => {
  const { t } = await setup();
  const frame = t.captureCharFrame();
  expect(frame).toContain("300.0 GB used of 500 GB");
  for (const name of ["Apps", "Developer", "Documents", "Caches", "Trash", "System data"])
    expect(frame).toContain(name);
  expect(frame).toContain("safe to clear");
});

test("arrow keys move between categories, open a folder and come back", async () => {
  const { store, press } = await setup();
  await press("ARROW_DOWN");
  await press("ARROW_DOWN");
  await press("ARROW_DOWN");
  await press("ARROW_DOWN");
  expect(store.get().selected).toBe("documents");
  let frame = await press("ARROW_RIGHT");
  expect(store.get().pane).toBe("list");
  expect(frame).toContain("projects/");
  frame = await press("ARROW_RIGHT");
  await Bun.sleep(5);
  frame = await press("j");
  expect(store.get().stack.map((s) => s.path)).toEqual([HOME + "/Documents/projects"]);
  expect(frame).toContain("Documents / projects");
  expect(frame).toContain("node_modules/");
  await press("ARROW_LEFT");
  expect(store.get().stack).toEqual([]);
});

test("clearing a category needs a second press before anything is deleted", async () => {
  const { store, calls, press } = await setup();
  for (let i = 0; i < 7; i++) await press("ARROW_DOWN");
  expect(store.get().selected).toBe("caches");
  const armed = await press("c");
  expect(store.get().confirm).toEqual({ kind: "category", id: "caches" });
  expect(armed).toContain("c again");
  expect(calls.clean).toHaveLength(0);
  await press("c");
  for (let i = 0; i < 20 && store.get().action !== null; i++) await Bun.sleep(5);
  expect(calls.clean).toHaveLength(1);
  expect(calls.clean[0]?.map((i) => i.path)).toEqual([HOME + "/Library/Caches/com.example.big"]);
  expect(store.get().note).toContain("Caches:");
});

test("removing one item also takes two presses, and moves non-cache items to the Trash", async () => {
  const { store, calls, press } = await setup();
  for (let i = 0; i < 4; i++) await press("ARROW_DOWN");
  await press("ARROW_RIGHT");
  await press("d");
  expect(calls.removed).toEqual([]);
  expect(store.get().confirm).toEqual({ kind: "item", path: HOME + "/Documents/projects" });
  await press("d");
  for (let i = 0; i < 20 && store.get().removing !== null; i++) await Bun.sleep(5);
  expect(calls.removed).toEqual([HOME + "/Documents/projects"]);
  expect(store.get().note).toContain("Moved to Trash");
});

test("q asks the app to quit", async () => {
  const calls = { clean: [] as Item[][], removed: [] as string[] };
  const store = new Store(fakeDeps(calls));
  let quit = 0;
  const t = await render(<App store={store} onQuit={() => quit++} />, { width: 100, height: 30 });
  cleanup = async () => {
    store.stop();
    await t.dispose();
  };
  t.mockInput.pressKey("q");
  await Bun.sleep(5);
  expect(quit).toBe(1);
});
