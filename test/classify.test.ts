import { expect, test } from "bun:test";
import { age, classify, isWhole } from "../src/core/classify";

const DAY = 24 * 3600 * 1000;
const now = Date.UTC(2026, 10, 21);
const dir = (path: string) => ({ path, size: 1e9, dir: true });
const file = (path: string) => ({ path, size: 1e9, dir: false });

test("things that rebuild themselves are junk", () => {
  expect(classify(dir("/Users/a/Code/app/node_modules"), "documents").verdict).toBe("junk");
  expect(classify(dir("/Users/a/Code/app/.next"), "documents").verdict).toBe("junk");
  expect(
    classify(dir("/Users/a/Library/Developer/Xcode/DerivedData/App-x"), "developer").verdict,
  ).toBe("junk");
});

test("everything in caches and trash is junk, everything in system is system", () => {
  expect(classify(dir("/Users/a/Library/Caches/com.app"), "caches").verdict).toBe("junk");
  expect(classify(file("/Users/a/.Trash/old.mov"), "trash").verdict).toBe("junk");
  expect(classify(dir("/private/var/vm"), "system")).toEqual({
    verdict: "system",
    reason: "managed by macOS",
  });
});

test("installers are junk and old downloaded archives are probably unused", () => {
  expect(classify(file("/Users/a/Downloads/Figma.dmg"), "documents").verdict).toBe("junk");
  expect(classify(file("/Users/a/Downloads/photos.zip"), "documents").verdict).toBe("unused");
});

test("old screen captures are unused, recent ones are yours", () => {
  const capture = file("/Users/a/Desktop/Screen Recording 2025-03-02 at 1.37.29 PM.mov");
  expect(classify(capture, "documents", { at: now - 30 * DAY, kind: "changed" }, now).verdict).toBe(
    "unused",
  );
  expect(classify(capture, "documents", { at: now - 2 * DAY, kind: "changed" }, now).verdict).toBe(
    "yours",
  );
});

test("tool-owned data is left to the tool", () => {
  expect(
    classify(file("/Users/a/Library/Containers/com.docker.docker/Data/Docker.raw"), "developer")
      .verdict,
  ).toBe("system");
  expect(classify(dir("/opt/homebrew/Cellar/node"), "developer").verdict).toBe("system");
});

test("with no telling name, age decides", () => {
  const item = dir("/Users/a/Documents/project");
  expect(classify(item, "documents", { at: now - 400 * DAY, kind: "opened" }, now)).toEqual({
    verdict: "unused",
    reason: "not opened in 1 year",
  });
  expect(classify(item, "documents", { at: now - 3 * DAY, kind: "changed" }, now)).toEqual({
    verdict: "yours",
    reason: "changed 3 days ago",
  });
  expect(classify(item, "documents").verdict).toBe("yours");
});

test("whole folders stop a culprit search", () => {
  expect(isWhole("/Applications/Xcode.app")).toBe(true);
  expect(isWhole("/a/node_modules")).toBe(true);
  expect(isWhole("/a/src")).toBe(false);
  expect(age(45 * DAY)).toBe("1 month");
});
