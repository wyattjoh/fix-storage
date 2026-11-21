import { basename, extname } from "node:path";
import type { CategoryId } from "./categories";
import type { Item } from "./scan";

/**
 * junk:   regenerates by itself or is a leftover; removing it loses nothing.
 * unused: probably not needed any more (old, or one of a kind you can redo); your call.
 * yours:  your data, in use; shown for context only.
 * system: the OS or a tool manages it; leave it to them.
 */
export type Verdict = "junk" | "unused" | "yours" | "system";

/**
 * When an item was last used.
 */
export interface Usage {
  /**
   * Milliseconds since epoch.
   */
  at: number;
  /**
   * "opened" when a last-opened date is known, "changed" when only the modification time is.
   */
  kind: "opened" | "changed";
}

/**
 * What an item probably is.
 */
export interface Label {
  verdict: Verdict;
  /**
   * Short, lowercase reason, e.g. "rebuilds with npm install".
   */
  reason: string;
}

const DAY = 24 * 3600 * 1000;

/**
 * Folders that are one thing as far as the user is concerned: a culprit search
 * stops at them instead of digging into their internals.
 */
export function isWhole(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    name === "node_modules" ||
    BUILD_CACHES.has(name) ||
    /\.(app|framework|photoslibrary|fcpbundle|logicx|imovielibrary|bundle|vmwarevm|pvm|utm|sparsebundle|xcarchive)$/.test(
      name,
    )
  );
}

/**
 * "3 days", "7 months", "2 years".
 */
export function age(ms: number): string {
  const days = Math.max(0, Math.floor(ms / DAY));
  if (days < 1) return "today";
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"}`;
  const months = Math.floor(days / 30.4);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"}`;
  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? "year" : "years"}`;
}

/**
 * "today", "3 days ago".
 */
export function ago(ms: number): string {
  const text = age(ms);
  return text === "today" ? "today" : `${text} ago`;
}

/**
 * Compact age for a column: "3d", "7mo", "2y".
 */
export function shortAge(ms: number): string {
  const days = Math.max(0, Math.floor(ms / DAY));
  if (days < 1) return "today";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30.4)}mo`;
  return `${Math.floor(days / 365)}y`;
}

const BUILD_CACHES = new Set([
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  ".svelte-kit",
  ".angular",
  ".expo",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  ".dart_tool",
]);
const INSTALLERS = new Set([".dmg", ".pkg", ".mpkg", ".iso", ".xip"]);
const ARCHIVES = new Set([".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".bz2", ".xz"]);
const SCREEN_CAPTURE = /^(screen recording|screenshot|cleanshot|screen shot|recording)\b/i;

function idle(usage: Usage | undefined, now: number): number | null {
  return usage ? now - usage.at : null;
}

/**
 * What a piece of System data is. macOS manages all of it.
 */
function systemReason(): string {
  return "managed by macOS";
}

/**
 * Decides what an item probably is, from its name, where it lives, and when it was last used.
 */
export function classify(
  item: Item,
  category: CategoryId,
  usage: Usage | undefined = undefined,
  now: number = Date.now(),
): Label {
  const path = item.path;
  const name = basename(path);
  const lower = name.toLowerCase();
  const ext = extname(lower);
  const since = idle(usage, now);
  const untouched =
    since !== null && usage && since > 30 * DAY
      ? ` · ${usage.kind === "opened" ? "not opened" : "not touched"} in ${age(since)}`
      : "";

  if (category === "system") return { verdict: "system", reason: systemReason() };
  if (category === "trash") return { verdict: "junk", reason: "already in the trash" };
  if (category === "caches")
    return { verdict: "junk", reason: "cache · apps rebuild it when they need it" };

  // Things that rebuild themselves.
  if (lower === "node_modules")
    return { verdict: "junk", reason: `rebuilds with npm install${untouched}` };
  if (BUILD_CACHES.has(lower))
    return { verdict: "junk", reason: `build cache · rebuilds itself${untouched}` };
  if (lower === "pods" && item.dir)
    return { verdict: "junk", reason: `rebuilds with pod install${untouched}` };
  if (path.includes("/Xcode/DerivedData"))
    return { verdict: "junk", reason: "xcode build products · rebuild on next build" };
  if (path.includes("/iOS DeviceSupport/") || path.includes("/watchOS DeviceSupport/"))
    return {
      verdict: "junk",
      reason: "debug symbols for one device os · xcode fetches them again",
    };
  if (path.includes("/CoreSimulator/Caches")) return { verdict: "junk", reason: "simulator cache" };

  // Installers and leftovers.
  if (INSTALLERS.has(ext))
    return { verdict: "junk", reason: `installer · not needed once installed${untouched}` };

  // Probably not needed, but yours to decide.
  if (
    (lower === "target" || lower === "dist" || lower === "build" || lower === "out") &&
    item.dir &&
    path.includes("/")
  )
    return { verdict: "unused", reason: `build output · rebuilds from source${untouched}` };
  if ((lower === ".venv" || lower === "venv" || lower === "env") && item.dir)
    return {
      verdict: "unused",
      reason: `python environment · recreate with pip install${untouched}`,
    };
  if (path.includes("/CoreSimulator/Devices/"))
    return { verdict: "unused", reason: `simulator device${untouched}` };
  if (path.includes("/Xcode/Archives/"))
    return { verdict: "unused", reason: `old app archive${untouched}` };
  if (path.includes("/MobileSync/Backup/"))
    return { verdict: "unused", reason: `iphone or ipad backup${untouched}` };
  if (ARCHIVES.has(ext) && path.includes("/Downloads/"))
    return { verdict: "unused", reason: `downloaded archive${untouched}` };
  if (SCREEN_CAPTURE.test(name) && since !== null && since > 14 * DAY)
    return { verdict: "unused", reason: `screen capture from ${ago(since)}` };

  // Things a tool owns; deleting by hand breaks the tool.
  if (lower === "docker.raw" || path.includes("/com.docker.docker/"))
    return { verdict: "system", reason: "docker's disk · shrink it with docker system prune" };
  if (path.includes("/.ollama/models"))
    return { verdict: "system", reason: "local ai models · remove with ollama rm" };
  if (path.startsWith("/opt/homebrew") || path.startsWith("/usr/local/Cellar"))
    return {
      verdict: "system",
      reason: "homebrew manages this · brew cleanup removes old versions",
    };

  // Nothing about the name says junk; fall back to how long it has sat there.
  if (since !== null && usage) {
    const verb = usage.kind === "opened" ? "not opened" : "not touched";
    if (since > 365 * DAY) return { verdict: "unused", reason: `${verb} in ${age(since)}` };
    if (
      since > 180 * DAY &&
      (ext === ".app" || category === "movies" || path.includes("/Downloads/"))
    )
      return { verdict: "unused", reason: `${verb} in ${age(since)}` };
    return { verdict: "yours", reason: `${usage.kind} ${ago(since)}` };
  }
  return { verdict: "yours", reason: "" };
}
