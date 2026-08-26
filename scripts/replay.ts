/**
 * Replay verifier: re-proves a whole recorded session in one shot.
 * Reads the pi-aeon audit log and checks the full committed trace against
 * the policy — catches any regression in the runtime gate.
 *
 *   bun run scripts/replay.ts [audit.jsonl]
 */
import { verify, type TraceAction } from "../src/verifier.ts";
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "./workspace-demo/pi-aeon-audit.jsonl";
const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

const committed: TraceAction[] = [];
let blocked = 0;
for (const e of lines) {
  if (e.event === "verified") {
    const op =
      e.tool === "publish_post" ? "do_publish" : e.tool === "write_file" ? "do_write" : "do_read";
    committed.push({
      tool: e.tool,
      op,
      resource: e.label.includes("[private") ? "private" : e.label.includes("[public") ? "public" : undefined,
      label: e.label,
    });
  } else if (e.event === "blocked") {
    blocked++;
  }
}

const verdict = await verify(committed);
console.log(`replayed ${committed.length} transitions, ${blocked} runtime blocks`);
if (verdict.ok) {
  console.log("FULL SESSION PROOF: all committed transitions satisfy the policy ✓");
} else {
  console.error("SESSION PROOF FAILED ✗", JSON.stringify(verdict, null, 2));
  process.exit(1);
}
