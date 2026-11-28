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
 * Hermes does not know the bare DeepSeek id a ClawBox AI box runs can see, and
 * the live box reports `auxiliary.vision` present-but-unset — so without these
 * two lines there is no model to route the picture to and it is degraded to a
 * description of itself.
 *
 * Since TASK-2261 the model that looks is the one the vision check names:
 * ClawBox AI's own `deepseek-v4-flash` while it sees, the fallback while it
 * does not, and nothing — which the chat then says plainly — when neither
 * does. The slot is claimed when it is empty or names a model ClawBox put
 * there, and an owner's own vision model stays.
 */

const cliMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: vi.fn() }));
// `getKnown` too: the link reads the owner's explicit model picks before
// deciding what the tier badge may write (TASK-713). Nothing stored here, so the
// badge decides, exactly as it did before the marker existed.
vi.mock("@/lib/config-store", () => ({
  setMany: vi.fn(),
  getKnown: vi.fn(async () => ({ value: undefined, known: true })),
  // `get`/`set` are how the link reads and clears the persisted ClawBox AI
  // credential refusal — the record that decides whether the image slot may be
  // armed. Both calls sit inside a catch that answers a DEFAULT, so omitting
  // them would silently put every case here on the "no refusal" branch
  // (openclaw-config-mock-completeness.test.ts).
  get: vi.fn(async () => undefined),
  set: vi.fn(),
}));
// The image half of the apply writes to ~/.hermes and copies a plugin into it.
// Neither belongs in a unit test's blast radius, and both have their own file
// (`hermes-clawai-images.test.ts`).
vi.mock("@/lib/hermes-env", () => ({ setHermesEnvValues: vi.fn() }));
// `hermes-clawai` now reads the coding-agent verdict either side of the writes,
// and that module owns a runs store keyed off DATA_DIR. Only the verdict is
// wanted here; `checkReadiness` has its own suite.
vi.mock("@/lib/coding-agent", () => ({ getCodingAgentStatus: vi.fn(async () => ({ ready: false })) }));
vi.mock("@/lib/coding-agent-mcp-refresh", () => ({
  refreshCodingAgentToolsIfReadinessChanged: vi.fn(),
}));
vi.mock("@/lib/hermes-image-plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-image-plugin")>()),
  installHermesImagePlugin: vi.fn(),
}));

const probeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clawbox-ai-vision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clawbox-ai-vision")>()),
  probeClawboxAiVision: probeMock,
}));

import {
  CLAWAI_DEFAULT_MODEL,
  CLAWAI_PROVIDER,
  ClawaiApplyError,
  applyClawaiToHermes,
} from "@/lib/hermes-clawai";
import { CLAWBOX_AI_FLASH_MODEL_ID, CLAWBOX_AI_VISION_FALLBACK_MODEL_ID } from "@/lib/clawbox-ai-models";
import { get as configGet } from "@/lib/config-store";
import { RETIRED_CLAWBOX_AI_VISION_MODEL_IDS } from "@/lib/clawbox-ai-retired-models";

const FALLBACK = CLAWBOX_AI_VISION_FALLBACK_MODEL_ID;
const SEES = { verdict: "flash", model: CLAWBOX_AI_FLASH_MODEL_ID, flash: "sees", fallback: null };
const FALLS_BACK = { verdict: "fallback", model: FALLBACK, flash: "blind", fallback: "sees" };
const NOBODY = { verdict: "none", model: null, flash: "blind", fallback: "blind" };
const NO_ANSWER = { verdict: "unknown", model: null, flash: "unknown", fallback: "unknown" };

