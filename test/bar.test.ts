import { expect, test } from "bun:test";
import { dotCells, ease, rippleDip } from "../src/ui/bar";

const red: [number, number, number] = [255, 0, 0];
const blue: [number, number, number] = [0, 0, 255];
const grey: [number, number, number] = [48, 48, 48];
const black: [number, number, number] = [0, 0, 0];
const still = { track: grey, trackGlyph: "⣀", bg: black, wave: undefined };

test("dot bars fill whole cells, end on a half cell, and show the track after", () => {
  // 0.3125 of 8 cells is 5 half-cells: two full cells, then the left column of the third.
  const cells = dotCells([{ fraction: 0.3125, color: red }], 8, still);
  expect(cells.map((c) => c.ch).join("")).toBe("⣿⣿⡇⣀⣀⣀⣀⣀");
  expect(cells[2]).toMatchObject({ fg: red });
  expect(cells[3]).toMatchObject({ fg: grey });
});

test("each segment keeps its own color", () => {
  const cells = dotCells(
    [
      { fraction: 0.25, color: red },
      { fraction: 0.25, color: blue },
    ],
    8,
    still,
  );
  expect(cells.slice(0, 4).map((c) => c.fg)).toEqual([red, red, blue, blue]);
});

test("the ripple dips the dots it passes and leaves a still bar alone", () => {
  const rippled = dotCells([{ fraction: 1, color: red }], 10, { ...still, wave: 7 });
  // At frame 7 the crest sits on cell 4: two rows down there, one row down beside it.
  expect(rippled.map((c) => c.ch).join("")).toBe("⣿⣿⣿⣶⣤⣶⣿⣿⣿⣿");
  expect(rippleDip(4, 10, undefined)).toBe(0);
});

test("easing converges on the target and reports when it stops moving", () => {
  let shown = [0];
  let moving = true;
  for (let i = 0; i < 200 && moving; i++) ({ next: shown, moving } = ease(shown, [1], 1 / 30));
  expect(moving).toBe(false);
  expect(shown[0]).toBe(1);
});
