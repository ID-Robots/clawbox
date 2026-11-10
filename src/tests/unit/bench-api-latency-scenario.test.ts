import { describe, expect, it } from "vitest";
import { run } from "../../../scripts/bench/scenarios/api-latency.mjs";

// The bench's api area (scripts/bench/scenarios/api-latency.mjs) runs in token
// mode on the MCP bearer. A route that answers only a signed-in person refuses
// that bearer by design, so token mode must leave it out rather than score its
// 403 as an error — the email approval queue is one: it must never accept the
// credential the agent holds (src/app/setup-api/email/pending/route.ts).

const EMAIL_PENDING = "/setup-api/email/pending";

type Answer = { ok: boolean; status: number; ms: number; bytes: number };

function client(mode: "token" | "cdp", answer: (path: string) => Answer) {
  return { mode, http: async (path: string) => answer(path) };
}

const ok: Answer = { ok: true, status: 200, ms: 5, bytes: 100 };
const opts = { quick: true };
const log = () => {};

describe("api-latency scenario", () => {
  it("leaves the email approval queue out in token mode instead of counting its 403", async () => {
    const forbiddenToBearer = (path: string): Answer =>
      path === EMAIL_PENDING ? { ok: false, status: 403, ms: 3, bytes: 40 } : ok;
    const result = await run({ client: client("token", forbiddenToBearer), opts, log });
    expect(result.metrics.errors.value).toBe(0);
    expect(result.details.skipped).toContain(EMAIL_PENDING);
    expect(result.details.perRoute).not.toHaveProperty(EMAIL_PENDING);
  });

  it("still measures the email approval queue for the signed-in page (cdp mode)", async () => {
    const result = await run({ client: client("cdp", () => ok), opts, log });
    expect(result.details.perRoute).toHaveProperty(EMAIL_PENDING);
    expect(result.details.skipped).not.toContain(EMAIL_PENDING);
    expect(result.metrics.errors.value).toBe(0);
  });

  it("still counts a non-2xx from a route the bearer may read (token mode)", async () => {
    const batteryFails = (path: string): Answer =>
      path === "/setup-api/system/battery" ? { ok: false, status: 500, ms: 5, bytes: 20 } : ok;
    const result = await run({ client: client("token", batteryFails), opts, log });
    expect(result.metrics.errors.value).toBe(3);
    expect(result.details.errors).toEqual(Array(3).fill("/setup-api/system/battery → 500"));
  });
});
