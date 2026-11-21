import { expect, test } from "bun:test";
import { barCells, ease } from "../src/ui/bar";

test("a bar boundary inside a cell draws a partial block over the next color", () => {
  const red: [number, number, number] = [255, 0, 0];
  const blue: [number, number, number] = [0, 0, 255];
  const empty: [number, number, number] = [0, 0, 0];
  const cells = barCells(
    [
      { fraction: 0.3125, color: red },
      { fraction: 0.25, color: blue },
    ],
    8,
    empty,
  );
  // 0.3125 of 8 cells is 2.5 cells: two full, then a half block of red on blue.
  expect(cells.slice(0, 3).map((c) => c.ch)).toEqual(["█", "█", "▌"]);
  expect(cells[2]).toMatchObject({ fg: red, bg: blue });
  expect(cells[7]?.ch).toBe(" ");
});

test("easing converges on the target and reports when it stops moving", () => {
  let shown = [0];
  let moving = true;
  for (let i = 0; i < 200 && moving; i++) ({ next: shown, moving } = ease(shown, [1], 1 / 30));
  expect(moving).toBe(false);
  expect(shown[0]).toBe(1);
});
