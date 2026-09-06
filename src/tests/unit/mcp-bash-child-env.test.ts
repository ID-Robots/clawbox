import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { captureRegistrar, type CaptureHarness } from "../helpers/mcp-registrar";

/**
 * The device bearer must not be in the environment a `bash` child inherits.
 *
 * `mcp/lib/jobs.ts` spawns `bash -c` with `{ ...process.env }`, and on
 * OpenClaw scripts/gateway-pre-start.sh registers this server with
 * `CLAWBOX_MCP_TOKEN` in its env — so `printenv CLAWBOX_MCP_TOKEN`, from a
 * page the agent was told to summarise, yielded the bearer the middleware
 * admits on every /setup-api/* route. The fix is not an allow-list (the box's
 * scripts need the NVIDIA and XDG variables an allow-list would drop) but a
 * scrub: `primeApiToken` reads the value into the api module's cache and
 * deletes it from process.env, first thing in the server's `main()`, before
 * any probe or tool can spawn. This test calls that same function.
 */

const VALUE = "t0k3n".repeat(8); // 40 chars, well past MIN_TOKEN_LEN
const PREVIOUS = process.env.CLAWBOX_MCP_TOKEN;

let api: typeof import("../../../mcp/lib/api");
let harness: CaptureHarness;

beforeAll(async () => {
  process.env.CLAWBOX_MCP_TOKEN = VALUE;
  api = await import("../../../mcp/lib/api");
  const { registerCodingTools } = await import("../../../mcp/tools/coding");
  harness = captureRegistrar("openclaw");
  registerCodingTools(harness.reg);
});

afterAll(() => {
  if (PREVIOUS === undefined) delete process.env.CLAWBOX_MCP_TOKEN;
  else process.env.CLAWBOX_MCP_TOKEN = PREVIOUS;
});

describe("the bearer is scrubbed from the environment before a bash child can see it", () => {
  it("primeApiToken caches the value and deletes the variable", () => {
    expect(process.env.CLAWBOX_MCP_TOKEN).toBe(VALUE);
    const primed = api.primeApiToken();
    expect(primed).toEqual({ token: VALUE, source: "env" });
    expect(process.env.CLAWBOX_MCP_TOKEN).toBeUndefined();
  });

  it("a bash tool run of printenv finds nothing", async () => {
    const out = await harness.call("bash", {
      command: "printenv CLAWBOX_MCP_TOKEN; echo rc=$?",
      timeout: 10_000,
      run_in_background: false,
      cwd: os.tmpdir(),
      allow_dangerous: false,
    });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).not.toContain(VALUE);
    // printenv exits 1 for a variable that is not set.
    expect(out.text).toContain("rc=1");
  });

  it("the shell's whole environment carries the value nowhere", async () => {
    // Not only under its own name: the scrub deletes the variable, it does
    // not rename it, so no other key can carry the value into a child.
    const out = await harness.call("bash", {
      command: "env",
      timeout: 10_000,
      run_in_background: false,
      cwd: os.tmpdir(),
      allow_dangerous: false,
    });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).not.toContain(VALUE);
    expect(out.text).not.toContain("CLAWBOX_MCP_TOKEN=");
  });

  it("apiToken still answers the cached value for this process", () => {
    expect(api.apiToken()).toEqual({ token: VALUE, source: "env" });
    expect(api.authHeader()).toBe(`Bearer ${VALUE}`);
  });

  it("main() scrubs before anything it awaits can spawn a child", () => {
    // The mechanism above is only worth what its ORDER is worth: a probe
    // moved above the scrub would hand the startup children the bearer and
    // pass every test here. Pin the wiring the way the repo pins other
    // orderings — as text, on the server's entry point.
    const source = fs.readFileSync(path.join(process.cwd(), "mcp", "clawbox-mcp.ts"), "utf-8");
    const start = source.indexOf("async function main(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start);
    const scrub = body.indexOf("primeApiToken();");
    expect(scrub).toBeGreaterThan(-1);
    const firstAwait = body.indexOf("await ");
    const harnessProbe = body.indexOf("resolveAppHarness(");
    const context = body.indexOf("buildServer(");
    expect(scrub).toBeLessThan(firstAwait);
    expect(scrub).toBeLessThan(harnessProbe);
    expect(scrub).toBeLessThan(context);
  });
});
