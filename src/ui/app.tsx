/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { useAnimationTick, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { basename, dirname } from "node:path";
import { useRef, useState, useSyncExternalStore } from "react";
import {
  CATEGORIES,
  CATEGORY,
  TIER_LABEL,
  type Category,
  type Clearable,
  type Rgb,
  type Tier,
} from "../core/categories";
import { deletesForGood, type Culprit } from "../core/browse";
import { classify, shortAge, type Verdict } from "../core/classify";
import { capacity, gb, size, tilde } from "../core/format";
import type { Item } from "../core/scan";
import { diskSegments, dotCells, ease, type Cell } from "./bar";
import { MAX_ROWS, type AppState, type Store } from "./store";

// One monospace grid. Hierarchy comes from color and weight only; no borders.

const hex = ([r, g, b]: Rgb) =>
  "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const BG: Rgb = [0, 0, 0];
const FG = "#e6e6e6";
const SOFT = "#b5b5b5";
const MUTED = "#8c8c8c";
const FAINT = "#4f4f4f";
const RED = "#f87171";
const GREEN = "#4ade80";
const AMBER = "#fbbf24";

const TIER_COLOR: Record<Tier, string> = { safe: GREEN, review: AMBER, keep: MUTED };

const VERDICT: Record<Verdict, { color: Rgb; text: string; tag: string }> = {
  junk: { color: [74, 222, 128], text: GREEN, tag: "junk" },
  unused: { color: [251, 191, 36], text: AMBER, tag: "unused" },
  yours: { color: [120, 120, 120], text: MUTED, tag: "" },
  system: { color: [100, 116, 139], text: "#7c8aa0", tag: "system" },
};

const ACTION: Record<Clearable, { label: string; doing: string }> = {
  caches: { label: "clear caches", doing: "clearing caches" },
  trash: { label: "empty trash", doing: "emptying the trash" },
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const pct = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";

/**
 * macOS puts a narrow no-break space before AM/PM in screenshot names.
 */
const tidy = (name: string) => name.replace(/[\u{202f}\u{a0}]/gu, " ");

// ---- text that fits ------------------------------------------------------------

const segmenter = new Intl.Segmenter();
const width = (text: string) => Bun.stringWidth(text);

/**
 * Cuts text to at most w columns, ending in an ellipsis when it had to cut.
 */
export function trunc(text: string, w: number): string {
  if (w <= 0) return "";
  if (width(text) <= w) return text;
  let out = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const sw = width(segment);
    if (used + sw > w - 1) break;
    out += segment;
    used += sw;
  }
  return out + "…";
}

const padEnd = (text: string, w: number) =>
  trunc(text, w) + " ".repeat(Math.max(0, w - width(trunc(text, w))));
const padStart = (text: string, w: number) =>
  " ".repeat(Math.max(0, w - width(trunc(text, w)))) + trunc(text, w);

/**
 * A run of text in one style.
 */
interface Chunk {
  t: string;
  fg: string | undefined;
  bg: string | undefined;
  bold: boolean;
}

const k = (t: string, fg: string | undefined = undefined, bold = false): Chunk => ({
  t,
  fg,
  bg: undefined,
  bold,
});

/**
 * Lays chunks into exactly w columns: the last ones are cut with an ellipsis, the rest padded.
 */
function fitChunks(chunks: Chunk[], w: number): Chunk[] {
  const out: Chunk[] = [];
  let left = w;
  for (const chunk of chunks) {
    if (left <= 0) break;
    const cw = width(chunk.t);
    if (cw <= left) {
      out.push(chunk);
      left -= cw;
    } else {
      out.push({ ...chunk, t: trunc(chunk.t, left) });
      left = 0;
    }
  }
  if (left > 0) out.push(k(" ".repeat(left)));
  return out;
}

/**
 * One screen row.
 */
function Line({ chunks, w }: { chunks: Chunk[]; w: number }) {
  return (
    <text>
      {fitChunks(chunks, w).map((chunk, i) => (
        <span
          key={i}
          fg={chunk.fg ?? FG}
          {...(chunk.bg ? { bg: chunk.bg } : {})}
          attributes={chunk.bold ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {chunk.t}
        </span>
      ))}
    </text>
  );
}

/**
 * Left and right chunks on one row, the right ones flush to the edge.
 */
function Split({ left, right, w }: { left: Chunk[]; right: Chunk[]; w: number }) {
  const rw = Math.min(
    w,
    right.reduce((sum, c) => sum + width(c.t), 0),
  );
  const lw = Math.max(0, w - rw - (rw > 0 ? 2 : 0));
  return (
    <Line
      w={w}
      chunks={[...fitChunks(left, lw), ...(rw > 0 ? [k("  ")] : []), ...fitChunks(right, rw)]}
    />
  );
}

// ---- animation -------------------------------------------------------------------

/**
 * A frame counter that only ticks while active, so an idle screen never redraws.
 */
function useSpinner(active: boolean): number {
  const [frame, setFrame] = useState(0);
  useAnimationTick(active ? 12 : undefined, () => setFrame((f) => f + 1));
  return frame;
}

/**
 * Values that ease toward their targets instead of jumping.
 */
function useEased(target: number[]): number[] {
  const shown = useRef<number[]>(target);
  const last = useRef(performance.now());
  const [, redraw] = useState(0);
  const moving =
    target.length !== shown.current.length ||
    target.some((t, i) => Math.abs(t - (shown.current[i] ?? 0)) > 0.0005);
  useAnimationTick(moving ? 30 : undefined, () => {
    const now = performance.now();
    const dt = Math.min(0.25, (now - last.current) / 1000);
    last.current = now;
    shown.current = ease(shown.current, target, dt).next;
    redraw((n) => n + 1);
  });
  if (!moving) last.current = performance.now();
  return shown.current;
}

/**
 * Progress from 0 to 1 over ms after key changes, for things that grow in when they appear.
 */
function useAppear(key: string, ms = 350): number {
  const start = useRef({ key, at: performance.now() });
  if (start.current.key !== key) start.current = { key, at: performance.now() };
  const progress = Math.min(1, (performance.now() - start.current.at) / ms);
  const [, redraw] = useState(0);
  useAnimationTick(progress < 1 ? 30 : undefined, () => redraw((n) => n + 1));
  return 1 - (1 - progress) ** 3;
}

// ---- bars -------------------------------------------------------------------------

function cellsToChunks(cells: Cell[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const cell of cells) {
    const fg = hex(cell.fg);
    const bg = hex(cell.bg);
    const prev = chunks[chunks.length - 1];
    if (prev && prev.fg === fg && prev.bg === bg) prev.t += cell.ch;
    else chunks.push({ t: cell.ch, fg, bg, bold: false });
  }
  return chunks;
}

/**
 * Dim dots under every bar, so an empty bar still shows its length.
 */
const DOT_TRACK: Rgb = [48, 48, 48];

/**
 * A small dot bar for one row: fraction of w cells, in color. It ripples while wave is set.
 */
function miniBar(
  fraction: number,
  w: number,
  color: Rgb,
  wave: number | undefined = undefined,
): Chunk[] {
  return cellsToChunks(
    dotCells([{ fraction: Math.max(0, Math.min(1, fraction)), color }], w, {
      track: DOT_TRACK,
      trackGlyph: "⣀",
      bg: BG,
      wave,
    }),
  );
}

/**
 * The disk, two rows tall, one colored segment per category. Segments ease to
 * their sizes while the scan runs and as things are cleared.
 */
function Meter({ state, w, frame }: { state: AppState; w: number; frame: number }) {
  const segments = diskSegments(state.scan);
  const shown = useEased(segments.map((s) => s.fraction));
  const focus = state.action?.id ?? state.selected;
  const placed = segments.map((s, i) => ({
    fraction: shown[i] ?? 0,
    color: s.id === focus || state.scan.phase === "scanning" ? s.color : mix(s.color, BG, 0.35),
  }));
  // Two rows of dots read as one bar; the ripple runs along the top row while
  // something is being measured or cleared.
  const active = state.scan.phase === "scanning" || state.action !== null;
  const top = cellsToChunks(
    dotCells(placed, w, {
      track: DOT_TRACK,
      trackGlyph: " ",
      bg: BG,
      wave: active ? frame : undefined,
    }),
  );
  const bottom = cellsToChunks(
    dotCells(placed, w, { track: DOT_TRACK, trackGlyph: "⣀", bg: BG, wave: undefined }),
  );
  return (
    <box flexDirection="column">
      <Line w={w} chunks={top} />
      <Line w={w} chunks={bottom} />
    </box>
  );
}

// ---- header ---------------------------------------------------------------------

/**
 * Cuts text from the left to at most w columns, so the end of a path stays visible.
 */
function truncLeft(text: string, w: number): string {
  if (w <= 0) return "";
  if (width(text) <= w) return text;
  const parts = [...segmenter.segment(text)].map((s) => s.segment);
  let out = "";
  let used = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const sw = width(parts[i]!);
    if (used + sw > w - 1) break;
    out = parts[i] + out;
    used += sw;
  }
  return "…" + out;
}

function TopLine({ state, w, frame }: { state: AppState; w: number; frame: number }) {
  const { scan, action } = state;
  const spin = SPINNER[frame % SPINNER.length]!;
  // The status sits flush right and never moves; the path to its left grows and shrinks.
  let path = "";
  let status: Chunk[];
  if (action) {
    const color = hex(CATEGORY[action.id].color);
    path = tilde(action.current);
    status = [
      k(`${size(action.freed)}`, FG, true),
      k(action.total > 0 ? `  ${action.done}/${action.total}` : "", MUTED),
      k(`  ${spin} `, color),
      k(ACTION[action.id].doing, color),
    ];
  } else if (scan.phase === "scanning") {
    path = tilde(scan.current);
    status = [k(`${spin} `, GREEN), k("measuring", FG)];
  } else if (scan.blocked.length > 0) {
    status = [k(`${scan.blocked.length} folders unreadable · grant Full Disk Access`, FAINT)];
  } else {
    status = [k("scan complete", FAINT)];
  }
  const statusW = status.reduce((sum, c) => sum + width(c.t), 0);
  const pathW = Math.max(0, w - 30 - statusW - 2);
  const shown = truncLeft(path, pathW);
  const right = shown ? [k(shown, FAINT), k("  "), ...status] : status;
  return (
    <Split w={w} left={[k("fix-storage", FG, true), k("  Macintosh HD", FAINT)]} right={right} />
  );
}

function Totals({ state, w }: { state: AppState; w: number }) {
  const { scan } = state;
  const known = scan.total > 0;
  const left = [
    k(known ? gb(scan.used) : "…", FG, true),
    k(known ? ` used of ${capacity(scan.total)}` : " used", MUTED),
    k("  ·  ", FAINT),
    k(known ? gb(scan.available) : "…"),
    k(" free", MUTED),
    k("  ·  ", FAINT),
    k(known ? pct(scan.used, scan.total) : "…"),
    k(" full", MUTED),
  ];
  const right = state.freed > 0 ? [k(`~${gb(state.freed)} cleared this session`, GREEN)] : [];
  return <Split w={w} left={left} right={right} />;
}

// ---- left column: categories -------------------------------------------------

/**
 * Width of the categories column.
 */
export function sidebarWidth(cols: number): number {
  return cols >= 110 ? 44 : 30;
}

/**
 * Below this many columns the item list drops its bar and share columns.
 */
const COMPACT_LIST = 70;

function CategoryLine({
  category,
  state,
  frame,
  sw,
}: {
  category: Category;
  state: AppState;
  frame: number;
  sw: number;
}) {
  const selected = state.selected === category.id;
  const focused = selected && state.pane === "sidebar";
  const bytes = state.scan.sizes[category.id];
  const largest = Math.max(1, ...CATEGORIES.map((c) => state.scan.sizes[c.id]));
  const clearing = state.action?.id === category.id;
  // The category being cleared pulses.
  const color = clearing
    ? mix(category.color, [255, 255, 255], (Math.sin(frame / 2) + 1) / 4)
    : category.color;
  return (
    <Line
      w={sw}
      chunks={[
        k(focused ? "› " : selected ? "· " : "  ", selected ? hex(category.color) : FAINT, true),
        k("■ ", hex(color)),
        k(padEnd(category.name, 13), selected ? FG : SOFT, selected),
        k(padStart(gb(bytes), 9) + "  ", selected ? FG : MUTED),
        ...(sw >= 44
          ? miniBar(
              bytes / largest,
              14,
              color,
              state.scan.phase === "scanning" || clearing
                ? frame + category.id.length * 3
                : undefined,
            )
          : []),
      ]}
    />
  );
}

function QuickWins({ state, store, sw }: { state: AppState; store: Store; sw: number }) {
  if (state.scan.phase !== "done")
    return <Line w={sw} chunks={[k("  looking for space you can get back…", FAINT)]} />;
  const ids = (["caches", "trash"] as Clearable[]).filter(
    (id) => store.canClear(id) || state.action?.id === id,
  );
  if (ids.length === 0)
    return <Line w={sw} chunks={[k("  nothing left that is safe to clear", FAINT)]} />;
  const total = ids.reduce((sum, id) => sum + state.scan.sizes[id], 0);
  const busy = state.action !== null || state.removing !== null;
  return (
    <box flexDirection="column">
      <Line w={sw} chunks={[k("  "), k(gb(total), GREEN, true), k(" safe to clear", MUTED)]} />
      {ids.map((id) => {
        const armed = state.confirm?.kind === "category" && state.confirm.id === id;
        return (
          <Line
            key={id}
            w={sw}
            chunks={
              armed
                ? [
                    k("  ■ ", hex(CATEGORY[id].color)),
                    k(`c again to delete ${gb(state.scan.sizes[id])}`, RED, true),
                  ]
                : [
                    k("  ■ ", hex(CATEGORY[id].color)),
                    k(padEnd(ACTION[id].label, 14), busy ? FAINT : MUTED),
                    k(padStart(gb(state.scan.sizes[id]), 9), busy ? FAINT : MUTED),
                  ]
            }
          />
        );
      })}
    </box>
  );
}

function Categories({
  state,
  store,
  frame,
  h,
  sw,
}: {
  state: AppState;
  store: Store;
  frame: number;
  h: number;
  sw: number;
}) {
  const quick = 3;
  return (
    <box flexDirection="column" width={sw} height={h}>
      <Line w={sw} chunks={[k("  categories", state.pane === "sidebar" ? MUTED : FAINT)]} />
      {CATEGORIES.map((category) => (
        <CategoryLine key={category.id} category={category} state={state} frame={frame} sw={sw} />
      ))}
      <box height={Math.max(0, h - CATEGORIES.length - 1 - quick)} />
      <QuickWins state={state} store={store} sw={sw} />
    </box>
  );
}

// ---- right column: what is inside --------------------------------------------

const relative = (from: string, path: string) =>
  path.startsWith(from + "/") ? path.slice(from.length + 1) : path;

/**
 * Is a culprit worth printing under its folder without being asked?
 */
function telling(item: Item, culprit: Culprit | "pending" | undefined): culprit is Culprit {
  if (!culprit || culprit === "pending" || culprit.chain.length === 0) return false;
  const last = culprit.chain[culprit.chain.length - 1]!;
  return last.size >= 1e9 || last.size >= item.size * 0.6;
}

function culpritChunks(item: Item, culprit: Culprit, state: AppState, color: string): Chunk[] {
  const last = culprit.chain[culprit.chain.length - 1]!;
  const verdict = classify(last, state.selected).verdict;
  return [
    k("      └ mostly in ", FAINT),
    k(tidy(relative(item.path, last.path)) + (last.dir ? "/" : ""), color),
    k(`  ${size(last.size)}`, MUTED),
    k(` · ${pct(last.size, item.size)}`, FAINT),
    ...(VERDICT[verdict].tag && verdict !== "yours"
      ? [k(`  ${VERDICT[verdict].tag}`, VERDICT[verdict].text)]
      : []),
  ];
}

/**
 * Columns right of the name: verdict, size, bar, share, last used.
 */
const ROW_TAIL = 6 + 1 + 8 + 2 + 12 + 1 + 4 + 1 + 6;

/**
 * The same columns without the bar and share, for narrow terminals.
 */
const ROW_TAIL_COMPACT = 6 + 1 + 8 + 1 + 6;

/**
 * The lines for one item: its row, and under the highlighted one what it is and what you can do.
 */
function itemLines(
  item: Item,
  index: number,
  max: number,
  grow: number,
  state: AppState,
  store: Store,
  w: number,
): Chunk[][] {
  const category = CATEGORY[state.selected];
  const selected = state.row === index;
  const focused = selected && state.pane === "list";
  const label = store.label(item);
  const verdict = VERDICT[label.verdict];
  const used = state.usage[item.path];
  const name = tidy(basename(item.path) || item.path) + (item.dir ? "/" : "");
  const compact = w < COMPACT_LIST;
  const nameW = Math.max(8, w - 4 - (compact ? ROW_TAIL_COMPACT : ROW_TAIL));
  const where = state.stack.length === 0 ? "  " + tilde(dirname(item.path)) : "";
  const nameChunk = trunc(name, nameW - 1);
  const stale = used && Date.now() - used.at > 180 * 864e5;
  const barColor =
    label.verdict === "yours"
      ? selected
        ? category.color
        : mix(category.color, BG, 0.4)
      : verdict.color;
  const lines: Chunk[][] = [
    [
      k(focused ? "› " : selected ? "· " : "  ", focused ? hex(category.color) : FAINT, true),
      k(item.dir ? "▸ " : "  ", item.dir ? hex(category.color) : FAINT),
      k(nameChunk, state.removing === item.path ? FAINT : selected ? FG : SOFT, selected),
      k(padEnd(where, nameW - 1 - width(nameChunk)) + " ", FAINT),
      k(padEnd(verdict.tag, 6) + " ", verdict.text),
      k(padStart(size(item.size), 8) + (compact ? "" : "  "), selected ? FG : MUTED),
      ...(compact
        ? []
        : [
            ...miniBar((item.size / Math.max(1, max)) * grow, 12, barColor),
            k(" " + padStart(pct(item.size, store.scopeSize()), 4), FAINT),
          ]),
      k(" " + padStart(used ? shortAge(Date.now() - used.at) : "", 6), stale ? AMBER : FAINT),
    ],
  ];
  const culprit = item.dir ? state.culprits[item.path] : undefined;
  if (!selected) {
    if (telling(item, culprit)) lines.push(culpritChunks(item, culprit, state, MUTED));
    return lines;
  }

  if (label.reason || label.verdict !== "yours") {
    lines.push([
      k(
        "      " + (label.verdict === "unused" ? "probably unused" : label.verdict),
        verdict.text,
        true,
      ),
      k(label.reason ? ` · ${label.reason}` : "", MUTED),
    ]);
  }
  const hasCulprit = !!culprit && culprit !== "pending" && culprit.chain.length > 0;
  if (item.dir && culprit === "pending")
    lines.push([k("      └ finding what is taking the space…", FAINT)]);
  else if (hasCulprit) lines.push(culpritChunks(item, culprit, state, FG));
  else if (item.dir && culprit && culprit !== "pending" && culprit.top.length > 1) {
    lines.push([
      k("      └ spread out: ", FAINT),
      k(culprit.top.map((t) => `${tidy(basename(t.path))} ${size(t.size)}`).join("  ·  "), MUTED),
    ]);
  }

  const forGood = deletesForGood(state.selected);
  const armed = state.confirm?.kind === "item" && state.confirm.path === item.path;
  const blocked = store.blocked(item);
  const hint = (key: string, text: string, keyColor = FG) => [
    k(key, keyColor, true),
    k(` ${text}   `, MUTED),
  ];
  if (state.removing === item.path) {
    lines.push([k("      " + (forGood ? "deleting…" : "moving to trash…"), MUTED)]);
  } else {
    lines.push([
      k("      "),
      ...(item.dir ? hint("→", "open") : []),
      ...(hasCulprit ? hint("g", "go to culprit", AMBER) : []),
      ...hint("o", "reveal in finder"),
      ...(state.selected === "system"
        ? []
        : armed
          ? [
              k(
                forGood
                  ? `d again to delete ${size(item.size)} for good`
                  : `d again to move ${size(item.size)} to trash`,
                RED,
                true,
              ),
            ]
          : blocked
            ? [k(`can't remove: ${blocked.toLowerCase()}`, FAINT)]
            : hint("d", forGood ? "delete" : "move to trash", RED)),
    ]);
  }
  return lines;
}

function emptyText(state: AppState, store: Store): string {
  const id = state.selected;
  if (state.listing) return "measuring what is inside…";
  if (state.junkOnly) return "nothing here looks like junk · f to show everything";
  if (state.scan.phase === "scanning" && state.stack.length === 0) return "still measuring…";
  if (id === "system")
    return "macOS itself, snapshots, swap and anything this scan could not read. macOS manages it.";
  if (state.stack.length > 0) return "empty, or could not be read";
  if (store.allEntries().length === 0 && state.scan.sizes[id] < 1e6) return "nothing here";
  return "nothing large enough to list";
}

function Inside({ state, store, w, h }: { state: AppState; store: Store; w: number; h: number }) {
  const category = CATEGORY[state.selected];
  const scope = store.scopeSize();
  const top = state.stack[state.stack.length - 1];
  const entries = store.entries();
  const all = store.allEntries();
  const max = entries[0]?.size ?? 1;
  const grow = useAppear(
    `${state.selected}:${state.stack.length}:${top?.path ?? ""}:${state.scan.phase}`,
  );

  const crumbs: Chunk[] = [];
  const parts = [category.name, ...state.stack.map((s) => basename(s.path))];
  parts.forEach((part, i) => {
    if (i > 0) crumbs.push(k(" / ", FAINT));
    crumbs.push(
      k(part, i === parts.length - 1 ? hex(category.color) : MUTED, i === parts.length - 1),
    );
  });
  const scopeRight = [
    k(gb(scope), FG, true),
    k(
      state.scan.total > 0
        ? `  est. ${pct(scope, state.scan.total)} of capacity  `
        : "  estimated  ",
      MUTED,
    ),
    k(TIER_LABEL[category.tier].toLowerCase(), TIER_COLOR[category.tier]),
  ];
  const canClear = !top && store.canClear(category.id);
  const armed = canClear && state.confirm?.kind === "category" && state.confirm.id === category.id;
  const clearRight = !canClear
    ? []
    : armed
      ? [k(`c again to delete all ${gb(scope)}`, RED, true)]
      : [k("c", GREEN, true), k(" " + ACTION[category.id as Clearable].label, MUTED)];

  const { junk, unused } = store.reclaimable();
  const showReclaim = junk + unused >= 1e6 || state.junkOnly;
  const reclaimLeft = [
    ...(junk >= 1e6 ? [k(size(junk), GREEN, true), k(" junk", MUTED)] : []),
    ...(junk >= 1e6 && unused >= 1e6 ? [k("  ·  ", FAINT)] : []),
    ...(unused >= 1e6 ? [k(size(unused), AMBER, true), k(" probably unused", MUTED)] : []),
  ];
  const reclaimRight = [
    k("f", state.junkOnly ? AMBER : FG, true),
    k(state.junkOnly ? " show everything" : " show only junk & unused", MUTED),
  ];

  const header = 2 + (showReclaim ? 1 : 0) + 2;
  const listH = Math.max(1, h - header);

  // Flatten rows into screen lines, then show a window that keeps the highlighted row's lines in view.
  const lines: Chunk[][] = [];
  let selStart = 0;
  let selEnd = 0;
  entries.forEach((item, index) => {
    const its = itemLines(item, index, max, grow, state, store, w);
    if (index === state.row) {
      selStart = lines.length;
      selEnd = lines.length + its.length;
    }
    lines.push(...its);
  });
  if (all.length > MAX_ROWS) lines.push([k(`    … and ${all.length - MAX_ROWS} smaller`, FAINT)]);
  let offset = 0;
  if (selEnd > listH) offset = Math.min(selEnd - listH + 1, selStart);
  offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - listH)));
  const visible = lines.slice(offset, offset + listH);

  return (
    <box flexDirection="column" width={w} height={h}>
      <Split w={w} left={crumbs} right={scopeRight} />
      <Split w={w} left={[k(top ? tilde(top.path) : category.blurb, FAINT)]} right={clearRight} />
      {showReclaim ? <Split w={w} left={reclaimLeft} right={reclaimRight} /> : null}
      <Line w={w} chunks={[]} />
      <Split
        w={w}
        left={[
          k(
            `  ${all.length} ${all.length === 1 ? "item" : "items"}${state.junkOnly ? " labelled junk or unused" : ""}${state.listing ? " · measuring" : ""}`,
            state.pane === "list" ? MUTED : FAINT,
          ),
        ]}
        right={[k("last used", FAINT)]}
      />
      {entries.length === 0 ? (
        <Line w={w} chunks={[k("    " + emptyText(state, store), FAINT)]} />
      ) : (
        visible.map((chunks, i) => <Line key={offset + i} w={w} chunks={chunks} />)
      )}
    </box>
  );
}

