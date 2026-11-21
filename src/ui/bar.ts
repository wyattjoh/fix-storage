import { CATEGORIES, type Rgb } from "../core/categories";
import type { ScanSnapshot } from "../core/scan";

/**
 * Id of the segment for used space no folder accounts for yet.
 */
export const UNMEASURED = "unmeasured";

/**
 * One category's share of the disk bar.
 */
export interface Segment {
  id: string;
  color: Rgb;
  /**
   * Share of the whole disk, 0..1.
   */
  fraction: number;
}

/**
 * The disk bar's segments: one per category, then whatever is used but unmeasured.
 */
export function diskSegments({ sizes, total, used }: ScanSnapshot): Segment[] {
  const measured = CATEGORIES.reduce((sum, c) => sum + sizes[c.id], 0);
  const occupied = total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;
  // Fit estimates into the occupied space, keeping their relative proportions.
  const scale = measured > 0 ? Math.min(1 / Math.max(total, 1), occupied / measured) : 0;
  const segments = CATEGORIES.map<Segment>((c) => ({
    id: c.id,
    color: c.color,
    fraction: sizes[c.id] * scale,
  }));
  segments.push({
    id: UNMEASURED,
    color: [90, 90, 90],
    fraction: Math.max(0, occupied - measured * scale),
  });
  return segments;
}

/**
 * One terminal cell of a bar.
 */
export interface Cell {
  ch: string;
  fg: Rgb;
  bg: Rgb;
}

/**
 * Left-aligned partial blocks, from one eighth to seven eighths of a cell.
 */
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/**
 * Lays segments out across width cells at one-eighth-cell resolution. A cell
 * where one segment ends and the next begins draws the first as a partial
 * block over the second's color, so small categories still show.
 */
export function barCells(
  segments: Array<{ fraction: number; color: Rgb }>,
  width: number,
  empty: Rgb,
): Cell[] {
  const eighths = width * 8;
  const spans: Array<{ start: number; end: number; color: Rgb }> = [];
  let at = 0;
  for (const segment of segments) {
    const length = Math.max(0, segment.fraction) * eighths;
    if (length <= 0) continue;
    spans.push({ start: at, end: Math.min(eighths, at + length), color: segment.color });
    at += length;
  }
  const colorAt = (pos: number): Rgb =>
    spans.find((s) => pos >= s.start && pos < s.end)?.color ?? empty;
  const cells: Cell[] = [];
  for (let i = 0; i < width; i++) {
    const left = colorAt(i * 8);
    const right = colorAt(i * 8 + 7.999);
    if (left === right) {
      cells.push({ ch: left === empty ? " " : "█", fg: left, bg: empty });
      continue;
    }
    // How much of the cell the left color covers, in eighths.
    const boundary =
      spans.find((s) => s.color === left && s.end > i * 8 && s.end < (i + 1) * 8)?.end ?? i * 8 + 4;
    const covered = Math.max(1, Math.min(7, Math.round(boundary - i * 8)));
    cells.push({ ch: EIGHTHS[covered]!, fg: left, bg: right });
  }
  return cells;
}

/**
 * Moves each shown value a step toward its target, so a bar grows and shrinks
 * smoothly instead of jumping. Returns the next values and whether any is still moving.
 */
export function ease(
  shown: number[],
  target: number[],
  dt: number,
  rate = 10,
): { next: number[]; moving: boolean } {
  const k = 1 - Math.exp(-rate * dt);
  let moving = false;
  const next = target.map((t, i) => {
    const s = shown[i] ?? 0;
    const v = s + (t - s) * k;
    if (Math.abs(t - v) > 0.0005) {
      moving = true;
      return v;
    }
    return t;
  });
  return { next, moving };
}
