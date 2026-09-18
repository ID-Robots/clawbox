import { describe, expect, it } from "vitest";
import {
  gatewayFrameError,
  isGatewayStartingRefusal,
  STARTING_MAX_RETRIES,
  STARTING_RETRY_DELAY_MS,
} from "@/lib/chat-gateway-starting";

/**
 * The predicate both chat surfaces climb their reconnect ladder on, tested
 * without rendering either of them.
 *
 * It used to be exported from ChatPopup — a ~7,000-line client component — and
 * imported by ChatApp, the full page a phone lands on, which pulled the whole
 * mascot-chat import graph into that route's chunk for a one-line pure
 * function. The test that proves it never needed a component either.
 *
 * The frames below are the core's own at v2026.9.3
 * (`rejectGatewayStartupConnect` in
 * `src/gateway/server/ws-connection/connect-admission.ts`, and the sibling
 * `UNAVAILABLE` refusals in `connect-session.ts`).
 */
describe("isGatewayStartingRefusal", () => {
  it("judges the refusal on the gateway's own three fields, not on its English", () => {
    const starting = { code: "UNAVAILABLE", message: "gateway starting; retry shortly", retryable: true, details: { reason: "startup-sidecars" } };
    expect(isGatewayStartingRefusal(starting)).toBe(true);
    // The core re-wording that one sentence must not put the chat back on the
    // Retry dead end: the fields are the contract, the prose is not.
    expect(isGatewayStartingRefusal({ ...starting, message: "hold on, almost up" })).toBe(true);
    // The same code for refusals that will NEVER change on their own — a
    // Control UI build mismatch is `retryable: false`, an unsupported socket
    // receiver carries neither field. Retrying either is a loop.
    expect(isGatewayStartingRefusal({ code: "UNAVAILABLE", message: "protocol mismatch: Control UI updated; reload this page to continue", retryable: false, details: { code: "PROTOCOL_MISMATCH" } })).toBe(false);
    expect(isGatewayStartingRefusal({ code: "UNAVAILABLE", message: "unsupported Gateway WebSocket receiver" })).toBe(false);
    expect(isGatewayStartingRefusal({ code: "UNAUTHORIZED", message: "gateway starting; retry shortly" })).toBe(false);
  });

  it("falls back to the gateway's wording only for a frame that carries no code", () => {
    expect(isGatewayStartingRefusal("gateway starting; retry shortly")).toBe(true);
    expect(isGatewayStartingRefusal({ message: "gateway is starting" })).toBe(true);
    // Anchored: an unrelated refusal that happens to contain "starting" or
    // "not ready" was silently retried forty times behind the restart overlay.
    expect(isGatewayStartingRefusal("Gateway not ready")).toBe(false);
    expect(isGatewayStartingRefusal("starting the browser failed")).toBe(false);
    expect(isGatewayStartingRefusal("protocol 4 is newer than this gateway understands")).toBe(false);
    expect(isGatewayStartingRefusal("unauthorized")).toBe(false);
    expect(isGatewayStartingRefusal(undefined)).toBe(false);
  });

});

describe("gatewayFrameError", () => {
  it("carries the structured fields, not just the message", () => {
    const err = gatewayFrameError({
      code: "UNAVAILABLE",
      message: "gateway starting; retry shortly",
      retryable: true,
      details: { reason: "startup-sidecars" },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("gateway starting; retry shortly");
    expect(isGatewayStartingRefusal(err)).toBe(true);
  });

  it("still answers a frame that carries nothing", () => {
    const err = gatewayFrameError(undefined);
    expect(err.message).toBe("Request failed");
    expect(err.code).toBeUndefined();
    expect(isGatewayStartingRefusal(err)).toBe(false);
  });
});

describe("the ladder's own numbers", () => {
  it("outlasts a slow restart and still ends", () => {
    // Ten to twenty seconds is a restart; the budget has to clear that with
    // room and stop rather than retry for ever.
    expect(STARTING_RETRY_DELAY_MS).toBe(3000);
    expect(STARTING_MAX_RETRIES).toBe(40);
    expect(STARTING_RETRY_DELAY_MS * STARTING_MAX_RETRIES).toBeGreaterThan(20_000);
  });
});

describe("the full page does not pull the mascot chat in", () => {
  it("has no import of ChatPopup in ChatApp", async () => {
    // `/app/clawbox` is the full page and what a phone lands on; it did not
    // depend on ChatPopup at all until a one-line predicate was imported from
    // it, which drags ChatPopup's whole import graph — chat cards, email batch,
    // approvals, speech, tool events — into that route's chunk. The shared
    // pieces live in src/lib for exactly this reason (the split
    // chat-reasoning.ts was created for), so the dependency must stay absent.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(process.cwd(), "src", "components", "ChatApp.tsx"),
      "utf-8",
    );
    expect(source).not.toMatch(/from\s+['"](\.\/ChatPopup|@\/components\/ChatPopup)['"]/);
  });
});
