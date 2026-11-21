# fix-storage

A Bun + TypeScript TUI that shows what fills a Mac's disk and clears what is safe to clear. Published as `@wyattjoh/fix-storage` and run with `bunx`; there is no build step, the TypeScript source is the package.

A macOS-only port of [govijr/fix-storage](https://github.com/govijr/fix-storage). The scan, classification and safety rules come from it; the UI was rewritten for `@opentui/react` because the original renderer (`@zenbu-labs/pixel`) downloads Electron in a postinstall step, which `bunx` never runs.

See [README.md](README.md) for the user-facing interface.

## Commands

| Task       | Command                    |
| ---------- | -------------------------- |
| Run        | `bun src/main.tsx`         |
| Summary    | `bun src/main.tsx --plain` |
| Test       | `bun test`                 |
| Typecheck  | `bun run typecheck`        |
| Lint       | `bun run lint`             |
| Format     | `bun run format`           |
| Everything | `just check`               |

## Layout

| File                     | Holds                                                                        |
| ------------------------ | ---------------------------------------------------------------------------- |
| `src/core/categories.ts` | Categories, tiers, and the macOS folders (`roots`) each one is measured from |
| `src/core/classify.ts`   | Pure labelling: junk / unused / yours / system, and the reason               |
| `src/core/scan.ts`       | The whole-disk scan (`dust` per folder via `Bun.spawn`), disk space          |
| `src/core/browse.ts`     | Listing a folder, finding a culprit, last-used dates, removing one item      |
| `src/core/clean.ts`      | Planning and running a category-wide clear                                   |
| `src/plain.ts`           | `--plain` and `--json` output                                                |
| `src/ui/store.ts`        | The app's state machine; every side effect goes through `Deps`               |
| `src/ui/bar.ts`          | Pure bar layout (braille dot cells, ripple) and easing                       |
| `src/ui/app.tsx`         | The OpenTUI screen and the key map (`handleKey`)                             |
| `src/main.tsx`           | Arg parsing, renderer lifecycle                                              |

## The safety model

This tool deletes things. Keep these properties when changing it:

- **Only Caches and Trash are cleared in bulk** (`CLEARABLE`). Everything else is removed one item at a time and goes to the Trash (`moveToTrash`); only items in caches or the Trash are deleted for good (`deletesForGood`).
- **Every removal takes two presses.** `Store.press` and `Store.removeItem` arm on the first press and act on the second within `confirmMs`.
- **Check again right before deleting.** `clean()` re-checks `inside()` for every item immediately before its `rm`, so a stale plan cannot reach outside the category's folders. `cannotRemove` guards single items: roots themselves, `/System`, `/private`, account folders in `~/Library`, and anything outside the scanned roots.

## Conventions

- macOS only. `main.tsx` refuses to start elsewhere; do not reintroduce Linux branches piecemeal.
- Folder sizes come from [dust](https://github.com/bootandy/dust) (`dust -j -o b -x`), never `du`, which is far slower. `main.tsx` exits with install instructions when `dust` is not on `PATH`. Every walk goes through `dust()` in `scan.ts`, which owns the stall watchdog.
- `Store` takes a `Deps` object (`liveDeps()` for the real machine). UI tests in `test/app.test.tsx` drive real keys through `@opentui/react/test-utils` with fake deps, so they never touch the disk. Add new side effects to `Deps`, not as direct imports in the store.
- The UI draws every row as one `<text>` of styled `<span>`s, sized and truncated by `fitChunks`, rather than relying on flex layout for columns. Widths are measured with `Bun.stringWidth`.
- Animation only runs while something moves: `useSpinner`, `useEased` and `useAppear` pass `undefined` to `useAnimationTick` when idle, so an idle screen does not redraw.
- Every `.tsx` file starts with `/** @jsxImportSource @opentui/react */`. Bun does not always apply the package's tsconfig when `bunx` runs the file from `node_modules`, and without the pragma JSX would resolve to React DOM. The pragma must stay on one line; it is the one exception to multi-line JSDoc.
- `main.tsx` routes every exit through `quit()`, which stops the store and awaits `renderer.closed` before `process.exit`, so the terminal never stays in the alternate screen.
- Prefer `| undefined` over `?` (`exactOptionalPropertyTypes` is on). Multi-line JSDoc on public exports.