/** Answer `config get auxiliary.vision --json` with `answer`; every other call succeeds quietly. */
function visionSlot(answer: { code: number; stdout?: string; stderr?: string }) {
  cliMock.mockImplementation(async (args: string[]) =>
    args[1] === "get" && args[2] === "auxiliary.vision"
      ? { stdout: "", stderr: "", ...answer }
      : { code: 0, stdout: "", stderr: "" });
}

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
    probeMock.mockReset();
    probeMock.mockResolvedValue(SEES);
  });

  it("names Flash while the vision check says it sees", async () => {
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(probeMock).toHaveBeenCalledWith(expect.objectContaining({ token: "claw_token_abc" }));
    expect(sets()).toContain(`auxiliary.vision.provider=${CLAWAI_PROVIDER}`);
    expect(sets()).toContain(`auxiliary.vision.model=${CLAWBOX_AI_FLASH_MODEL_ID}`);
  });

  it("names the fallback while Flash cannot see", async () => {
    probeMock.mockResolvedValue(FALLS_BACK);
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(sets()).toContain(`auxiliary.vision.model=${FALLBACK}`);
    // The chat model stays Flash: only the picture moves.
    expect(sets()).toContain(`model.default=${CLAWBOX_AI_FLASH_MODEL_ID}`);
  });

  it("arms no picture route when neither can see, and clears ours", async () => {
    probeMock.mockResolvedValue(NOBODY);
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(sets().some((kv) => kv.startsWith("auxiliary.vision."))).toBe(false);

    cliMock.mockReset();
    visionSlot({ code: 0, stdout: JSON.stringify({ provider: CLAWAI_PROVIDER, model: CLAWBOX_AI_FLASH_MODEL_ID }) });
    await applyClawaiToHermes("claw_token_abc", "flash");
    const unsets = cliMock.mock.calls.map((c) => c[0] as string[]).filter((a) => a[1] === "unset").map((a) => a[2]);
    expect(unsets).toEqual(expect.arrayContaining(["auxiliary.vision.model", "auxiliary.vision.provider"]));
  });

  it("keeps the slot it has when the question cannot be answered", async () => {
    probeMock.mockResolvedValue(NO_ANSWER);
    visionSlot({ code: 0, stdout: JSON.stringify({ provider: CLAWAI_PROVIDER, model: FALLBACK }) });
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(sets()).toContain(`auxiliary.vision.model=${FALLBACK}`);
  });

  it("keeps a box the last check left with no picture route without one, when it cannot ask", async () => {
    probeMock.mockResolvedValue(NO_ANSWER);
    visionSlot({ code: 1, stderr: "config key not set" });
    vi.mocked(configGet).mockImplementation(async (key: string) =>
      key === "clawai_vision" ? { verdict: "none", model: null, checkedAt: 1 } : undefined);
    try {
      await applyClawaiToHermes("claw_token_abc", "flash");
    } finally {
      vi.mocked(configGet).mockImplementation(async () => undefined);
    }
    expect(sets().some((kv) => kv.startsWith("auxiliary.vision."))).toBe(false);
  });

  it("claims a slot Hermes ships empty, and one whose key is not set", async () => {
    visionSlot({ code: 0, stdout: JSON.stringify({ provider: "auto", model: "", base_url: "", api_key: "" }) });
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(sets()).toContain(`auxiliary.vision.model=${CLAWBOX_AI_FLASH_MODEL_ID}`);

    cliMock.mockReset();
    visionSlot({ code: 1, stderr: "config key not set" });
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(sets()).toContain(`auxiliary.vision.model=${CLAWBOX_AI_FLASH_MODEL_ID}`);
  });

  it("moves a slot naming the separate vision model's id, or the fallback, to the model that sees", async () => {
    for (const id of [...RETIRED_CLAWBOX_AI_VISION_MODEL_IDS, FALLBACK]) {
      cliMock.mockReset();
      visionSlot({ code: 0, stdout: JSON.stringify({ provider: CLAWAI_PROVIDER, model: id }) });
      await applyClawaiToHermes("claw_token_abc", "flash");
      expect(sets()).toContain(`auxiliary.vision.model=${CLAWBOX_AI_FLASH_MODEL_ID}`);
    }
  });

  it("leaves an owner's own vision model alone, and does not even ask", async () => {
    for (const owner of [
      { provider: "openai", model: FALLBACK },
      { provider: "openrouter", model: "google/gemini-2.5-flash" },
      { provider: CLAWAI_PROVIDER, model: "some-model-the-owner-typed" },
    ]) {
      cliMock.mockReset();
      probeMock.mockClear();
      visionSlot({ code: 0, stdout: JSON.stringify(owner) });
      await applyClawaiToHermes("claw_token_abc", "flash");
      expect(sets().some((kv) => kv.startsWith("auxiliary.vision."))).toBe(false);
      expect(probeMock).not.toHaveBeenCalled();
    }
  });

  it("writes no vision model at all when the config cannot be read", async () => {
    visionSlot({ code: 1, stderr: "permission denied" });
    await applyClawaiToHermes("claw_token_abc", "flash");
    // An unreadable config is not an empty one — nothing may be overwritten.
    expect(sets().some((kv) => kv.startsWith("auxiliary.vision."))).toBe(false);
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

  it("uses the BARE model id, like the chat model beside it", async () => {
    // The proxy answers "HTTP 400: Model not allowed" for a vendor-prefixed
    // slug. The prefixed spelling is the OpenClaw one and must not leak here.
    await applyClawaiToHermes("claw_token_abc", "pro");
    const vision = sets().find((s) => s.startsWith("auxiliary.vision.model="));
    expect(vision).toBeDefined();
    expect(vision).not.toContain("/");
  });

  it("configures vision on the Max plan the same way, with the same model", async () => {
    // Seeing is not a plan feature, and every plan runs the one model.
    await applyClawaiToHermes("claw_token_abc", "pro");
    expect(sets()).toContain(`auxiliary.vision.model=${CLAWBOX_AI_FLASH_MODEL_ID}`);
  });

  it("names the session titler too, so `auto` never goes looking elsewhere", async () => {
    // Left at its shipped `provider: auto`, the titler SEARCHES — a live box's
    // own log recorded it trying openrouter, then nous, then local/custom, then
    // api-key, four services it had no account with, on a device that had a
    // working endpoint configured the whole time. Naming clawai is the same
    // move as naming it for vision: stop auto from wandering.
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(sets()).toContain(`auxiliary.title_generation.provider=${CLAWAI_PROVIDER}`);
    expect(sets()).toContain(`auxiliary.title_generation.model=${CLAWAI_DEFAULT_MODEL}`);
  });

  it("titles with a model the proxy actually serves, on every plan", async () => {
    // Same trap as the vision id: the proxy answers a slug outside its
    // allowlist with HTTP 400, which would turn every title into a failed
    // request. The chat model is by construction one it serves.
    await applyClawaiToHermes("claw_token_abc", "pro");
    expect(sets()).toContain(`auxiliary.title_generation.model=${CLAWAI_DEFAULT_MODEL}`);
    const titleModel = sets().find((s) => s.startsWith("auxiliary.title_generation.model="));
    expect(titleModel).not.toContain("/");
  });

  it("leaves the titler's endpoint and key to be inherited as well", async () => {
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(keys()).not.toContain("auxiliary.title_generation.base_url");
    expect(keys()).not.toContain("auxiliary.title_generation.api_key");
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
