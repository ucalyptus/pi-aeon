/**
 * pi-aeon binary entrypoint.
 *
 * Interactive terminal by default; headless mode when piped/non-TTY or with
 * explicit flags:
 *   pi-aeon --tui                 force the interactive UI
 *   pi-aeon --headless "<prompt>" force the print-style runner
 */
const wantsHeadless = process.argv.includes("--headless");
const wantsTui = process.argv.includes("--tui");
const interactive = process.stdin.isTTY && process.stdout.isTTY;

// Dynamic import is required here: cli.ts and tui.ts are top-level scripts
// (each boots its own UI on import). A static import of either module would
// execute it before the mode can be selected.
if (wantsTui || (!wantsHeadless && interactive)) {
  await import("./tui.ts");
} else {
  await import("./cli.ts");
}
