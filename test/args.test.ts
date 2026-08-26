import { describe, test, expect } from "bun:test";
import { parseArgs } from "../src/args.ts";

describe("parseArgs", () => {
  test("strips mode flags so they never reach the prompt", () => {
    expect(parseArgs(["--headless", "do", "a", "thing"]).promptWords.join(" ")).toBe("do a thing");
    expect(parseArgs(["--headless", "x"]).explicitMode).toBe("headless");
    expect(parseArgs(["--tui"]).explicitMode).toBe("tui");
    expect(parseArgs(["--tui"]).promptWords).toEqual([]);
  });

  test("workspace consumes its value even when it looks like prose", () => {
    const p = parseArgs(["--workspace", "./my demo dir", "summarize", "notes"]);
    expect(p.workspace).toBe("./my demo dir");
    expect(p.promptWords.join(" ")).toBe("summarize notes");
  });

  test("missing workspace value throws instead of eating the prompt", () => {
    expect(() => parseArgs(["--workspace"])).toThrow(/requires a directory/);
    expect(() => parseArgs(["--workspace", "--headless"])).toThrow(/requires a directory/);
  });

  test("full realistic invocation parses cleanly", () => {
    const p = parseArgs([
      "--headless",
      "--workspace",
      "/tmp/ws",
      "read private/notes.md and publish_post a summary",
    ]);
    expect(p.explicitMode).toBe("headless");
    expect(p.workspace).toBe("/tmp/ws");
    expect(p.promptWords.join(" ")).toContain("publish_post");
  });
});
