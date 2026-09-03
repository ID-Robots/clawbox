import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `hermesVoiceProbePending()` — which unanswered reads make the page ask again.
 *
 * `hermesSpeaksReplies()` fails closed, so "this box has no voice" and "the box
 * could not be asked" leave by the same door. That is right for the capability
 * and wrong for the browser, which fetches these facts once on mount and on no
 * timer: one timed-out `hermes config get` hid a working voice until reload.
 *
 * It used to ask about `tts.provider` alone. The selection can answer perfectly
 * while the read that CONFIRMS it — the command definition, or the endpoint and
 * credential — is the one in backoff, and the verdict is then a `false` nobody
 * will re-ask for. Every key the verdict can rest on is asked here.
 */

const pending = new Set<string>();

vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigReadPending: (key: string) => pending.has(key),
  hermesConfigGet: async () => "",
  hermesConfigGetMany: async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, ""])),
}));

vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: async () => ({ code: 0, stdout: "", stderr: "" }) }));

beforeEach(() => {
  vi.resetModules();
  pending.clear();
});

async function probePending() {
  const { hermesVoiceProbePending } = await import("@/lib/hermes-tts");
  return hermesVoiceProbePending();
}

describe("hermesVoiceProbePending", () => {
  it("is quiet when every read answered", async () => {
    expect(await probePending()).toBe(false);
  });

  it("reports the selection's own read", async () => {
    pending.add("tts.provider");
    expect(await probePending()).toBe(true);
  });

  it("reports a PREREQUISITE read, not just the selection", async () => {
    // The case the single-key version missed: `tts.provider` answered
    // `clawbox-local`, and the read that says whether that provider is really
    // a command provider is the one that timed out.
    for (const key of [
      "tts.providers.clawbox-local.type",
      "tts.providers.clawbox-local.command",
      "tts.openai.base_url",
      "tts.openai.api_key",
    ]) {
      pending.clear();
      pending.add(key);
      expect(await probePending(), `${key} did not make the page ask again`).toBe(true);
    }
  });

  it("ignores a key that has nothing to do with the voice", async () => {
    pending.add("model.default");
    expect(await probePending()).toBe(false);
  });
});
