import { readFile } from "fs/promises";
import path from "path";

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
 *
 * What the replacement may NOT do is answer one false certainty with another.
 */

let api: typeof import("../../../mcp/lib/api").api;
let ToolError: typeof import("../../../mcp/lib/errors").ToolError;

const originalFetch = globalThis.fetch;

const repoFile = (rel: string) => readFile(path.join(process.cwd(), rel), "utf8");

/**
 * The advice `backup_now` actually ships, read out of `mcp/tools/system.ts`.
 *
 * Read rather than restated: a copy of the sentence in this file pins nothing.
 * It stays green while the shipped string says the opposite — which is exactly
 * what happened here, a wording fix recorded in a commit subject, an in-thread
 * reply and a resolved review thread while the source kept the old sentence.
 *
 * The `onTimeout` match is anchored inside `backup_now` and demands `message`
 * and `next` adjacent within the braces, so it cannot run past the block and
 * pick up the `ENDPOINT_DOWN` handler below, which names `backup_status` for
 * its own good reasons.
 */
async function shippedBackupNowAdvice(): Promise<{ description: string; message: string; next: string }> {
  const src = await repoFile("mcp/tools/system.ts");
  const tool = /reg\.tool\(\s*"backup_now",\s*"([^"]+)"/.exec(src);
  expect(tool, "system.ts must register backup_now with a description").not.toBeNull();
  const block = /onTimeout: \{\s*message: "([^"]+)",\s*next: "([^"]+)",\s*\}/.exec(src.slice(tool!.index));
  expect(block, "backup_now must pass onTimeout, with a message and a next").not.toBeNull();
  return { description: tool![1], message: block![1], next: block![2] };
}

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

    // The SHIPPED sentences, not stand-ins: this asserts what a real
    // `backup_now` abort puts in front of the model, message included.
    const advice = await shippedBackupNowAdvice();
    const err = await api("/setup-api/clawkeep/backup", {
      method: "POST",
      body: {},
      onTimeout: { message: advice.message, next: advice.next },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ToolError);
    const tool = err as InstanceType<typeof ToolError>;
    expect(tool.code).toBe("TIMEOUT");
    expect(tool.message).toBe(advice.message);
    expect(tool.message).toMatch(/may still be running/i);
    expect(tool.next).toBe(advice.next);
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
  it("never states as fact that a backup this call can no longer see is alive", async () => {
    // `AbortSignal.timeout` establishes that THIS CLIENT stopped waiting, and
    // nothing else. `clawkeepd` may have exited 127/64/65, the box may have
    // rebooted, the Next worker may have been replaced — and "It is still
    // running." is relayed to the owner as fact over every one of those. That
    // is the mirror of the defect this PR fixes (a healthy backup reported as
    // timed out), and the same false certainty as the "Retry once" the option
    // replaces, pointing the other way. All three sentences the model sees
    // must hedge: the tool description, and both halves of `onTimeout`.
    const advice = await shippedBackupNowAdvice();
    for (const half of ["description", "message", "next"] as const) {
      const sentence = advice[half];
      expect(sentence, `backup_now's ${half} must hedge`).toMatch(/\bmay still be (running|going)\b/i);
      expect(sentence, `backup_now's ${half} must not assert the run is alive`)
        .not.toMatch(/\bis still (running|going)\b/i);
    }
  });

  it("names backup_list, and never backup_status, which answers about the LAST run", async () => {
    // `backup_status` derives from `deriveProtection`, which judges the last
    // COMPLETED backup and knows nothing of a run in flight — mid-run on a box
    // that has never finished one it reports "never backed up, unprotected".
    const { description, next } = await shippedBackupNowAdvice();
    expect(next).toMatch(/backup_list/);
    expect(next).not.toMatch(/backup_status/);
    expect(next).toMatch(/[Dd]o not start another one/);
    expect(description).toMatch(/backup_list/);
  });
});
