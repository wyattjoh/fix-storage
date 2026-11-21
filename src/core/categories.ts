import { homedir } from "node:os";
import { join } from "node:path";

/**
 * What a measured folder counts toward.
 */
export type CategoryId =
  | "apps"
  | "developer"
  | "photos"
  | "movies"
  | "documents"
  | "music"
  | "system"
  | "caches"
  | "trash";

/**
 * safe:   regenerates on its own or was already thrown away; clearing loses nothing.
 * review: yours to decide; the tool shows it but never deletes it for you.
 * keep:   personal data or managed by the system; never offered for deletion.
 */
export type Tier = "safe" | "review" | "keep";

/**
 * A color as red, green and blue, 0 to 255.
 */
export type Rgb = [number, number, number];

/**
 * A category of disk usage, how it is drawn, and how freely it may be cleared.
 */
export interface Category {
  id: CategoryId;
  name: string;
  color: Rgb;
  tier: Tier;
  blurb: string;
}

/**
 * Order is the order of segments in the bar and of the legend, row by row.
 */
export const CATEGORIES: Category[] = [
  {
    id: "apps",
    name: "Apps",
    color: [59, 130, 246],
    tier: "review",
    blurb: "Applications and the data they keep.",
  },
  {
    id: "developer",
    name: "Developer",
    color: [34, 197, 94],
    tier: "review",
    blurb: "Toolchains, SDKs, simulators, containers and tool folders.",
  },
  {
    id: "photos",
    name: "Photos",
    color: [236, 72, 153],
    tier: "keep",
    blurb: "Your pictures and photo libraries.",
  },
  {
    id: "movies",
    name: "Movies",
    color: [139, 92, 246],
    tier: "keep",
    blurb: "Your videos and video projects.",
  },
  {
    id: "documents",
    name: "Documents",
    color: [34, 211, 238],
    tier: "review",
    blurb: "Documents, Desktop, Downloads and other folders in your home.",
  },
  {
    id: "music",
    name: "Music",
    color: [234, 179, 8],
    tier: "keep",
    blurb: "Your music and audio projects.",
  },
  {
    id: "system",
    name: "System data",
    color: [156, 163, 175],
    tier: "keep",
    blurb: "macOS, logs, snapshots and anything this scan cannot read. The system manages these.",
  },
  {
    id: "caches",
    name: "Caches",
    color: [249, 115, 22],
    tier: "safe",
    blurb: "Apps and tools rebuild these when they need them.",
  },
  {
    id: "trash",
    name: "Trash",
    color: [239, 68, 68],
    tier: "safe",
    blurb: "Things you have already deleted.",
  },
];

/**
 * Categories by id.
 */
export const CATEGORY: Record<CategoryId, Category> = Object.fromEntries(
  CATEGORIES.map((c) => [c.id, c]),
) as Record<CategoryId, Category>;

/**
 * How each tier is named on screen.
 */
export const TIER_LABEL: Record<Tier, string> = {
  safe: "Safe to clear",
  review: "Review first",
  keep: "Keep",
};

/**
 * A folder the scan measures, and the category it counts toward.
 */
export interface Root {
  path: string;
  /**
   * System data is otherwise whatever the disk reports beyond what was measured; a system root lists where some of it is.
   */
  category: CategoryId;
  /**
   * Category for the dot-folders directly inside this root, when it differs.
   */
  hidden: CategoryId | undefined;
}

/**
 * Folders the scan measures on a Mac, and the category each one counts toward. A root
 * nested inside another root is measured on its own and left out of the outer
 * one, so nothing is counted twice (Xcode's DerivedData counts as a cache, not
 * as Developer).
 */
export function roots(home: string = homedir()): Root[] {
  const h = (...parts: string[]) => join(home, ...parts);
  const r = (
    path: string,
    category: CategoryId,
    hidden: CategoryId | undefined = undefined,
  ): Root => ({
    path,
    category,
    hidden,
  });
  return [
    r("/Applications", "apps"),
    r(h("Applications"), "apps"),
    // Everything else apps keep: Application Support, Containers, Mail and so on.
    r(h("Library"), "apps"),
    // Listed on their own so each app's folder is measured separately.
    r(h("Library/Application Support"), "apps"),
    r(h("Library/Containers"), "apps"),
    r(h("Library/Group Containers"), "apps"),
    r("/Library/Application Support", "apps"),

    r(h("Library/Developer"), "developer"),
    r(h("Library/Containers/com.docker.docker"), "developer"),
    r(h(".docker"), "developer"),
    r(h(".cargo"), "developer"),
    r(h(".rustup"), "developer"),
    r(h("go"), "developer"),
    r(h(".gradle"), "developer"),
    r(h(".m2"), "developer"),
    r(h(".nvm"), "developer"),
    r(h(".pyenv"), "developer"),
    r(h(".android"), "developer"),
    r(h(".bun"), "developer"),
    r("/opt/homebrew", "developer"),
    r("/usr/local", "developer"),
    r("/Library/Developer", "developer"),

    r(h("Pictures"), "photos"),
    r(h("Movies"), "movies"),

    r(h("Documents"), "documents"),
    r(h("Desktop"), "documents"),
    r(h("Downloads"), "documents"),
    r(h("Library/Mobile Documents"), "documents"),
    r(h("Library/CloudStorage"), "documents"),
    r("/Users/Shared", "documents"),
    // The rest of the home folder: project folders count as your files, and
    // dot-folders (~/.vscode, ~/.ollama, ...) as developer tooling.
    r(home, "documents", "developer"),

    r(h("Music"), "music"),

    r(h("Library/Caches"), "caches"),
    r(h(".cache"), "caches"),
    r(h(".npm"), "caches"),
    r(h("Library/Developer/Xcode/DerivedData"), "caches"),
    r(h("Library/Developer/CoreSimulator/Caches"), "caches"),
    r(h(".bun/install/cache"), "caches"),
    r(h(".gradle/caches"), "caches"),

    r(h(".Trash"), "trash"),
  ];
}

/**
 * The categories this tool is willing to clear, in the order it suggests them.
 */
export const CLEARABLE: Clearable[] = ["caches", "trash"];

/**
 * Categories whose contents regenerate or were already thrown away.
 */
export type Clearable = Extract<CategoryId, "caches" | "trash">;
