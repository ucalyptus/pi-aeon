/**
 * pi-aeon interactive TUI.
 *
 * Built with @earendil-works/pi-tui (same runtime as the harness — no IPC).
 * Layout, top to bottom:
 *   header · live proof-state panel · transcript · spinner (while streaming)
 *   · input editor
 * Verification verdicts stream into the transcript as the loop emits them.
 *
 *   bun run src/tui.ts [--workspace dir]
 */
import { resolve } from "node:path";
import {
  Editor,
  Loader,
  ProcessTerminal,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { parseArgs } from "./args.ts";
import { createVerifiedAgent, defaultModel } from "./harness.ts";

const parsed = parseArgs(process.argv.slice(2));
// Harness construction reads the workspace from the environment; both this
// entrypoint and the binary dispatch in main.ts converge here.
if (parsed.workspace) process.env.PI_AEON_WORKSPACE = parsed.workspace;
const workspace = process.env.PI_AEON_WORKSPACE ?? ".";

const policy = {
  workspaceRoot: resolve(workspace),
  privateGlobs: ["private/**", "**/.env*", "**/*secret*", "**/*credential*", "**/*.key", "**/id_rsa*"],
};

const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const GRAY = "\x1b[90m";
const RESET = "\x1b[0m";

const editorTheme = {
  borderColor: dim,
  selectList: {
    selectedPrefix: green,
    selectedText: (s: string) => s,
    description: dim,
    scrollInfo: dim,
    noMatch: red,
  },
};

const tui = new TuiMainScreen(new ProcessTerminal());

const header = new Text(
  `${bold("pi-aeon")} ${dim("— formally verified agent harness")}  ${dim(`model=${defaultModel().id}`)}\n` +
    dim("policy: private reads taint the session · tainted sessions can never publish (Z3-checked per call)"),
  1,
  0,
);

const proofPanel = new Text("", 1, 0);
tui.addChild(header);
tui.addChild(proofPanel);
tui.addChild(new Text(dim("─".repeat(60)), 0, 0));

let streaming: Text | undefined;
let streamingBuf = "";
let loader: Loader | undefined;
let busy = false;

function addLine(text: string): void {
  tui.addChild(new Text(text, 0, 0));
}

function refreshProof(): void {
  proofPanel.setText(`${dim("[proof state]")} ${session.summary()}`);
  tui.requestRender();
}

const { agent, session } = createVerifiedAgent({
  policy,
  model: defaultModel(),
  apiKey: process.env.OPENROUTER_API_KEY,
  onEvent: (e) => {
    if (e.kind === "verify") addLine(green(`  ✓ verified  ${e.label}`));
    else if (e.kind === "committed") addLine(dim(`    committed transition #${session.trace.length}`));
    else if (e.kind === "blocked") addLine(red(`  ✗ REJECTED  ${e.label}\n    ${e.detail ?? ""}`));
    refreshProof();
  },
});

agent.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        if (!streaming) {
          streamingBuf = "";
          streaming = new Text("", 0, 0);
          tui.addChild(streaming);
          if (loader) {
            tui.removeChild(loader);
            loader = undefined;
          }
        }
        streamingBuf += event.assistantMessageEvent.delta;
        streaming.setText(streamingBuf);
        tui.requestRender();
      }
      break;
    case "message_end":
      if (streaming && streamingBuf.trim()) addLine(""); // spacing after a response
      streaming = undefined;
      break;
    case "tool_execution_start":
      addLine(cyan(`  → ${event.toolName}`));
      break;
    case "tool_execution_end":
      if (event.isError) addLine(red("    (execution error)"));
      break;
    case "agent_end":
      if (loader) {
        tui.removeChild(loader);
        loader = undefined;
      }
      busy = false;
      addLine("");
      tui.requestRender();
      break;
  }
});

const editor = new Editor(tui, editorTheme, { paddingX: 0 });

editor.onSubmit = (text: string) => {
  const prompt = text.trim();
  if (!prompt || busy) return;
  busy = true;
  addLine(`${bold(cyan("you ›"))} ${prompt}`);
  refreshProof();
  if (!loader) {
    loader = new Loader(tui, (s) => `${GRAY}${s}${RESET}`, dim, "verifying & thinking…");
    tui.addChild(loader);
  }
  tui.requestRender();
  void agent.prompt(prompt).catch((err: unknown) => {
    addLine(red(`error: ${err instanceof Error ? err.message : String(err)}`));
    busy = false;
    tui.requestRender();
  });
};

// Ctrl+C aborts a running turn; second press within 500ms exits.
let lastCtrlC = 0;
tui.addInputListener((data: string) => {
  if (data !== "\x03") return undefined;
  const now = Date.now();
  if (busy && now - lastCtrlC > 500) {
    agent.abort();
    addLine(dim("  (aborted run — Ctrl+C again to quit)"));
    lastCtrlC = now;
    return { consume: true };
  }
  tui.stop();
  process.exit(0);
});

tui.addChild(new Text(dim("─".repeat(60)), 0, 0));
tui.addChild(editor);
tui.setFocus(editor);

refreshProof();
addLine(dim("type a task and press Enter · Ctrl+C twice to quit\n"));
tui.start();
