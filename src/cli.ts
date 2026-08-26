/**
 * pi-aeon headless runner. Interactive users: run `pi-aeon` with no flags.
 *
 *   pi-aeon --headless [--workspace <dir>] "<prompt>"
 */
import { join, resolve } from "node:path";
import { createVerifiedAgent, defaultModel } from "./harness.ts";
import { parseArgs } from "./args.ts";

const parsed = parseArgs(process.argv.slice(2));
const workspace = parsed.workspace ?? process.env.PI_AEON_WORKSPACE ?? ".";
const prompt = parsed.promptWords.join(" ").trim();
if (!prompt) {
  console.error('usage: pi-aeon --headless [--workspace dir] "<prompt>"');
  process.exit(2);
}

const policy = {
  workspaceRoot: resolve(workspace),
  privateGlobs: ["private/**", "**/.env*", "**/*secret*", "**/*credential*", "**/*.key", "**/id_rsa*"],
};

console.log(`[pi-aeon] model=${defaultModel().id} workspace=${policy.workspaceRoot}`);

const { agent } = createVerifiedAgent({
  policy,
  model: defaultModel(),
  apiKey: process.env.OPENROUTER_API_KEY,
  onEvent: (e) => {
    if (e.kind === "verify") console.log(`\x1b[32m[pi-aeon] VERIFIED ✓ ${e.label}\x1b[0m`);
    else if (e.kind === "blocked") console.log(`\x1b[31m[pi-aeon] REJECTED ✗ ${e.label} — ${e.detail}\x1b[0m`);
    else if (e.kind === "committed") console.log(`\x1b[90m[pi-aeon] committed transition: ${e.label}\x1b[0m`);
  },
});

agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt(prompt);
await agent.waitForIdle();
console.log("\n[pi-aeon] session complete. audit log:", join(policy.workspaceRoot, "pi-aeon-audit.jsonl"));
