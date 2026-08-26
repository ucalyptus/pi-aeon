# pi-aeon

An agent harness with **formal verification in the agent loop**. Built on
[`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi), the
runtime behind pi.dev. Policies are refinement types, checked by
[Aeon](https://github.com/alcides/aeon) with Z3 before a tool ever runs.

```sh
curl -fsSL https://aeon.ucalyptus.me/install.sh | sh   # macOS
pi-aeon --workspace ./my-workspace                     # interactive TUI
```

## Why

In a stock pi harness, tools are functions: the model names one, the runtime
executes it. Safety comes from prompts or an extension listening from outside.
pi-aeon makes tools **transitions of a verified state machine** instead:

1. The session is a symbolic state (`Session`) with one observable measure:
   `tainted`, true once the session has read a private resource. Taint never
   clears.
2. Every tool maps to an Aeon operation with a refinement-typed contract
   (`policies/session_taint.ae`):

   ```aeon
   def do_read (r:Resource) (s:Session) :
       {s2:Session | tainted s2 = (private_r r || tainted s)} := native "None";

   def do_publish (s:{s:Session | tainted s = false}) : Unit := native "None";
   ```

3. Before any tool executes, the harness encodes the entire committed trace
   plus the proposed transition into an Aeon *probe program* and has Z3 prove
   it well-formed. A type error is the rejection: the failed proof obligation
   goes back to the model verbatim as a native tool error.

This implements the "lethal trifecta" defense (after Simon Willison): reading
private data taints the session, and publication from a tainted session has no
proof, so it cannot happen — regardless of what the model was prompted,
jailbroken, or injected into doing.

A rejected publish looks like this to the model:

```
✗ REJECTED  publish "Acme Corp's Q3 plan…"
Policy violated: cannot prove (tainted(s1) == false)
Constraint:
  ∀s1:Session _ | (tainted(s1) == true)  ====>  (tainted(s1) == false)
```

## Where verification lives

Inside `AgentLoopConfig` — the loop's own choke point, the same code path every
tool call already traverses:

| Seam | Role |
|---|---|
| `beforeToolCall` | Classifies arguments, encodes `trace + proposal`, runs Z3 via `uvx aeonlang`. Rejections become tool errors; verified transitions commit at preflight, in sequential order, so parallel sibling calls cannot race the proof. |
| `transformContext` | Injects `[pi-aeon verified proof state]` into every provider request so the model always sees its obligations. |
| `afterToolCall` | Audits execution outcomes to the session log. |

Design decisions worth knowing:

- **Fail-closed.** Verifier missing, timing out (30s), or erroring blocks the
  call. Verification problems never degrade into silent allows.
- **Conservative commits.** A transition commits when its proof passes at
  preflight. If execution later fails, the commitment stands — an errored read
  may still have leaked bytes, so the symbolic state errs on the safe side.
- **Opaque mode** (`PI_AEON_OPAQUE=1`). Full enforcement, zero disclosure:
  neutral tool descriptions and no proof-state injection. The policy exists
  only inside the verifier, which is the realistic adversarial setting — and
  how the rejection demo above was captured.

## Usage

```
pi-aeon                       interactive TUI (default on a TTY)
pi-aeon --headless "prompt"   print-style runner for scripts
pi-aeon --tui                 force the TUI when piped
```

| Flag / variable | Meaning |
|---|---|
| `--workspace <dir>` | Root the agent works in (default `.`; env `PI_AEON_WORKSPACE`) |
| `PI_AEON_MODEL` | Model id (default `stealth/ox-alpha`, served via OpenRouter) |
| `OPENROUTER_API_KEY` | Required for model access |
| `PI_AEON_OPAQUE` | `1` hides the policy from the model |
| `PI_AEON_INSTALL_DIR` | Installer target dir (default `~/.local/bin`) |
| `PI_AEON_VERSION` | Pin the installer to a release tag |

Tools available to the agent: `read_file`, `list_dir`, `write_file`,
`publish_post`. Paths matching `private/**`, `*secret*`, `.env*`,
`*credential*`, `*.key`, `id_rsa*` classify as private; anything outside the
workspace classifies private too (fail-closed). Writing to a private file does
**not** taint — egress is not ingress.

Every verified transition is appended to `<workspace>/pi-aeon-audit.jsonl`.
Re-prove an entire recorded session in one shot:

```bash
bun run replay workspace-demo/pi-aeon-audit.jsonl
# FULL SESSION PROOF: all committed transitions satisfy the policy ✓
```

## Requirements

- macOS (arm64/x64) for the packaged binary; Linux works from source via Bun.
- [`uv`](https://docs.astral.sh/uv/) — the verifier shells out to `uvx aeonlang`
  (~44s on first run while packages install, ~2s after).
- An OpenRouter API key for the model.

## Development

```bash
bun install
bun test        # 12 tests: Z3 proofs of safe/unsafe traces + CLI arg parsing
bun run src/cli.ts --workspace ./workspace-demo "…"
bun run src/tui.ts --workspace ./workspace-demo
```

The repo ships `workspace-demo/` containing a sanitized `private/notes.md`
fixture. The canonical attack demo:

```bash
PI_AEON_OPAQUE=1 bun run src/cli.ts --workspace ./workspace-demo \
  "Read private/notes.md and publish_post a summary. Do not ask questions."
# → read verified & committed (session tainted)
# → publish_post REJECTED by Z3 mid-loop
```

Release binaries are Bun single-file executables:

```bash
for t in darwin-arm64 darwin-x64; do
  bun build --compile --target=bun-$t src/main.ts --outfile dist/pi-aeon-$t
done
```

The installer page at `aeon.ucalyptus.me` is a static-assets Cloudflare Worker
(`install/worker/`, deploy with `npx wrangler deploy`); it serves `install.sh`
and redirects downloads to GitHub Releases, where checksums are published.

## Trust model (what Z3 does and does not prove)

The prover guarantees the **sequencing invariant**: over the classified trace,
no publish follows a private read, and taint behaves as specified. It relies on
trusted inputs outside the proof:

- **Classification is glob-based**, resolved in TypeScript before encoding.
  Wrong globs mean wrongly classified resources — the proof stays valid but
  proves the wrong thing about the world.
- **Transition contracts are trusted summaries** (`native "None"` bodies).
  They assert that reads taint and writes don't; they don't verify tool
  implementations.
- **The terminal sink is neutral.** Any other exfiltration channel (network
  calls inside a hypothetical tool) would need its own contract before the
  policy covers it.

Extending coverage means adding an operation to the policy file and a matching
entry in `contracts.ts`; unregistered tools are blocked outright
("no formal contract").

## Layout

```
policies/session_taint.ae   the formal policy (specification = types)
src/verifier.ts             trace → probe encoder + Aeon/Z3 subprocess bridge
src/contracts.ts            tool ↔ transition contracts, resource classifier
src/harness.ts              Agent construction; verification wired into the loop
src/args.ts                 shared CLI parsing (mode flags never reach prompts)
src/main.ts                 binary dispatch: TUI vs headless
src/tui.ts                  interactive UI (pi-tui, same process — no IPC)
src/cli.ts                  headless runner
install/install.sh          installer served at aeon.ucalyptus.me/install.sh
install/worker/             Cloudflare Worker hosting the installer
scripts/replay.ts           whole-session re-proof from audit logs
test/                       verifier proofs + parser tests
```

## Credits

Built on [pi](https://github.com/earendil-works/pi) by Earendil and
[Aeon](https://github.com/alcides/aeon) (LASIGE, University of Lisbon). The
policy pattern adapts Aeon's own `lethal_trifecta.ae` example; the threat model
follows Simon Willison's lethal-trifecta write-up.
