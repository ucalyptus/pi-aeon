/**
 * Shared CLI parsing for pi-aeon entrypoints (binary and source runs alike).
 *
 * Grammar:
 *   [--headless | --tui]      mode flags (consumed, never prompt text)
 *   [--workspace <dir>]       workspace root (value consumed verbatim)
 *   everything else           prompt words, joined with spaces
 */
export type ExplicitMode = "headless" | "tui";

export interface ParsedArgs {
  /** Mode requested on the command line, if any. */
  explicitMode?: ExplicitMode;
  workspace?: string;
  /** Remaining words, intended as the user prompt (empty for TUI runs). */
  promptWords: string[];
}

export function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { promptWords: [] };
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--headless" || arg === "--tui") {
      result.explicitMode = arg === "--headless" ? "headless" : "tui";
    } else if (arg === "--workspace") {
      i += 1;
      const value = args[i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--workspace requires a directory argument");
      }
      result.workspace = value;
    } else {
      result.promptWords.push(arg);
    }
    i += 1;
  }
  return result;
}
