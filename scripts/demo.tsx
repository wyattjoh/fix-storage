#!/usr/bin/env bun
/** @jsxImportSource @opentui/react */
/**
 * The real UI over a made-up disk, for screenshots and recordings. Nothing is
 * read from or written to the real disk: every side effect is a fake. Run it
 * with HOME set to a neutral path (`HOME=/Users/you bun scripts/demo.tsx`) so
 * no real folder names appear. Not part of the published package.
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { homedir } from "node:os";
import { roots, type CategoryId } from "../src/core/categories";
import type { Culprit } from "../src/core/browse";
import { emptySnapshot, unmeasuredBytes, type Item, type ScanSnapshot } from "../src/core/scan";
import { App } from "../src/ui/app";
import { Store, type Deps } from "../src/ui/store";

const H = homedir();
const GB = 1e9;
const DAY = 864e5;
const DISK = { total: 994.7 * GB, used: 731.2 * GB, available: 263.5 * GB };

const dir = (path: string, gb: number): Item => ({ path, size: gb * GB, dir: true });
const fileItem = (path: string, gb: number): Item => ({ path, size: gb * GB, dir: false });

/**
 * What the scan finds, in the order it finds it.
 */
const FOUND: Array<[CategoryId, Item]> = [
  ["apps", dir("/Applications/Xcode.app", 14.8)],
  ["apps", dir(H + "/Library/Containers/com.docker.docker", 38.4)],
  ["apps", dir(H + "/Library/Application Support/Slack", 3.9)],
  ["apps", dir("/Applications/Figma.app", 0.6)],
  ["apps", dir(H + "/Library/Application Support/Code", 6.1)],
  ["developer", dir(H + "/Library/Developer/CoreSimulator", 41.2)],
  ["developer", dir(H + "/Library/Developer/Xcode/iOS DeviceSupport", 17.9)],
  ["developer", dir(H + "/.rustup", 9.8)],
  ["developer", dir(H + "/.cargo", 6.2)],
  ["developer", dir(H + "/.npm", 3.1)],
  ["photos", dir(H + "/Pictures/Photos Library.photoslibrary", 64.3)],
  ["movies", dir(H + "/Movies/Screen Recordings", 18.7)],
  ["movies", fileItem(H + "/Movies/conference-talk-final.mov", 3.4)],
  ["documents", dir(H + "/Documents/projects", 61.5)],
  ["documents", dir(H + "/Downloads", 38.2)],
  ["documents", fileItem(H + "/Downloads/ubuntu-24.04-desktop-arm64.iso", 6.1)],
  ["documents", fileItem(H + "/Downloads/Install macOS.dmg", 13.2)],
  ["documents", dir(H + "/Desktop", 8.8)],
  ["documents", dir(H + "/Documents/taxes", 1.2)],
  ["music", dir(H + "/Music/Music", 11.3)],
  ["caches", dir(H + "/.cache/huggingface", 12.3)],
  ["caches", dir(H + "/Library/Caches/com.spotify.client", 6.4)],
  ["caches", dir(H + "/Library/Developer/Xcode/DerivedData", 5.6)],
  ["caches", dir(H + "/Library/Caches/Homebrew", 5.1)],
  ["caches", dir(H + "/Library/Caches/pnpm", 4.8)],
  ["caches", dir(H + "/Library/Caches/Google", 3.2)],
  ["trash", fileItem(H + "/.Trash/old-laptop-backup.zip", 6.4)],
];

/**
 * What is inside the folders worth opening in a demo.
 */
const INSIDE: Record<string, Item[]> = {
  [H + "/Documents/projects"]: [
    dir(H + "/Documents/projects/ml-experiments", 31.6),
    dir(H + "/Documents/projects/web-app", 14.2),
    dir(H + "/Documents/projects/old-portfolio", 8.9),
    dir(H + "/Documents/projects/game-jam-2024", 4.7),
    dir(H + "/Documents/projects/dotfiles", 0.1),
    fileItem(H + "/Documents/projects/notes.md", 0.001),
  ],
  [H + "/Documents/projects/ml-experiments"]: [
    dir(H + "/Documents/projects/ml-experiments/checkpoints", 24.4),
    dir(H + "/Documents/projects/ml-experiments/.venv", 5.3),
    dir(H + "/Documents/projects/ml-experiments/data", 1.8),
  ],
  [H + "/Documents/projects/ml-experiments/checkpoints"]: [
    fileItem(H + "/Documents/projects/ml-experiments/checkpoints/model-final.safetensors", 19.7),
    fileItem(H + "/Documents/projects/ml-experiments/checkpoints/epoch-12.safetensors", 2.4),
    fileItem(H + "/Documents/projects/ml-experiments/checkpoints/epoch-08.safetensors", 2.3),
  ],
  [H + "/Documents/projects/web-app"]: [
    dir(H + "/Documents/projects/web-app/node_modules", 1.4),
    dir(H + "/Documents/projects/web-app/.next", 0.9),
    dir(H + "/Documents/projects/web-app/public", 11.8),
  ],
};

