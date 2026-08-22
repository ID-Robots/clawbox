import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Whether a Hermes box actually LOOKS at an attached picture.
 *
 * This is the quietest failure in the attachment feature and the reason it
 * needs its own test. Everything else about attaching an image fails loudly —
 * the flag is missing, the path does not resolve, the button is not there. This
 * one succeeds: the turn runs, an answer comes back, and it is an answer about
 * an image nobody looked at.
 *
 * The mechanism is `agent/image_routing.py` in `auto` mode. It attaches the
 * image natively when the ACTIVE model reports `supports_vision`, and otherwise
 * routes it through `vision_analyze` using whatever `auxiliary.vision` names.
 * A ClawBox AI Hermes box runs a bare DeepSeek id, which is not vision-capable,
 * and the live box reports `auxiliary.vision` present-but-unset — so without
 * these two lines there is no second model to fall back to and the picture is
 * degraded to a description of itself.
 */

const cliMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: vi.fn() }));
vi.mock("@/lib/config-store", () => ({ setMany: vi.fn() }));

import { CLAWAI_PROVIDER, ClawaiApplyError, applyClawaiToHermes } from "@/lib/hermes-clawai";
import { CLAWBOX_AI_VISION_MODEL_ID } from "@/lib/clawbox-ai-models";

/** Every `config set`, as "key=value", in the order they were issued. */
function sets(): string[] {
  return cliMock.mock.calls
    .map((c) => c[0] as string[])
    .filter((a) => a[1] === "set")
    .map((a) => `${a[2]}=${a[3]}`);
}

/** Every key touched by any `config` verb, set or unset. */
function keys(): string[] {
  return cliMock.mock.calls.map((c) => (c[0] as string[])[2]);
}

describe("pointing Hermes at ClawBox AI", () => {
  beforeEach(() => {
    cliMock.mockReset();
    cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  });

  it("names a model that can see, so an attached picture is looked at", async () => {
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(sets()).toContain(`auxiliary.vision.provider=${CLAWAI_PROVIDER}`);
    expect(sets()).toContain(`auxiliary.vision.model=${CLAWBOX_AI_VISION_MODEL_ID}`);
  });

  it("leaves the vision endpoint and key to be inherited from the provider block", async () => {
    // Deliberately NOT written. A spelled-out `base_url` shadows the
    // `providers.clawai` block — and would shadow it with no credential beside
    // it, which is the same trap the two `model.*` unsets above exist for.
    // Naming the provider is what carries the URL and the token together.
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(keys()).not.toContain("auxiliary.vision.base_url");
    expect(keys()).not.toContain("auxiliary.vision.api_key");
  });

  it("uses the BARE vision model id, like the chat model beside it", async () => {
    // The proxy answers "HTTP 400: Model not allowed" for a vendor-prefixed
    // slug. The prefixed spelling is the OpenClaw one and must not leak here.
    await applyClawaiToHermes("claw_token_abc", "pro");
    const vision = sets().find((s) => s.startsWith("auxiliary.vision.model="));
    expect(vision).toBeDefined();
    expect(vision).not.toContain("/");
  });

  it("configures vision on the pro tier too, not only on flash", async () => {
    // Seeing is not a tier feature — both tiers run a chat model that cannot,
    // so both need the fallback.
    await applyClawaiToHermes("claw_token_abc", "pro");
    expect(sets()).toContain(`auxiliary.vision.model=${CLAWBOX_AI_VISION_MODEL_ID}`);
  });

  it("still fails loudly when the vision step itself cannot be written", async () => {
    // A box that silently half-configured would be back to describing pictures
    // instead of reading them, with nothing on screen to say so.
    cliMock.mockImplementation(async (args: string[]) =>
      args[2] === "auxiliary.vision.model"
        ? { code: 1, stdout: "", stderr: "unknown config key" }
        : { code: 0, stdout: "", stderr: "" },
    );
    await expect(applyClawaiToHermes("claw_token_abc", "flash")).rejects.toBeInstanceOf(
      ClawaiApplyError,
    );
  });

  it("configures the chat model before the vision fallback that backs it", async () => {
    // Order matters for the inheritance above: `auxiliary.vision.provider`
    // names a provider block, so that block has to exist by the time it does.
    await applyClawaiToHermes("claw_token_abc", "flash");
    const order = sets();
    expect(order.findIndex((s) => s.startsWith(`providers.${CLAWAI_PROVIDER}.base_url=`)))
      .toBeLessThan(order.findIndex((s) => s.startsWith("auxiliary.vision.provider=")));
  });
});
