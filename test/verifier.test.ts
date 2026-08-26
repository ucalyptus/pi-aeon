import { describe, test, expect } from "bun:test";
import { encodeProbe, verify } from "../src/verifier.ts";

const read = (resource: "private" | "public", label = ""): TraceAction => ({
  tool: "read_file",
  op: "do_read",
  resource,
  label,
});
const publish = (): TraceAction => ({ tool: "publish_post", op: "do_publish", label: "" });
const write = (resource: "private" | "public"): TraceAction => ({
  tool: "write_file",
  op: "do_write",
  resource,
});

describe("encodeProbe", () => {
  test("chains lets and terminates with sink for non-publish tails", () => {
    const src = encodeProbe([read("public"), write("private")]);
    expect(src).toContain("let s1 := do_read mk_public s0 in");
    expect(src).toContain("let s2 := do_write mk_private s1 in");
    expect(src.trim().endsWith("sink s2;")).toBe(true);
  });

  test("ends with the publish application when proposed action is publish", () => {
    const src = encodeProbe([read("public")], publish());
    expect(src.trim()).toMatch(/do_publish s1;$/);
  });
});

describe("verify — policy proofs via Z3", () => {
  test("empty trace is provable", async () => {
    expect((await verify([])).ok).toBe(true);
  }, 60_000);

  test("publish after public reads only: proven safe", async () => {
    const v = await verify([read("public"), read("public")], publish());
    expect(v.ok).toBe(true);
  }, 60_000);

  test("publish after private read: rejected with counterexample", async () => {
    const v = await verify([read("private")], publish());
    expect(v.ok).toBe(false);
    if (!v.ok && !("failed" in v)) {
      expect(v.reason).toContain("Policy violated");
    }
  }, 60_000);

  test("writing to a private file does NOT taint; publish still allowed", async () => {
    const v = await verify([write("private")], publish());
    expect(v.ok).toBe(true);
  }, 60_000);

  test("taint is monotone: private read poisons all later publishes", async () => {
    const v = await verify([read("public"), read("private"), write("public")], publish());
    expect(v.ok).toBe(false);
  }, 60_000);

  test("verifier caches identical probes", async () => {
    const trace = [read("public")];
    const t0 = Date.now();
    await verify(trace, publish());
    const second = await verify(trace, publish());
    expect(second.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000); // second call must hit cache
  }, 60_000);
});