// ---- bottom line -------------------------------------------------------------------

function BottomLine({ state, w }: { state: AppState; w: number }) {
  const keys: Array<[string, string]> =
    state.pane === "list"
      ? [
          ["↑↓", "move"],
          ["→", "open"],
          ["←", "back"],
          ["g", "culprit"],
          ["f", "junk only"],
          ["o", "reveal"],
          ["d", "remove"],
          ["q", "quit"],
        ]
      : [
          ["↑↓", "category"],
          ["→", "look inside"],
          ["f", "junk only"],
          ["c", "clear"],
          ["r", "rescan"],
          ["q", "quit"],
        ];
  const left = keys.flatMap(([key, label]) => [k(key, MUTED, true), k(` ${label}   `, FAINT)]);
  return (
    <Split w={w} left={state.note ? [] : left} right={state.note ? [k(state.note, MUTED)] : []} />
  );
}

/**
 * Keys that arm or confirm a removal.
 */
const DESTRUCTIVE = new Set(["c", "d", "backspace", "delete"]);

// ---- keys ----------------------------------------------------------------------------

/**
 * Applies one key to the store. Returns true when the app should quit.
 */
export function handleKey(store: Store, name: string, ctrl: boolean, repeated = false): boolean {
  if (ctrl && name === "c") return true;
  if (ctrl) return false;
  // A held key auto-repeats; it must never stand in for the second press of a confirm.
  if (repeated && DESTRUCTIVE.has(name)) return false;
  const state = store.get();
  if (name === "q") return true;
  if (name === "r") return (store.rescan(), false);
  if (name === "f") return (store.toggleJunkOnly(), false);

  if (state.pane === "sidebar") {
    switch (name) {
      case "up":
      case "k":
        store.moveCategory(-1);
        break;
      case "down":
      case "j":
        store.moveCategory(1);
        break;
      case "right":
      case "l":
      case "return":
      case "enter":
      case "tab":
        store.setPane("list");
        break;
      case "c": {
        if (store.canClear(state.selected)) store.press(state.selected);
        else {
          const id = store.suggestion();
          if (id) store.press(id);
        }
        break;
      }
    }
    return false;
  }

  switch (name) {
    case "up":
    case "k":
      store.moveRow(-1);
      break;
    case "down":
    case "j":
      store.moveRow(1);
      break;
    case "pageup":
      store.moveRow(-10);
      break;
    case "pagedown":
      store.moveRow(10);
      break;
    case "home":
      store.moveRow(-Infinity);
      break;
    case "end":
      store.moveRow(Infinity);
      break;
    case "right":
    case "l":
    case "return":
    case "enter":
      store.open();
      break;
    case "left":
    case "h":
    case "escape":
      store.back();
      break;
    case "tab":
      store.setPane("sidebar");
      break;
    case "g":
      store.goToCulprit();
      break;
    case "o":
    case "space":
      void store.reveal();
      break;
    case "d":
    case "backspace":
    case "delete":
      store.removeItem();
      break;
    case "c":
      if (state.stack.length === 0 && store.canClear(state.selected)) store.press(state.selected);
      break;
  }
  return false;
}

