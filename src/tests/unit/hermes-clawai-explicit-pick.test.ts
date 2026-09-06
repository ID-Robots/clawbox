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
const configGetMock = vi.hoisted(() => vi.fn());
const storeGetMock = vi.hoisted(() => vi.fn());
const setManyMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/hermes-config-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-config-cache")>()),
  hermesConfigGet: configGetMock,
}));
vi.mock("@/lib/config-store", () => ({ setMany: setManyMock, get: storeGetMock }));
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
import { EXPLICIT_MODEL_PICK_KEY } from "@/lib/explicit-model-pick";

/** What `model.default` was set to, or undefined when it was never written. */
function modelDefaultWrite(): string | undefined {
  const call = cliMock.mock.calls
    .map((c) => c[0] as string[])
    .find((a) => a[1] === "set" && a[2] === "model.default");
  return call?.[3];
}

beforeEach(() => {
  cliMock.mockReset();
  cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  configGetMock.mockReset();
  configGetMock.mockResolvedValue("");
  storeGetMock.mockReset();
  storeGetMock.mockResolvedValue(null);
  setManyMock.mockReset();
  setManyMock.mockResolvedValue(undefined);
});

describe("a Hermes re-pair and the owner's own model", () => {
  it("writes the tier default when the owner has never picked one", async () => {
    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(modelDefaultWrite()).toBe(CLAWBOX_AI_FLASH_MODEL_ID);
  });

  it("keeps the owner's Max model when the badge says Flash", async () => {
    storeGetMock.mockImplementation(async (key: string) =>
      key === EXPLICIT_MODEL_PICK_KEY ? CLAWBOX_AI_PRO_MODEL_ID : null);

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(modelDefaultWrite()).toBe(CLAWBOX_AI_PRO_MODEL_ID);
  });

  it("reads a pick the OpenClaw picker wrote fully qualified", async () => {
    // The marker is one key for both editions, and the two pickers spell the
    // same model differently — a box migrated between them must not lose the
    // choice to a slash.
    storeGetMock.mockImplementation(async (key: string) =>
      key === EXPLICIT_MODEL_PICK_KEY ? `deepseek/${CLAWBOX_AI_PRO_MODEL_ID}` : null);

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(modelDefaultWrite()).toBe(CLAWBOX_AI_PRO_MODEL_ID);
  });

  it("treats a running model that differs from the badge as the pick, and writes it down", async () => {
    // The migration: boxes in the field are in exactly this state and carry no
    // marker, because none existed.
    configGetMock.mockImplementation(async (key: string) =>
      key === "model.default" ? CLAWBOX_AI_PRO_MODEL_ID : "");

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(modelDefaultWrite()).toBe(CLAWBOX_AI_PRO_MODEL_ID);
    expect(setManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ [EXPLICIT_MODEL_PICK_KEY]: CLAWBOX_AI_PRO_MODEL_ID }),
    );
  });

  it("lets the badge decide when the config could not be read at all", async () => {
    // An unreadable `model.default` is not evidence of a choice. The badge
    // fills the gap, exactly as on beta.
    configGetMock.mockRejectedValue(new Error("hermes config get failed"));

    await applyClawaiToHermes("claw_token_abc", "pro");

    expect(modelDefaultWrite()).toBe(CLAWBOX_AI_PRO_MODEL_ID);
    expect(setManyMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ [EXPLICIT_MODEL_PICK_KEY]: expect.anything() }),
    );
  });

  it("ignores a pick that belongs to another provider", async () => {
    storeGetMock.mockImplementation(async (key: string) =>
      key === EXPLICIT_MODEL_PICK_KEY ? "anthropic/claude-opus-5" : null);

    await applyClawaiToHermes("claw_token_abc", "pro");

    expect(modelDefaultWrite()).toBe(CLAWBOX_AI_PRO_MODEL_ID);
  });
});
