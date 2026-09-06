import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A client-side abort is not an HTTP response, so an `ErrorRule[]` cannot
 * describe it: `matchRule` is only ever consulted against a status and a body.
 * Every `api()` call therefore got one generic answer — "Retry once" — which
 * is right for a read and wrong for a call that STARTED something long.
 *
 * TASK-675 makes that the normal case rather than an edge one: a 12 GB backup
 * runs for well over an hour, `backup_now` aborts at 180 s, and `clawkeepd`
 * has no single-instance guard of any kind — no pidfile, no flock, nothing in
 * `daemon.py`, `runner.py` or `state.py` — so "retry once" means a second full
 * archive-and-upload beside the first, on one Jetson's eMMC.
 */

let api: typeof import("../../../mcp/lib/api").api;
let ToolError: typeof import("../../../mcp/lib/errors").ToolError;

const originalFetch = globalThis.fetch;

/** What `AbortSignal.timeout` rejects with. */
function abortError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

beforeEach(async () => {
  vi.resetModules();
  process.env.CLAWBOX_MCP_TOKEN = "0123456789abcdef0123";
  api = (await import("../../../mcp/lib/api")).api;
  ToolError = (await import("../../../mcp/lib/errors")).ToolError;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CLAWBOX_MCP_TOKEN;
});

describe("what api() tells the model when its own timeout fires", () => {
  it("keeps the generic 'retry once' for an ordinary read", async () => {
    globalThis.fetch = vi.fn(async () => { throw abortError(); }) as unknown as typeof fetch;

    const err = await api("/setup-api/system/stats").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as InstanceType<typeof ToolError>).code).toBe("TIMEOUT");
    expect((err as InstanceType<typeof ToolError>).next).toMatch(/retry once/i);
  });

  it("lets a call that started something long say so instead", async () => {
    globalThis.fetch = vi.fn(async () => { throw abortError(); }) as unknown as typeof fetch;

    const err = await api("/setup-api/clawkeep/backup", {
      method: "POST",
      body: {},
      onTimeout: {
        message: "The backup is taking longer than this call waits. It is still running.",
        next: "Do not start another one. Tell the user it is still going, and call backup_list later to confirm it landed.",
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ToolError);
    const tool = err as InstanceType<typeof ToolError>;
    expect(tool.code).toBe("TIMEOUT");
    expect(tool.message).toMatch(/still running/i);
    expect(tool.next).toMatch(/do not start another one/i);
    expect(tool.next).not.toMatch(/retry/i);
  });

  it("does not fire on a plain network failure, which really is worth a retry", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("fetch failed"); }) as unknown as typeof fetch;

    const err = await api("/setup-api/clawkeep/backup", {
      method: "POST",
      onTimeout: { message: "never used", next: "never used" },
    }).catch((e: unknown) => e);

    expect((err as InstanceType<typeof ToolError>).code).toBe("ENDPOINT_DOWN");
  });
});

describe("backup_now's own advice", () => {
  it("names backup_list, and never backup_status, which answers about the LAST run", async () => {
    // `backup_status` derives from `deriveProtection`, which judges the last
    // COMPLETED backup and knows nothing of a run in flight — mid-run on a box
    // that has never finished one it reports "never backed up, unprotected".
    const src = await import("fs/promises")
      .then((fs) => fs.readFile("mcp/tools/system.ts", "utf8"));
    const at = src.indexOf("onTimeout: {");
    expect(at, "backup_now must pass onTimeout").toBeGreaterThan(-1);
    const block = src.slice(at, at + 400);
    expect(block).toMatch(/backup_list/);
    expect(block).not.toMatch(/backup_status/);
    expect(block).toMatch(/[Dd]o not start another one/);
  });
});
