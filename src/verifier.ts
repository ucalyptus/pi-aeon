/**
 * Aeon verifier bridge.
 *
 * Encodes (committed trace + proposed action) as an Aeon probe program and
 * asks the Aeon refinement-type checker (backed by Z3) to prove the policy
 * in `policies/session_taint.ae`. A type error IS the rejection proof: its
 * "Failed to prove" constraint is returned verbatim as the denial reason.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One symbolic transition in the verified session trace. */
export interface TraceAction {
  /** Tool name in the harness (`read_file`, `write_file`, `publish_post`, ...). */
  tool: string;
  /** Aeon transition being applied. */
  op: "do_read" | "do_write" | "do_publish";
  /** Resource classification resolved by policy before encoding. */
  resource?: "private" | "public";
  /** Human-readable rendering for audit logs (path, command, text preview). */
  label: string;
}

export type Verdict =
  | { ok: true; elapsedMs: number }
  | { ok: false; reason: string; constraint?: string; elapsedMs: number }
  | { ok: false; reason: string; failed: "verifier-unavailable"; elapsedMs: number };

const POLICY = `
type Session
type Resource

def tainted   : (s:Session) -> Bool     := uninterpreted
def private_r : (r:Resource) -> Bool    := uninterpreted

def fresh      : {s:Session | tainted s = false}       := native "None"
def mk_private : {r:Resource | private_r r = true}     := native "None"
def mk_public  : {r:Resource | private_r r = false}    := native "None"

def do_read (r:Resource) (s:Session) :
    {s2:Session | tainted s2 = (private_r r || tainted s)} :=
    native "None";

def do_write (r:Resource) (s:Session) :
    {s2:Session | tainted s2 = tainted s} :=
    native "None";

def do_publish (s:{s:Session | tainted s = false}) : Unit :=
    native "None";

def sink (s:Session) : Unit := native "None";
`;

export function encodeProbe(trace: TraceAction[], proposal?: TraceAction): string {
  const actions = proposal ? [...trace, proposal] : trace;
  const lines: string[] = ["def probe (_:Int) : Unit :=", "    let s0 := fresh in"];
  const body = actions.slice(0, -1);
  const last = actions.at(-1);
  body.forEach((a, i) => {
    const arg = a.resource === "private" ? "mk_private " : "mk_public ";
    lines.push(`    let s${i + 1} := ${a.op} ${arg}s${i} in`);
  });
  // Terminal expression: bare application closed with ';', as in Aeon's own
  // lethal_trifecta example. Publish imposes its refinement precondition;
  // any other tail closes with the neutral `sink`.
  if (!last) {
    lines.push("    sink s0;");
  } else if (last.op === "do_publish") {
    lines.push(`    do_publish s${body.length};`);
  } else {
    const arg = last.resource === "private" ? "mk_private " : "mk_public ";
    lines.push(`    let s${actions.length} := ${last.op} ${arg}s${body.length} in`);
    lines.push(`    sink s${actions.length};`);
  }
  return `${POLICY}\n${lines.join("\n")}\n`;
}

let aeonCmdCache: string | null | undefined;

async function resolveAeon(): Promise<string | null> {
  if (aeonCmdCache !== undefined) return aeonCmdCache;
  const proc = Bun.spawn(["uvx", "--from", "aeonlang", "aeon", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  aeonCmdCache = code === 0 ? "uvx" : null;
  return aeonCmdCache;
}
const cache = new Map<string, Verdict>();

export async function verify(
  trace: TraceAction[],
  proposal?: TraceAction,
  opts: { timeoutMs?: number } = {},
): Promise<Verdict> {
  const started = Date.now();
  if ((await resolveAeon()) === null) {
    return { ok: false, reason: "Aeon verifier unavailable (install uv + aeonlang). Failing closed.", failed: "verifier-unavailable", elapsedMs: 0 };
  }

  const program = encodeProbe(trace, proposal);
  const key = createHash("sha256").update(program).digest("hex");
  const cached = cache.get(key);
  if (cached) return cached;

  const dir = mkdtempSync(join(tmpdir(), "pi-aeon-"));
  const file = join(dir, "probe.ae");
  writeFileSync(file, program);

  try {
    const proc = Bun.spawn(
      ["uvx", "--from", "aeonlang", "aeon", "-n", file],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 30_000);
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    clearTimeout(timer);
    const code = await proc.exited;
    const output = (stderr || stdout).trim();

    let verdict: Verdict;
    if (code === 0) {
      verdict = { ok: true, elapsedMs: Date.now() - started };
    } else if (/Type error|Failed to prove/i.test(output)) {
      const constraint = /Constraint-+\n([\s\S]*?)\+-{3,}/.exec(output)?.[1]?.trim();
      const failed = /Failed to prove `([^`]+)`/.exec(output)?.[1];
      verdict = {
        ok: false,
        reason: `Policy violated: cannot prove ${failed ?? "required refinement"}.`,
        constraint,
        elapsedMs: Date.now() - started,
      };
    } else {
      verdict = { ok: false, reason: `Verifier error (exit ${code}): ${output.slice(0, 400)}. Failing closed.`, elapsedMs: Date.now() - started };
    }
    cache.set(key, verdict);
    return verdict;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
