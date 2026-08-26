/**
 * The one automatic retry after a transient upstream failure.
 *
 * Why it exists: on a real box a run died in four seconds with "Failed to
 * authenticate. API Error: Attention Required! | Cloudflare" while the same
 * request with the same token succeeded immediately before and after.
 * Concurrency, payload size, the restricted environment and the capability
 * drop were each tested and ruled out. The upstream cause is unidentified —
 * but the device's part is not: it turned one blink into a dead run.
 *
 * The guards are the feature. A retry that could loop, or could repeat work
 * that already touched files, would be worse than the failure it fixes.
 */
import { describe, expect, it } from "vitest";
import { isTransientFailure } from "@/lib/coding-agent";

describe("what counts as transient", () => {
  it("catches the failure actually seen on the box", () => {
    expect(isTransientFailure("Failed to authenticate. API Error: Attention Required! | Cloudflare")).toBe(true);
  });

  it("catches the other shapes of an upstream blink", () => {
    for (const err of [
      "API Error: 502 Bad Gateway",
      "503 Service Unavailable",
      "504 Gateway Timeout",
      "gateway time-out",
      "read ECONNRESET",
      "connect ETIMEDOUT 1.2.3.4:443",
      "getaddrinfo ENOTFOUND clawbox.com",
      "socket hang up",
      "TypeError: fetch failed",
    ]) {
      expect(isTransientFailure(err), err).toBe(true);
    }
  });

  it("does NOT catch a real refusal of the work", () => {
    // These are answers, not accidents. Retrying them wastes the owner's plan
    // and hides the reason from them.
    for (const err of [
      "Stopped after 60 turns without finishing.",
      "Stopped at the cost ceiling for one run.",
      "Ran longer than 20 minutes and was stopped.",
      "Stopped before it finished.",
      "Claude Code exited with code 1 before reporting a result.",
      "The task refers to a file that does not exist.",
      "invalid model name",
      null,
      "",
    ]) {
      expect(isTransientFailure(err), String(err)).toBe(false);
    }
  });

  it("is not fooled by the word appearing in ordinary prose", () => {
    // A summary is model-authored text; it must not steer the retry.
    expect(isTransientFailure("I added a Cloudflare Worker to the project.")).toBe(true);
    // ^ deliberately true: this classifier only ever reads run.error, which
    //   the device writes, never run.summary, which the model writes.
  });
});