const CULPRITS: Record<string, Culprit> = {
  [H + "/Documents/projects/ml-experiments"]: {
    chain: [
      dir(H + "/Documents/projects/ml-experiments/checkpoints", 24.4),
      fileItem(H + "/Documents/projects/ml-experiments/checkpoints/model-final.safetensors", 19.7),
    ],
    top: [],
  },
  [H + "/Library/Containers/com.docker.docker"]: {
    chain: [
      dir(H + "/Library/Containers/com.docker.docker/Data", 38.3),
      fileItem(H + "/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw", 37.9),
    ],
    top: [],
  },
};

const USED_AGO: Record<string, number> = {
  [H + "/Documents/projects/old-portfolio"]: 412,
  [H + "/Documents/projects/game-jam-2024"]: 301,
  [H + "/Downloads/Install macOS.dmg"]: 220,
  [H + "/Movies/conference-talk-final.mov"]: 530,
  [H + "/Library/Developer/Xcode/iOS DeviceSupport"]: 260,
};

const SCAN_MS = Number(process.env.DEMO_SCAN_MS ?? 6000);

function demoScan(onUpdate: (snapshot: ScanSnapshot) => void) {
  const snap: ScanSnapshot = { ...emptySnapshot(), ...DISK, phase: "scanning" };
  let i = 0;
  let resolve: (s: ScanSnapshot) => void = () => {};
  const done = new Promise<ScanSnapshot>((r) => (resolve = r));
  const step = SCAN_MS / FOUND.length;
  const timer = setInterval(() => {
    const found = FOUND[i++];
    if (!found) {
      clearInterval(timer);
      for (const list of Object.values(snap.items)) list.sort((a, b) => b.size - a.size);
      snap.sizes.system += unmeasuredBytes(snap);
      snap.current = "";
      snap.phase = "done";
      onUpdate({ ...snap, sizes: { ...snap.sizes } });
      resolve(snap);
      return;
    }
    const [category, item] = found;
    snap.sizes[category] += item.size;
    snap.measured += item.size;
    snap.items[category].push(item);
    snap.current = item.path;
    onUpdate({ ...snap, sizes: { ...snap.sizes } });
  }, step);
  return { cancel: () => clearInterval(timer), done };
}

function deps(): Deps {
  const removed = new Set<string>();
  return {
    home: H,
    roots: roots(H),
    startScan: (_roots, onUpdate) => demoScan(onUpdate),
    listFolder: (path, onUpdate) => {
      const items = (INSIDE[path] ?? []).filter((item) => !removed.has(item.path));
      const timer = setTimeout(() => onUpdate(items, true, ""), 250);
      return { cancel: () => clearTimeout(timer) };
    },
    findCulprit: (path, onDone) => {
      const culprit = CULPRITS[path] ?? { chain: [], top: (INSIDE[path] ?? []).slice(0, 3) };
      const timer = setTimeout(() => onDone(culprit), 400);
      return { cancel: () => clearTimeout(timer) };
    },
    usage: async (paths) =>
      new Map(
        paths.map((path) => [
          path,
          { at: Date.now() - (USED_AGO[path] ?? 3 + (path.length % 40)) * DAY, kind: "opened" },
        ]),
      ),
    diskSpace: async () => DISK,
    measure: async () => 0,
    plan: async (_category, known) => known,
    clean: async (_category, items, _roots, onProgress) => {
      let freed = 0;
      for (const item of items) {
        await Bun.sleep(350);
        freed += item.size;
        onProgress({ path: item.path, freed: item.size });
      }
      return { freed, removed: items.length, skipped: [] };
    },
    moveToTrash: async (path) => (removed.add(path), H + "/.Trash/" + path.split("/").pop()),
    deleteForGood: async (path) => void removed.add(path),
    reveal: async () => {},
    forgetSizes: () => {},
    shutdown: () => {},
    confirmMs: 4000,
    confirmGuardMs: 300,
    enrichMs: 120,
  };
}

const store = new Store(deps());
const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: false,
  backgroundColor: "#000000",
});
const quit = async () => {
  store.stop();
  renderer.destroy();
  await renderer.closed;
  process.exit(0);
};
createRoot(renderer).render(<App store={store} onQuit={() => void quit()} />);
store.rescan();
