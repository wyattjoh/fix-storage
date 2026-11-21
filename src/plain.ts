import { CATEGORIES, TIER_LABEL, roots as macRoots, type Root } from "./core/categories";
import { capacity, gb, size, tilde } from "./core/format";
import { startScan, type ScanSnapshot } from "./core/scan";

/**
 * Text and JSON output, for pipes and scripts. Never deletes anything.
 */
export async function runPlain(json: boolean, roots: Root[] = macRoots()): Promise<void> {
  const live = process.stderr.isTTY === true;
  const handle = startScan(roots, (snapshot) => {
    if (!live || snapshot.phase === "done") return;
    const columns = process.stderr.columns ?? 80;
    const line = `${gb(snapshot.measured)} measured  ${tilde(snapshot.current)}`;
    process.stderr.write(`\r\x1b[2K${line.slice(0, columns - 1)}`);
  });
  process.on("SIGINT", () => {
    handle.cancel();
    if (live) process.stderr.write("\r\x1b[2K");
    process.exit(130);
  });
  const scan = await handle.done;
  if (live) process.stderr.write("\r\x1b[2K");
  process.stdout.write(json ? toJson(scan) : toText(scan));
}

/**
 * The scan as JSON: disk totals, each category's bytes and its five largest items.
 */
export function toJson(scan: ScanSnapshot): string {
  return (
    JSON.stringify(
      {
        total: scan.total,
        used: scan.used,
        available: scan.available,
        measured: scan.measured,
        categories: CATEGORIES.map((c) => ({
          id: c.id,
          name: c.name,
          tier: c.tier,
          bytes: scan.sizes[c.id],
          largest: scan.items[c.id].slice(0, 5),
        })),
        blocked: scan.blocked,
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * The scan as a short human-readable summary.
 */
export function toText(scan: ScanSnapshot): string {
  const lines: string[] = [];
  lines.push(`${gb(scan.used)} of ${capacity(scan.total)} used, ${gb(scan.available)} available`);
  if (scan.total > 0 && scan.measured > scan.used) {
    lines.push(
      `${gb(scan.measured)} measured across files and folders (${size(scan.measured - scan.used)} above filesystem usage)`,
    );
  }
  lines.push("");

  const width = Math.max(...CATEGORIES.map((c) => c.name.length));
  for (const category of CATEGORIES) {
    lines.push(
      `${category.name.padEnd(width)}  ${gb(scan.sizes[category.id]).padStart(9)}  ${TIER_LABEL[category.tier]}`,
    );
  }

  for (const category of CATEGORIES) {
    if (category.tier !== "safe" || scan.items[category.id].length === 0) continue;
    lines.push("", `${category.name}: ${category.blurb}`);
    for (const item of scan.items[category.id].slice(0, 5))
      lines.push(`  ${size(item.size).padStart(8)}  ${tilde(item.path)}`);
  }

  if (scan.blocked.length > 0) {
    lines.push("", "Could not read (give your terminal Full Disk Access to include these):");
    for (const path of scan.blocked.slice(0, 8)) lines.push(`  ${tilde(path)}`);
    if (scan.blocked.length > 8) lines.push(`  and ${scan.blocked.length - 8} more`);
  }
  return lines.join("\n") + "\n";
}
