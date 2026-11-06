import { describe, expect, it, vi } from "vitest";
import { waitForGatewayAfterRestart } from "@/lib/wait-for-gateway";

function healthAnswers(...answers: Array<Record<string, unknown> | Error>) {
  const queue = [...answers];
  return vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next instanceof Error) throw next;
    return { ok: true, json: async () => next } as Response;
  });
}

describe("waitForGatewayAfterRestart", () => {
  it("resolves true once /setup-api/gateway/health says the gateway is available", async () => {
    const fetchImpl = healthAnswers(
      { available: false, restarting: true },
      new Error("network blip"),
      { available: false, restarting: false },
      { available: true, restarting: false },
    );

    await expect(waitForGatewayAfterRestart({ fetchImpl, intervalMs: 1, budgetMs: 5_000 })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl).toHaveBeenCalledWith("/setup-api/gateway/health", expect.objectContaining({ cache: "no-store" }));
  });

  it("resolves false when the gateway is not back within the budget", async () => {
    const fetchImpl = healthAnswers({ available: false, restarting: true });
    await expect(waitForGatewayAfterRestart({ fetchImpl, intervalMs: 5, budgetMs: 40 })).resolves.toBe(false);
  });

  it("stops at once when the page aborts the wait", async () => {
    const fetchImpl = healthAnswers({ available: false });
    const controller = new AbortController();
    const waiting = waitForGatewayAfterRestart({ fetchImpl, intervalMs: 60_000, budgetMs: 120_000, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(waiting).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
