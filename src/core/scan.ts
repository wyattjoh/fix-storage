import { promises as fsp } from "node:fs";
import { basename, join } from "node:path";
import { CATEGORIES, type CategoryId, type Root } from "./categories";

/**
 * One measured file or folder.
 */
export interface Item {
  path: string;
  size: number;
  /**
   * True for folders, which can be opened for a closer look.
   */
  dir: boolean;
}

/**
 * Space on the startup disk, in bytes.
 */
export interface Space {
  /**
   * Filesystem capacity.
   */
  total: number;
  /**
   * Free bytes this account can use.
   */
  available: number;
  /**
   * Bytes in use.
   */
  used: number;
}

/**
 * The state of a scan, published as it progresses.
 */
export interface ScanSnapshot extends Space {
  phase: "scanning" | "done";
  /**
   * Sum of the file and folder estimates, before accounting for unmeasured space.
   */
  measured: number;
  sizes: Record<CategoryId, number>;
  /**
   * Measured folders per category, largest first.
   */
  items: Record<CategoryId, Item[]>;
  /**
   * Path being measured right now.
   */
  current: string;
  /**
   * Folders this process may not read.
   */
  blocked: string[];
}

/**
 * A running scan.
 */
export interface ScanHandle {
  cancel(): void;
  done: Promise<ScanSnapshot>;
}

/**
 * Signature of a scan starter, so the UI can be driven by a fake scan in tests.
 */
export type StartScan = (roots: Root[], onUpdate: (snapshot: ScanSnapshot) => void) => ScanHandle;

/**
 * Used space the scan could not attribute to a folder.
 */
export function unmeasuredBytes({ used, measured }: ScanSnapshot): number {
  return Math.max(0, used - measured);
}

/**
 * A record with one fresh value per category.
 */
export function emptyRecord<T>(make: () => T): Record<CategoryId, T> {
  return Object.fromEntries(CATEGORIES.map((c) => [c.id, make()])) as Record<CategoryId, T>;
}

/**
 * A snapshot with nothing measured yet.
 */
export function emptySnapshot(): ScanSnapshot {
  return {
    phase: "scanning",
    total: 0,
    available: 0,
    used: 0,
    measured: 0,
    sizes: emptyRecord(() => 0),
    items: emptyRecord<Item[]>(() => []),
    current: "",
    blocked: [],
  };
}

/**
 * Capacity and use of the Mac's data volume (where everything but the sealed system lives).
 */
export async function diskSpace(): Promise<Space> {
  for (const path of ["/System/Volumes/Data", "/"]) {
    try {
      const s = await fsp.statfs(path);
      const total = s.blocks * s.bsize;
      const available = s.bavail * s.bsize;
      return { total, available, used: total - available };
    } catch {
      // try the next one
    }
  }
  return { total: 0, available: 0, used: 0 };
}

function denied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES";
}

const STALL_CHECK_MS = 5000;

/**
 * Processes a caller may kill to stop measuring early.
 */
export type Children = Set<Bun.Subprocess>;

/**
 * What du reported for one folder.
 */
export interface DuResult {
  bytes: number;
  denied: boolean;
}

