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
 * Braille glyphs with both dot columns lit, by how many dot rows are lit from the bottom.
 */
const FULL = ["⠀", "⣀", "⣤", "⣶", "⣿"];

/**
 * The same with only the left dot column lit, for a bar that ends mid-cell.
 */
const LEFT = ["⠀", "⡀", "⡄", "⡆", "⡇"];

/**
 * How a dot bar row is drawn.
 */
export interface DotOptions {
  /**
   * Color of the unlit track.
   */
  track: Rgb;
  /**
   * Glyph drawn on the unlit track: a dotted baseline, or blank.
   */
  trackGlyph: string;
  /**
   * Background behind every cell.
   */
  bg: Rgb;
  /**
   * Animation frame for the ripple, or undefined for a still bar.
   */
  wave: number | undefined;
}

/**
 * How many dot rows the ripple takes out of cell i at this frame: a dip that
 * sweeps left to right across the lit part of the bar, then starts over.
 */
export function rippleDip(i: number, lit: number, wave: number | undefined): number {
  if (wave === undefined || lit <= 0) return 0;
  const span = lit + 6;
  const crest = (((wave % span) + span) % span) - 3;
  const d = Math.abs(i - crest);
  return d === 0 ? 2 : d === 1 ? 1 : 0;
}

/**
 * Lays segments out across width cells in braille dots, two dot columns per
 * cell. A lit cell is a full block of dots; the ripple, when animating,
 * lowers a few cells' dots as it passes.
 */
export function dotCells(
  segments: Array<{ fraction: number; color: Rgb }>,
  width: number,
  options: DotOptions,
): Cell[] {
  const halves = width * 2;
  const spans: Array<{ start: number; end: number; color: Rgb }> = [];
  let at = 0;
  for (const segment of segments) {
    const length = Math.max(0, segment.fraction) * halves;
    if (length <= 0) continue;
    spans.push({ start: at, end: Math.min(halves, at + length), color: segment.color });
    at += length;
  }
  // A half-cell is lit when the bar covers at least half of it.
  const colorAt = (half: number): Rgb | undefined =>
    spans.find((s) => half + 0.5 >= s.start && half + 0.5 < s.end)?.color;
  const lit = Math.ceil(Math.min(halves, at) / 2);
  const cells: Cell[] = [];
  for (let i = 0; i < width; i++) {
    const left = colorAt(i * 2);
    const right = colorAt(i * 2 + 1);
    if (!left) {
      cells.push({ ch: options.trackGlyph, fg: options.track, bg: options.bg });
      continue;
    }
    const height = 4 - rippleDip(i, lit, options.wave);
    cells.push({ ch: (right ? FULL : LEFT)[height]!, fg: left, bg: options.bg });
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
