import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-713, the Hermes leg — the ClawBox AI tier badge fills in a DEFAULT, and
 * a default never overwrites a choice.
 *
 * `applyClawaiToHermes` runs on every link, re-link, pasted token and plan-card
 * press, and it wrote `model.default = clawaiModelForTier(badge)` every time.
 * The badge follows the portal's `deviceTier`, which is a device default a Max
 * subscriber may deliberately leave on Flash for one box — so a re-pair
 * replaced an entitled Max model with Flash, and nothing on the box could put
 * it back except the owner noticing and picking it again.
 */

const cliMock = vi.hoisted(() => vi.fn());
const getKnownMock = vi.hoisted(() => vi.fn());
const setManyMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/config-store", () => ({ setMany: setManyMock, getKnown: getKnownMock }));
vi.mock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: vi.fn() }));
vi.mock("@/lib/hermes-env", () => ({ setHermesEnvValues: vi.fn() }));
vi.mock("@/lib/coding-agent", () => ({ getCodingAgentStatus: vi.fn(async () => ({ ready: false })) }));
vi.mock("@/lib/coding-agent-mcp-refresh", () => ({ refreshCodingAgentToolsIfReadinessChanged: vi.fn() }));
vi.mock("@/lib/hermes-image-plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-image-plugin")>()),
  installHermesImagePlugin: vi.fn(),
}));
vi.mock("@/lib/clawbox-ai-vision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clawbox-ai-vision")>()),
  resolveVisionModelId: vi.fn(async () => ({ id: "deepseek-v4-flash-vision-exp", verified: true, reason: "proxy-allows" })),
}));

import { applyClawaiToHermes } from "@/lib/hermes-clawai";
import { CLAWBOX_AI_FLASH_MODEL_ID, CLAWBOX_AI_PRO_MODEL_ID } from "@/lib/clawbox-ai-models";
import { EXPLICIT_MODEL_PICKS_KEY } from "@/lib/explicit-model-pick";

/** What `model.default` was set to, or undefined when it was never written. */
function modelDefaultWrite(): string | undefined {
  const call = cliMock.mock.calls
    .map((c) => c[0] as string[])
    .find((a) => a[1] === "set" && a[2] === "model.default");
  return call?.[3];
}

/** The config store this box holds. */
function store(values: Record<string, unknown>) {
  getKnownMock.mockImplementation(async (key: string) => ({ value: values[key], known: true }));
}

beforeEach(() => {
  cliMock.mockReset();
  cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  getKnownMock.mockReset();
  setManyMock.mockReset();
  setManyMock.mockResolvedValue(undefined);
  store({});
});

describe("a Hermes re-pair and the owner's own model", () => {
  it("writes the tier default when the owner has never picked one", async () => {
    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(modelDefaultWrite()).toBe(CLAWBOX_AI_FLASH_MODEL_ID);
  });

  it("keeps the owner's Max model when the badge says Flash", async () => {
    store({ [EXPLICIT_MODEL_PICKS_KEY]: { clawai: CLAWBOX_AI_PRO_MODEL_ID } });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(modelDefaultWrite()).toBe(CLAWBOX_AI_PRO_MODEL_ID);
  });

  it("reads a pick the OpenClaw picker wrote fully qualified", async () => {
    // The marker is one store for both editions, and the two pickers spell the
    // same model differently — a box migrated between them must not lose the
    // choice to a slash.
    store({ [EXPLICIT_MODEL_PICKS_KEY]: { clawai: `deepseek/${CLAWBOX_AI_PRO_MODEL_ID}` } });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(modelDefaultWrite()).toBe(CLAWBOX_AI_PRO_MODEL_ID);
  });

  it("is not moved by a pick the owner made for a DIFFERENT provider", async () => {
    // Connecting ClawBox AI is itself a provider choice, and the Anthropic slot
    // says nothing about which ClawBox AI model to run — but it must not erase
    // the ClawBox AI slot either, which is why the picks are keyed per provider.
    store({
      [EXPLICIT_MODEL_PICKS_KEY]: {
        anthropic: "anthropic/claude-opus-5",
        clawai: CLAWBOX_AI_PRO_MODEL_ID,
      },
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(modelDefaultWrite()).toBe(CLAWBOX_AI_PRO_MODEL_ID);
  });

  it("drops the pick when the box is linked to a DIFFERENT ClawBox AI account", async () => {
    // The choice belonged to the account that has just been replaced. Imposing
    // it on the next one hands the new owner a model their plan may refuse —
    // and every turn fails on a box they have only just paired.
    store({
      clawai_token: "claw_token_ACCOUNT_A",
      [EXPLICIT_MODEL_PICKS_KEY]: { clawai: CLAWBOX_AI_PRO_MODEL_ID },
    });

    await applyClawaiToHermes("claw_token_ACCOUNT_B", "flash");

    expect(modelDefaultWrite()).toBe(CLAWBOX_AI_FLASH_MODEL_ID);
    // Cleared in the SAME write that stores the replacement token, so a failed
    // clear cannot leave account A's pick beside account B's token.
    expect(setManyMock).toHaveBeenCalledWith(expect.objectContaining({
      clawai_token: "claw_token_ACCOUNT_B",
      [EXPLICIT_MODEL_PICKS_KEY]: {},
    }));
  });

  it("keeps the pick when the same account re-pairs", async () => {
    store({
      clawai_token: "claw_token_ACCOUNT_A",
      [EXPLICIT_MODEL_PICKS_KEY]: { clawai: CLAWBOX_AI_PRO_MODEL_ID },
    });

    await applyClawaiToHermes("claw_token_ACCOUNT_A", "flash");

    expect(modelDefaultWrite()).toBe(CLAWBOX_AI_PRO_MODEL_ID);
  });

  it("refuses a stored slot that is not a provider name", async () => {
    // The slot is derived from a model reference that arrives in a request
    // body, so it is validated rather than trusted — a name like `__proto__`
    // has meaning to an object before it has meaning to us.
    store({ [EXPLICIT_MODEL_PICKS_KEY]: { __proto__: CLAWBOX_AI_PRO_MODEL_ID } });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(modelDefaultWrite()).toBe(CLAWBOX_AI_FLASH_MODEL_ID);
  });

  it("lets the badge decide when the store could not be read at all", async () => {
    // Beta's answer, kept on purpose: a link that writes no model is a box with
    // no working chat, and bookkeeping we could not read is not worth holding a
    // pairing hostage to.
    getKnownMock.mockResolvedValue({ value: undefined, known: false });

    await applyClawaiToHermes("claw_token_abc", "pro");

    expect(modelDefaultWrite()).toBe(CLAWBOX_AI_PRO_MODEL_ID);
  });
});
