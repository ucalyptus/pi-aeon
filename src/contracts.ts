/**
 * Tool contracts: every tool in this harness is declared as a transition in
 * the verified state machine. A tool without a contract cannot be registered.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Glob } from "bun";
import { join, relative, isAbsolute } from "node:path";

export interface Classification {
  resource: "private" | "public";
  matchedRule?: string;
}

export type VerdictListener = (entry: {
  kind: "verify" | "blocked" | "committed" | "error";
  tool: string;
  label: string;
  detail?: string;
}) => void;

/** Policy configuration: which resources count as private. */
export interface PolicyConfig {
  workspaceRoot: string;
  /** Glob patterns (relative to workspaceRoot) treated as private. */
  privateGlobs: string[];
}

const DEFAULT_POLICY: Pick<PolicyConfig, "privateGlobs"> = {
  privateGlobs: [
    "private/**",
    "**/.env*",
    "**/*secret*",
    "**/*credential*",
    "**/*.key",
    "**/id_rsa*",
    "**/.git/config",
  ],
};

export function classifyPath(policy: PolicyConfig, rawPath: string): Classification {
  const abs = isAbsolute(rawPath) ? rawPath : join(policy.workspaceRoot, rawPath);
  const rel = relative(policy.workspaceRoot, abs);
  // Escapes outside the sandbox are conservatively private (fail closed).
  if (rel.startsWith("..")) return { resource: "private", matchedRule: "<outside-workspace>" };
  for (const pattern of policy.privateGlobs) {
    if (new Glob(pattern).match(rel)) return { resource: "private", matchedRule: pattern };
  }
  return { resource: "public" };
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: {} };
}

/** Build the contracted tool set. Each tool carries its formal transition. */
export function buildTools(
  policy: PolicyConfig,
  onEvent?: VerdictListener,
): {
  tools: AgentTool<any>[];
  /** Maps a validated tool call to its symbolic transition. */
  encode: (toolName: string, args: Record<string, unknown>) => { op: "do_read" | "do_write" | "do_publish"; resource?: "private" | "public"; label: string };
} {
  const root = policy.workspaceRoot;

  const read_file: AgentTool<any> = {
    name: "read_file",
    label: "Read File",
    description:
      "Read a file inside the workspace. Reading a PRIVATE resource taints the session; tainted sessions can never publish.",
    parameters: Type.Object({
      path: Type.String({ description: "Path relative to workspace root" }),
    }),
    execute: async (_id, params) => {
      const p = join(root, params.path);
      const data = await Bun.file(p).text();
      return text(`Contents of ${params.path}:\n${data}`);
    },
  };

  const list_dir: AgentTool<any> = {
    name: "list_dir",
    label: "List Directory",
    description:
      "List entries of a directory inside the workspace. Listing a PRIVATE directory taints the session.",
    parameters: Type.Object({
      path: Type.String({ description: "Directory path relative to workspace root ('.' for root)" }),
    }),
    execute: async (_id, params) => {
      const dir = params.path === "." ? root : join(root, params.path);
      const names = [...new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true, onlyFiles: true })].slice(0, 200);
      return text(names.join("\n") || "(empty)");
    },
  };

  const write_file: AgentTool<any> = {
    name: "write_file",
    label: "Write File",
    description: "Write text to a file inside the workspace. Writing never taints the session.",
    parameters: Type.Object({
      path: Type.String({ description: "Destination path relative to workspace root" }),
      content: Type.String({ description: "File contents to write" }),
    }),
    execute: async (_id, params) => {
      await Bun.write(join(root, params.path), params.content);
      return text(`Wrote ${params.content.length} bytes to ${params.path}`);
    },
  };

  const publish_post: AgentTool<any> = {
    name: "publish_post",
    label: "Publish Post",
    description:
      "Publish text to the PUBLIC feed (external sink). Formally rejected if the session ever read private data.",
    parameters: Type.Object({
      text: Type.String({ description: "Content to publish publicly" }),
    }),
    execute: async (_id, params) => {
      const sink = join(root, "published.log");
      await Bun.write(sink, `${new Date().toISOString()}\t${params.text}\n`, { append: true });
      return text(`Published ${params.text.length} chars to the public feed.`);
    },
  };

  const tools = [read_file, list_dir, write_file, publish_post];

  // Opaque mode: strip policy semantics from tool descriptions so the only
  // place the policy exists is the verifier itself.
  if (process.env.PI_AEON_OPAQUE === "1") {
    const neutral: Record<string, string> = {
      read_file: "Read a file inside the workspace.",
      list_dir: "List entries of a directory inside the workspace.",
      write_file: "Write text to a file inside the workspace.",
      publish_post: "Publish text to the public feed.",
    };
    for (const t of tools) t.description = neutral[t.name] ?? t.description;
  }

  const encode = (toolName: string, args: Record<string, unknown>) => {
    switch (toolName) {
      case "read_file": {
        const c = classifyPath(policy, String(args.path));
        return { op: "do_read" as const, resource: c.resource, label: `read ${args.path} [${c.resource}${c.matchedRule ? ` via ${c.matchedRule}` : ""}]` };
      }
      case "list_dir": {
        const c = classifyPath(policy, args.path === "." ? "" : String(args.path));
        return { op: "do_read" as const, resource: c.resource, label: `list ${args.path} [${c.resource}]` };
      }
      case "write_file": {
        const c = classifyPath(policy, String(args.path));
        return { op: "do_write" as const, resource: c.resource, label: `write ${args.path} [${c.resource}]` };
      }
      case "publish_post":
        return { op: "do_publish" as const, label: `publish "${String(args.text).slice(0, 60)}..."` };
      default:
        throw new Error(`Tool ${toolName} has no formal contract`);
    }
  };

  return { tools, encode };
}
