import { homedir } from "node:os";
import { basename } from "node:path";
import {
  CATEGORIES,
  CATEGORY,
  CLEARABLE,
  roots as macRoots,
  type CategoryId,
  type Clearable,
  type Root,
} from "../core/categories";
import { classify, type Label, type Usage } from "../core/classify";
import {
  cannotRemove,
  deleteForGood,
  deletesForGood,
  findCulprit,
  forgetAllSizes,
  forgetSizes,
  listFolder,
  moveToTrash,
  reveal,
  trashPathFor,
  usage,
  type Culprit,
  type FindCulprit,
  type ListFolder,
  type ListHandle,
  type LookUpUsage,
} from "../core/browse";
import { clean, plan, type CleanProgress, type CleanResult } from "../core/clean";
import { size, tilde } from "../core/format";
import {
  diskSpace,
  emptySnapshot,
  measure,
  startScan,
  unmeasuredBytes,
  type Item,
  type ScanHandle,
  type ScanSnapshot,
  type Space,
  type StartScan,
} from "../core/scan";

/**
 * A category-wide clear in progress.
 */
export interface Action {
  id: Clearable;
  /**
   * Path being removed right now.
   */
  current: string;
  /**
   * Bytes freed so far.
   */
  freed: number;
  /**
   * Items handled so far, and in total.
   */
  done: number;
  total: number;
}

/**
 * Which side of the screen the arrow keys move in.
 */
export type Pane = "sidebar" | "list";

/**
 * A folder opened inside the detail pane.
 */
export interface Level {
  path: string;
  size: number;
}

/**
 * What is waiting for a second press: a category to clear, or one item to remove.
 */
export type Confirm = { kind: "category"; id: Clearable } | { kind: "item"; path: string };

/**
 * Everything the UI draws.
 */
export interface AppState {
  scan: ScanSnapshot;
  /**
   * Category shown in the detail pane.
   */
  selected: CategoryId;
  pane: Pane;
  /**
   * Highlighted row in the detail list.
   */
  row: number;
  /**
   * Folders opened below the category, outermost first.
   */
  stack: Level[];
  /**
   * Contents of the innermost opened folder.
   */
  children: Item[];
  /**
   * True while the opened folder is still being measured.
   */
  listing: boolean;
  action: Action | null;
  confirm: Confirm | null;
  /**
   * Item being moved or deleted right now.
   */
  removing: string | null;
  /**
   * Estimated bytes cleared since the app started.
   */
  freed: number;
  /**
   * One line about the last action, shown until the next one.
   */
  note: string | null;
  /**
   * When each listed item was last opened or changed, by path.
   */
  usage: Record<string, Usage>;
  /**
   * Where the space inside each folder is, by path; "pending" while it is being measured.
   */
  culprits: Record<string, Culprit | "pending">;
  /**
   * Show only things labelled junk or unused.
   */
  junkOnly: boolean;
}

/**
 * Everything the store does to the machine, injectable so tests never touch the real disk.
 */
export interface Deps {
  home: string;
  roots: Root[];
  startScan: StartScan;
  listFolder: ListFolder;
  findCulprit: FindCulprit;
  usage: LookUpUsage;
  diskSpace: () => Promise<Space>;
  measure: (category: CategoryId, roots: Root[]) => Promise<number>;
  plan: (category: Clearable, known: Item[], roots: Root[]) => Promise<Item[]>;
  clean: (
    category: Clearable,
    items: Item[],
    roots: Root[],
    onProgress: (p: CleanProgress) => void,
  ) => Promise<CleanResult>;
  moveToTrash: (path: string, home: string) => Promise<string>;
  deleteForGood: (path: string) => Promise<void>;
  reveal: (path: string) => Promise<void>;
  /**
   * How long a first press stays armed.
   */
  confirmMs: number;
  /**
   * Delay before fetching dates and culprits for what came on screen.
   */
  enrichMs: number;
}

/**
 * The real machine.
 */
export function liveDeps(home: string = homedir()): Deps {
  return {
    home,
    roots: macRoots(home),
    startScan: (roots, onUpdate) => startScan(roots, onUpdate),
    listFolder,
    findCulprit,
    usage,
    diskSpace,
    measure,
    plan,
    clean,
    moveToTrash,
    deleteForGood,
    reveal,
    confirmMs: 4000,
    enrichMs: 120,
  };
}

type Listener = () => void;

/**
 * Sizes below this are not worth a suggestion.
 */