async function cpuTime(pid: number): Promise<string> {
  try {
    const proc = Bun.spawn(["ps", "-o", "cputime=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return (await new Response(proc.stdout).text()).trim();
  } catch {
    return "";
  }
}

/**
 * Disk usage of one folder via du, which is far faster than walking it in JS.
 */
export async function du(path: string, children: Children): Promise<DuResult> {
  const child = Bun.spawn(["du", "-skx", path], { stdout: "pipe", stderr: "pipe" });
  children.add(child);
  // A folder guarded by a macOS privacy prompt (Music, TV, Photos) makes du
  // wait for an answer that may never come. A du that has used no CPU time
  // between two checks is waiting like that: give up on it and report the
  // folder as unreadable.
  let stalled = false;
  let lastCpu = "";
  const watchdog = setInterval(async () => {
    const cpu = await cpuTime(child.pid);
    if (cpu === "") return;
    if (cpu === lastCpu) {
      stalled = true;
      child.kill();
    }
    lastCpu = cpu;
  }, STALL_CHECK_MS);
  try {
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    const kb = Number.parseInt(out, 10);
    return {
      bytes: Number.isFinite(kb) ? kb * 1024 : 0,
      denied: stalled || /not permitted|Permission denied/.test(err),
    };
  } finally {
    clearInterval(watchdog);
    children.delete(child);
  }
}

interface Unit {
  path: string;
  category: CategoryId;
}

/**
 * Tuning for a scan.
 */
export interface ScanOptions {
  /**
   * How many folders to measure at once.
   */
  concurrency: number;
  /**
   * Minimum milliseconds between onUpdate calls.
   */
  throttleMs: number;
}

const DEFAULT_SCAN: ScanOptions = { concurrency: 6, throttleMs: 40 };

/**
 * Measures every root, publishing snapshots as it goes. A root nested inside
 * another is measured on its own and left out of the outer one, so nothing is
 * counted twice.
 */
export function startScan(
  roots: Root[],
  onUpdate: (snapshot: ScanSnapshot) => void,
  options: ScanOptions = DEFAULT_SCAN,
): ScanHandle {
  const { concurrency, throttleMs } = options;
  const snap = emptySnapshot();
  const children: Children = new Set();
  let cancelled = false;
  let lastEmit = 0;

  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < throttleMs) return;
    lastEmit = now;
    onUpdate({ ...snap, sizes: { ...snap.sizes } });
  };

  const add = (category: CategoryId, bytes: number) => {
    snap.sizes[category] += bytes;
    snap.measured += bytes;
  };

  const run = async (): Promise<ScanSnapshot> => {
    Object.assign(snap, await diskSpace());
    emit(true);

    const rootPaths = new Set(roots.map((r) => r.path));
    const holdsRoot = (path: string) => {
      const prefix = path + "/";
      return roots.some((r) => r.path.startsWith(prefix));
    };
    const units: Unit[] = [];

    const addFile = async (path: string, category: CategoryId) => {
      try {
        const stat = await fsp.lstat(path);
        const bytes = stat.blocks * 512;
        add(category, bytes);
        if (bytes > 0) snap.items[category].push({ path, size: bytes, dir: false });
      } catch {
        // vanished or unreadable; nothing to count
      }
    };

    // Unreadable system folders are expected; they count as System data anyway.
    const report = (path: string, category: CategoryId) => {
      if (category !== "system") snap.blocked.push(path);
    };

    // Lists a folder, queueing each subfolder for du and adding loose files
    // straight away. Subfolders that hold another root are opened instead of
    // measured whole, so the inner root is not counted twice.
    const expand = async (
      path: string,
      category: CategoryId,
      hidden: CategoryId | undefined,
    ): Promise<void> => {
      if (cancelled) return;
      let entries;
      try {
        entries = await fsp.readdir(path, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOTDIR") await addFile(path, category);
        else if (denied(error)) report(path, category);
        return;
      }
      for (const entry of entries) {
        const child = join(path, entry.name);
        if (rootPaths.has(child)) continue;
        const kind = hidden !== undefined && entry.name.startsWith(".") ? hidden : category;
        if (entry.isDirectory()) {
          if (holdsRoot(child)) await expand(child, kind, undefined);
          else units.push({ path: child, category: kind });
        } else {
          await addFile(child, kind);
        }
      }
    };

    const order = CATEGORIES.map((c) => c.id);
    const sorted = [...roots].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
    for (const root of sorted) {
      snap.current = root.path;
      await expand(root.path, root.category, root.hidden);
      emit();
    }

    let next = 0;
    const worker = async () => {
      while (!cancelled && next < units.length) {
        const unit = units[next++];
        if (!unit) return;
        snap.current = unit.path;
        emit();
        const result = await du(unit.path, children);
        if (cancelled) return;
        add(unit.category, result.bytes);
        if (result.bytes > 0)
          snap.items[unit.category].push({ path: unit.path, size: result.bytes, dir: true });
        if (result.denied && result.bytes < 1024 * 1024 && basename(unit.path) !== ".Trashes") {
          report(unit.path, unit.category);
        }
        emit();
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    for (const list of Object.values(snap.items)) list.sort((a, b) => b.size - a.size);

    // Whatever the disk reports as used beyond what was measured is the
    // system's: macOS itself, snapshots, swap, and folders this process may
    // not read.
    const after = await diskSpace();
    if (after.total > 0) Object.assign(snap, after);
    snap.sizes.system += unmeasuredBytes(snap);
    snap.current = "";
    snap.phase = "done";
    emit(true);
    return snap;
  };

  return {
    cancel() {
      cancelled = true;
      for (const child of children) child.kill();
    },
    done: run(),
  };
}

/**
 * Re-measures one category after something was deleted from it.
 */
export async function measure(category: CategoryId, roots: Root[]): Promise<number> {
  const children: Children = new Set();
  let total = 0;
  for (const root of roots) {
    if (root.category !== category) continue;
    total += (await du(root.path, children)).bytes;
  }
  return total;
}
