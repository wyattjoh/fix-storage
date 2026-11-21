#!/usr/bin/env bun
/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { runPlain } from "./plain";
import { App } from "./ui/app";
import { Store } from "./ui/store";

const HELP = `fix-storage: see what is filling your Mac's disk and clear what is safe to clear.

Usage: fix-storage [options]

  (no options)   Open the interactive view.
  --plain        Print a text summary and exit. Deletes nothing.
  --json         Print the summary as JSON and exit. Deletes nothing.
  -h, --help     Show this help.
`;

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  process.stdout.write(HELP);
  process.exit(0);
}
const unknown = args.find((arg) => !["--plain", "--json"].includes(arg));
if (unknown) {
  process.stderr.write(`fix-storage: unknown option ${unknown}\n\n${HELP}`);
  process.exit(2);
}
if (process.platform !== "darwin") {
  process.stderr.write("fix-storage only runs on macOS.\n");
  process.exit(1);
}

if (args.length > 0 || !process.stdout.isTTY) {
  try {
    await runPlain(args.includes("--json"));
  } catch (error) {
    process.stderr.write(
      `fix-storage: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

const store = new Store();
const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: false,
  backgroundColor: "#000000",
});
let quitting = false;

// Every way out stops the scan and restores the terminal before exiting.
// Errors print after the alternate screen is gone, so they stay visible.
const quit = async (code = 0, error: unknown = undefined) => {
  if (quitting) return;
  quitting = true;
  store.stop();
  try {
    renderer.destroy();
    await renderer.closed;
  } finally {
    if (error !== undefined) {
      process.stderr.write(
        `fix-storage: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    process.exit(code);
  }
};

process.on("SIGTERM", () => void quit(143));
process.on("uncaughtException", (error) => void quit(1, error));
process.on("unhandledRejection", (error) => void quit(1, error));

try {
  createRoot(renderer).render(<App store={store} onQuit={() => void quit(0)} />);
  store.rescan();
} catch (error) {
  await quit(1, error);
}