const WORTH_CLEARING = 50e6;

/**
 * Longest list the detail pane holds.
 */
export const MAX_ROWS = 150;

const firstMessageLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0]?.slice(0, 120) ?? "";

/**
 * The app's state machine. The UI reads it with useSyncExternalStore and calls its methods on keys.
 */
export class Store {
  private state: AppState = {
    scan: emptySnapshot(),
    selected: CATEGORIES[0]!.id,
    pane: "sidebar",
    row: 0,
    stack: [],
    children: [],
    listing: false,
    action: null,
    confirm: null,
    removing: null,
    freed: 0,
    note: null,
    usage: {},
    culprits: {},
    junkOnly: false,
  };
  private listeners = new Set<Listener>();
  private scanHandle: ScanHandle | null = null;
  private listHandle: ListHandle | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private enrichTimer: ReturnType<typeof setTimeout> | null = null;
  private culpritHandle: ListHandle | null = null;
  private culpritQueue: Item[] = [];
  private usagePending = new Set<string>();
  private stopped = false;

  constructor(readonly deps: Deps = liveDeps()) {}

  get = (): AppState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<AppState>) {
    if (this.stopped) return;
    const before = this.state;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    if (
      before.selected !== this.state.selected ||
      before.stack !== this.state.stack ||
      before.children !== this.state.children ||
      before.row !== this.state.row ||
      before.scan.phase !== this.state.scan.phase ||
      before.junkOnly !== this.state.junkOnly
    ) {
      this.scheduleEnrich();
    }
  }

  // ---- labels, last-used dates and culprits ---------------------------------

  /**
   * What an item probably is, and why.
   */
  label(item: Item, state: AppState = this.state): Label {
    return classify(item, state.selected, state.usage[item.path]);
  }

  toggleJunkOnly(): void {
    this.clearConfirm();
    this.set({ junkOnly: !this.state.junkOnly, row: 0 });
  }

  private scheduleEnrich() {
    if (this.enrichTimer) return;
    this.enrichTimer = setTimeout(() => {
      this.enrichTimer = null;
      this.enrich();
    }, this.deps.enrichMs);
  }

  private enrich() {
    const { scan, listing, row } = this.state;
    if (scan.phase !== "done" && this.state.stack.length === 0) return;
    const all = this.allEntries().slice(0, MAX_ROWS);

    const missing = all
      .map((i) => i.path)
      .filter((p) => !(p in this.state.usage) && !this.usagePending.has(p));
    if (missing.length > 0) {
      for (const p of missing) this.usagePending.add(p);
      void this.deps.usage(missing).then((found) => {
        for (const p of missing) this.usagePending.delete(p);
        this.set({ usage: { ...this.state.usage, ...Object.fromEntries(found) } });
      });
    }

    // Culprits: the highlighted folder first, then the biggest few on screen.
    if (listing) return;
    const entries = this.entries();
    const wanted = [entries[row], ...entries.filter((i) => i.dir).slice(0, 4)].filter(
      (i): i is Item => !!i && i.dir && !(i.path in this.state.culprits),
    );
    const seen = new Set<string>();
    this.culpritQueue = wanted.filter((i) => (seen.has(i.path) ? false : (seen.add(i.path), true)));
    this.nextCulprit();
  }

  private nextCulprit(): void {
    if (this.culpritHandle) return;
    const item = this.culpritQueue.shift();
    if (!item) return;
    if (item.path in this.state.culprits) return this.nextCulprit();
    this.set({ culprits: { ...this.state.culprits, [item.path]: "pending" } });
    this.culpritHandle = this.deps.findCulprit(item.path, (culprit) => {
      this.culpritHandle = null;
      this.set({ culprits: { ...this.state.culprits, [item.path]: culprit } });
      this.nextCulprit();
    });
  }

  private dropCulpritWork() {
    this.culpritQueue = [];
    if (!this.culpritHandle) return;
    this.culpritHandle.cancel();
    this.culpritHandle = null;
    const culprits = { ...this.state.culprits };
    for (const [path, value] of Object.entries(culprits))
      if (value === "pending") delete culprits[path];
    this.state = { ...this.state, culprits };
  }

  /**
   * Opens every folder on the way to the highlighted folder's culprit and lands on it.
   */
  goToCulprit(row: number = this.state.row): void {
    const item = this.entries()[row];
    const culprit = item ? this.state.culprits[item.path] : undefined;
    if (
      !item ||
      !culprit ||
      culprit === "pending" ||
      culprit.chain.length === 0 ||
      this.state.removing
    )
      return;
    this.listHandle?.cancel();
    this.dropCulpritWork();
    this.clearConfirm();
    const path = [item, ...culprit.chain];
    const last = path[path.length - 1]!;
    const target = path[path.length - 2]!;
    const above = path.slice(0, path.length - 2).map((i) => ({ path: i.path, size: i.size }));
    this.set({ stack: [...this.state.stack, ...above] });
    this.openItem(target, last.path);
  }

  // ---- scanning ------------------------------------------------------------

  /**
   * Measures everything from scratch.
   */
  rescan(): void {
    if (this.state.action || this.state.removing) return;
    this.scanHandle?.cancel();
    this.listHandle?.cancel();
    this.clearConfirm();
    this.dropCulpritWork();
    forgetAllSizes();
    this.set({
      scan: emptySnapshot(),
      note: null,
      stack: [],
      children: [],
      listing: false,
      row: 0,
      culprits: {},
      pane: "sidebar",
    });
    const handle = this.deps.startScan(this.deps.roots, (scan) => {
      if (this.scanHandle === handle) this.set({ scan });
    });
    this.scanHandle = handle;
  }

  // ---- moving around -------------------------------------------------------

  /**
   * Shows a category in the detail pane, back at its top level.
   */
  select(id: CategoryId, pane: Pane = this.state.pane): void {
    if (id === this.state.selected && this.state.stack.length === 0) {
      if (pane !== this.state.pane) this.set({ pane });
      return;
    }
    this.listHandle?.cancel();
    this.dropCulpritWork();
    this.clearConfirm();
    this.set({ selected: id, stack: [], children: [], listing: false, row: 0, pane });
  }

  moveCategory(delta: number): void {
    const index = CATEGORIES.findIndex((c) => c.id === this.state.selected);
    const next = CATEGORIES[Math.max(0, Math.min(CATEGORIES.length - 1, index + delta))]!;
    this.select(next.id, "sidebar");
  }

  setPane(pane: Pane): void {
    if (pane === "list" && this.entries().length === 0) return;
    if (pane !== this.state.pane) this.set({ pane });
  }

  /**
   * What the detail pane lists right now.
   */
  entries(state: AppState = this.state): Item[] {
    return this.allEntries(state).slice(0, MAX_ROWS);
  }

  /**
   * Every entry, including those past the drawing limit.
   */
  allEntries(state: AppState = this.state): Item[] {
    const list = state.stack.length === 0 ? state.scan.items[state.selected] : state.children;
    if (!state.junkOnly) return list;
    return list.filter((item) => {
      const { verdict } = this.label(item, state);
      return verdict === "junk" || verdict === "unused";
    });
  }

  /**
   * Bytes in the current list labelled junk, and labelled unused.
   */
  reclaimable(state: AppState = this.state): { junk: number; unused: number } {
    const list = state.stack.length === 0 ? state.scan.items[state.selected] : state.children;
    let junk = 0;
    let unused = 0;
    for (const item of list) {
      const { verdict } = this.label(item, state);
      if (verdict === "junk") junk += item.size;
      else if (verdict === "unused") unused += item.size;
    }
    return { junk, unused };
  }

  /**
   * Size of whatever the detail pane is looking at.
   */
  scopeSize(state: AppState = this.state): number {
    const top = state.stack[state.stack.length - 1];
    return top ? top.size : state.scan.sizes[state.selected];
  }

  moveRow(delta: number): void {
    const count = this.entries().length;
    if (count === 0) return;
    const row = Math.max(0, Math.min(count - 1, this.state.row + delta));
    if (row === this.state.row) return;
    this.clearConfirm();
    this.set({ row });
  }

  /**
   * Opens the highlighted folder and measures what is inside.
   */
  open(row: number = this.state.row): void {
    const item = this.entries()[row];
    if (!item || !item.dir || this.state.removing) return;
    this.openItem(item);
  }

  /**
   * Goes up one folder; from the category's top level, back to the sidebar.
   */
  back(): void {
    this.clearConfirm();
    const { stack } = this.state;
    const left = stack[stack.length - 1];
    if (!left) {
      this.set({ pane: "sidebar" });
      return;
    }
    this.listHandle?.cancel();
    this.dropCulpritWork();
    const rest = stack.slice(0, -1);
    const parent = rest[rest.length - 1];
    if (!parent) {
      const row = Math.max(
        0,
        this.state.scan.items[this.state.selected].findIndex((i) => i.path === left.path),
      );
      this.set({ stack: [], children: [], listing: false, row });
      return;
    }
    // Measure the parent again and land on the folder we just left.
    this.set({ stack: rest.slice(0, -1) });
    this.openItem({ path: parent.path, size: parent.size, dir: true }, left.path);
  }

  private openItem(item: Item, highlight?: string) {
    this.listHandle?.cancel();
    this.dropCulpritWork();
    this.clearConfirm();
    const stack = [...this.state.stack, { path: item.path, size: item.size }];
    const pick = (children: Item[]) =>
      Math.max(
        0,
        children.findIndex((c) => c.path === highlight),
      );
    this.set({ stack, children: [], listing: true, row: 0, pane: "list", note: null });
    const handle = this.deps.listFolder(item.path, (children, done) => {
      if (this.listHandle !== handle) return;
      this.set({
        children,
        listing: !done,
        row: done && highlight ? pick(children) : this.state.row,
      });
    });
    this.listHandle = handle;
  }

  // ---- acting on items -----------------------------------------------------

  /**
   * Why an item cannot be removed, or null.
   */
  blocked(item: Item | undefined): string | null {
    if (!item) return "Nothing selected.";
    if (this.state.selected === "system") return "macOS manages System data.";
    return cannotRemove(item.path, this.deps.roots, this.deps.home);
  }

  async reveal(row: number = this.state.row): Promise<void> {
    const item = this.entries()[row];
    if (!item) return;
    try {
      await this.deps.reveal(item.path);
      this.set({ note: `Showing ${basename(item.path)} in Finder.` });
    } catch {
      this.set({ note: `Could not show ${tilde(item.path)} in Finder.` });
    }
  }

  /**
   * First press arms, second press within a few seconds removes.
   */
  removeItem(row: number = this.state.row): void {
    const { state } = this;
    if (state.action || state.removing || state.scan.phase !== "done") return;
    const item = this.entries()[row];
    const reason = this.blocked(item);
    if (reason || !item) {
      this.set({ note: reason });
      return;
    }
    if (state.confirm?.kind === "item" && state.confirm.path === item.path) {
      this.clearConfirm();
      void this.runRemove(item);
      return;
    }
    this.arm({ kind: "item", path: item.path });
  }

  private async runRemove(item: Item) {
    const category = this.state.selected;
    const forGood = deletesForGood(category);
    this.set({ removing: item.path, note: null });

    let trashed = trashPathFor(item.path, this.deps.home);
    try {
      if (forGood) await this.deps.deleteForGood(item.path);
      else trashed = await this.deps.moveToTrash(item.path, this.deps.home);
    } catch (error) {
      const short = firstMessageLine(error);
      this.set({
        removing: null,
        note: `Could not remove ${basename(item.path)}${short ? `: ${short}` : "."}`,
      });
      return;
    }

    // Anything measured above or inside it is out of date now.
    forgetSizes(item.path);
    const culprits = { ...this.state.culprits };
    for (const path of Object.keys(culprits)) {
      if (path === item.path || item.path.startsWith(path + "/")) delete culprits[path];
    }
    this.state = { ...this.state, culprits };

    // Take the item out of every list that holds it, and shrink the folders above it.
    const { scan, stack, children } = this.state;
    const drop = (list: Item[]) => list.filter((i) => i.path !== item.path);
    const shrink = (list: Item[]) =>
      list.map((i) =>
        item.path.startsWith(i.path + "/") ? { ...i, size: Math.max(0, i.size - item.size) } : i,
      );
    const sizes = { ...scan.sizes, [category]: Math.max(0, scan.sizes[category] - item.size) };
    const items = { ...scan.items, [category]: shrink(drop(scan.items[category])) };
    const nextStack = stack.map((level) => ({
      ...level,
      size: Math.max(0, level.size - item.size),
    }));

    let measured = scan.measured;
    let freed = this.state.freed;
    if (forGood) {
      measured -= scan.sizes[category] - sizes[category];
      freed += item.size;
    } else {
      // Still on disk, only in the Trash now.
      sizes.trash += item.size;
      measured += item.size - (scan.sizes[category] - sizes[category]);
      items.trash = [{ path: trashed, size: item.size, dir: item.dir }, ...items.trash].sort(
        (a, b) => b.size - a.size,
      );
    }
    let space: Space = scan;
    const after = await this.deps.diskSpace();
    if (after.total > 0) space = after;
    sizes.system += unmeasuredBytes({ ...scan, ...space, measured }) - unmeasuredBytes(scan);

    const list = stack.length === 0 ? items[category] : drop(children);
    const note = forGood
      ? `Deleted ${basename(item.path)} (${size(item.size)}).`
      : `Moved to Trash: ${basename(item.path)} (${size(item.size)}). Empty the Trash to get the space back.`;
    this.set({
      scan: { ...scan, ...space, sizes, items, measured },
      stack: nextStack,
      children: stack.length === 0 ? children : list,
      row: Math.min(this.state.row, Math.max(0, Math.min(list.length, MAX_ROWS) - 1)),
      removing: null,
      freed,
      note,
    });
  }

  // ---- clearing a whole category ------------------------------------------

  /**
   * The next thing worth clearing, or null.
   */
  suggestion(): Clearable | null {
    const { scan, action } = this.state;
    if (action) return action.id;
    if (scan.phase !== "done") return null;
    return CLEARABLE.find((id) => scan.sizes[id] >= WORTH_CLEARING) ?? null;
  }

  canClear(id: CategoryId): id is Clearable {
    return (CLEARABLE as CategoryId[]).includes(id) && this.state.scan.sizes[id] >= WORTH_CLEARING;
  }

  /**
   * First press arms the clear, second press within a few seconds runs it.
   */
  press(id: Clearable): void {
    if (this.state.action || this.state.removing || this.state.scan.phase !== "done") return;
    if (this.state.confirm?.kind === "category" && this.state.confirm.id === id) {
      this.clearConfirm();
      void this.runClear(id);
      return;
    }
    this.arm({ kind: "category", id });
  }

  private arm(confirm: Confirm) {
    this.clearConfirm();
    this.set({ confirm });
    this.confirmTimer = setTimeout(() => this.set({ confirm: null }), this.deps.confirmMs);
  }

  private clearConfirm() {
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    if (this.state.confirm) this.set({ confirm: null });
  }

  private async runClear(id: Clearable) {
    const { roots } = this.deps;
    const original = this.state.scan;
    const before = original.sizes[id];
    this.listHandle?.cancel();
    this.dropCulpritWork();
    this.set({
      action: { id, current: "", freed: 0, done: 0, total: 0 },
      note: null,
      selected: id,
      stack: [],
      children: [],
      row: 0,
    });

    const items = await this.deps.plan(id, original.items[id], roots);
    this.set({ action: { id, current: "", freed: 0, done: 0, total: items.length } });

    const onProgress = ({ path, freed }: CleanProgress) => {
      const { scan, action } = this.state;
      if (!action) return;
      const taken = Math.min(freed, scan.sizes[id]);
      this.set({
        action: { ...action, current: path, freed: action.freed + freed, done: action.done + 1 },
        scan: {
          ...scan,
          sizes: { ...scan.sizes, [id]: scan.sizes[id] - taken },
          measured: scan.measured - taken,
        },
      });
    };
    const result = await this.deps.clean(id, items, roots, onProgress);

    // Replace the running estimate with what is actually on disk now.
    let scan = this.state.scan;
    const [left, space] = await Promise.all([this.deps.measure(id, roots), this.deps.diskSpace()]);
    const sizes = { ...scan.sizes, [id]: left };
    const measured = scan.measured + (left - scan.sizes[id]);
    scan = { ...scan, ...(space.total > 0 ? space : {}), sizes, measured };
    sizes.system += unmeasuredBytes(scan) - unmeasuredBytes(original);
    const freed = Math.max(0, before - scan.sizes[id]);
    scan = { ...scan, items: { ...scan.items, [id]: [] } };

    const skipped = result.skipped.length;
    const parts = [`${CATEGORY[id].name}: ${size(freed)} cleared.`];
    if (skipped > 0)
      parts.push(
        `${skipped} ${skipped === 1 ? "item was" : "items were"} in use or protected and left alone.`,
      );
    this.set({
      scan,
      action: null,
      pane: "sidebar",
      freed: this.state.freed + freed,
      note: parts.join(" "),
    });
  }

  /**
   * Stops every running measurement and timer, before the app exits.
   */
  stop(): void {
    this.scanHandle?.cancel();
    this.listHandle?.cancel();
    this.culpritHandle?.cancel();
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    if (this.enrichTimer) clearTimeout(this.enrichTimer);
    this.stopped = true;
  }
}