// ---- app -------------------------------------------------------------------------------

/**
 * The whole screen.
 */
export function App({ store, onQuit }: { store: Store; onQuit: () => void }) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const { width: cols, height: rows } = useTerminalDimensions();
  const busy =
    state.scan.phase === "scanning" ||
    state.listing ||
    state.action !== null ||
    state.removing !== null;
  const frame = useSpinner(busy);

  useKeyboard((key) => {
    if (handleKey(store, key.name, key.ctrl, key.repeated === true)) onQuit();
  });

  const w = Math.max(40, cols - 4);
  const measuredLine =
    state.scan.phase === "scanning" ||
    (state.scan.total > 0 && state.scan.measured > state.scan.used);
  const head = 1 + 1 + (measuredLine ? 1 : 0) + 2 + 1;
  const mainH = Math.max(CATEGORIES.length + 5, rows - 2 - head - 2);
  const sw = sidebarWidth(cols);
  const insideW = Math.max(20, w - sw - 3);
  const excess = state.scan.measured - state.scan.used;

  return (
    <box
      flexDirection="column"
      width={cols}
      height={rows}
      backgroundColor={hex(BG)}
      paddingX={2}
      paddingY={1}
    >
      <TopLine state={state} w={w} frame={frame} />
      <Totals state={state} w={w} />
      {measuredLine ? (
        <Line
          w={w}
          chunks={[
            k(
              state.scan.phase === "scanning"
                ? `${gb(state.scan.measured)} measured so far`
                : `${gb(state.scan.measured)} measured · ${size(excess)} above filesystem usage`,
              MUTED,
            ),
          ]}
        />
      ) : null}
      <Meter state={state} w={w} frame={frame} />
      <Line w={w} chunks={[]} />
      <box flexDirection="row" height={mainH} gap={3}>
        <Categories state={state} store={store} frame={frame} h={mainH} sw={sw} />
        <Inside state={state} store={store} w={insideW} h={mainH} />
      </box>
      <Line w={w} chunks={[]} />
      <BottomLine state={state} w={w} />
    </box>
  );
}
