import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One question about the engine, one write of the cloud endpoint.
 *
 * Both facts are COUNTS of what actually reaches the box, so both are
 * invisible from a mocked `hermes-tts`: this file is therefore mocked at the
 * CLI seam instead, the way `tts-hermes-parity.test.ts` is, and drives the
 * real `hermesSpeaksReplies` and the real `selectHermes*` writers.
 *
 * Why counts are worth pinning here. Every `hermes config …` is a Python
 * interpreter start on an 8 GB board:
 *
 *  - `hermesSpeaksReplies` runs on EVERY Hermes chat turn, ahead of the
 *    reply's own speech budget. Answering "is the engine installed?" by
 *    building the whole TTS inventory ran the stamp read and the
 *    `systemctl --user` pair a second time and, on an active unit, a
 *    `processMemoryBytes` scan as well — to fill in a boolean.
 *  - the ClawBox AI link writes the cloud endpoint and credential inside a
 *    request the customer is watching. Writing them from the refresh AND
 *    again from the selection made that three `hermes config set` calls
 *    (15 s timeout each) instead of nothing, and gave a second chance to
 *    throw away a selection the first write had already made safe.
 */

const cliMock = vi.hoisted(() => vi.fn());
const hasEngineMock = vi.hoisted(() => vi.fn());
const probeEngineMock = vi.hoisted(() => vi.fn());
const runnableMock = vi.hoisted(() => vi.fn());
const inventoryMock = vi.hoisted(() => vi.fn());
/** What `hermes config get <key>` answers; a missing key is unset. */
const box = vi.hoisted(() => ({ config: {} as Record<string, string> }));

vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigGet: async (key: string) => box.config[key] ?? "",
  hermesConfigGetMany: async (keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, box.config[k] ?? ""])),
  hermesConfigReadPending: () => false,
}));
vi.mock("@/lib/local-models", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/local-models")>()),
  hasLocalTtsEngine: hasEngineMock,
  probeLocalTtsEngine: probeEngineMock,
  localTtsCommandRunnable: runnableMock,
  buildTtsInventory: inventoryMock,
}));
// `harness/credentials` re-exports the proxy URL from `hermes-clawai` and
// otherwise reaches `openclaw-config`, which spawns the OpenClaw CLI — the
// module graph `writeHermesCloudTarget`'s lazy import exists to keep off the
// chat turn. Only the constant is needed here.
vi.mock("@/lib/harness/credentials", () => ({
  CLAWBOX_AI_PROXY_URL: "https://clawbox.test/api/ai",
  resolveClawaiToken: vi.fn(async () => null),
  // Dropped by the link path beside `forgetProviderVerified`: a refusal the
  // proxy gave the token being replaced says nothing about the new one.
  forgetClawaiCredentialRefusal: vi.fn(),
}));
// The link path's neighbours, none of which this file is about. The vision
// resolver is mocked because it performs network I/O against the proxy.
vi.mock("@/lib/clawbox-ai-vision", () => ({
  resolveVisionModelId: vi.fn(async () => ({ id: null, reason: "unset" })),
  isClawboxAiVisionId: () => false,
}));
vi.mock("@/lib/harness/hermes-features", () => ({ hermesAgentDrawsImages: vi.fn(async () => false) }));
vi.mock("@/lib/hermes-image-refresh", () => ({ refreshHermesImageTools: vi.fn() }));
vi.mock("@/lib/coding-agent", () => ({ getCodingAgentStatus: vi.fn(async () => ({ ready: false })) }));
vi.mock("@/lib/coding-agent-mcp-refresh", () => ({ refreshCodingAgentToolsIfReadinessChanged: vi.fn() }));
vi.mock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: vi.fn() }));
// `getKnown` too: the link reads the owner's explicit model picks before
// deciding what the tier badge may write (TASK-713). Nothing stored here, so the
// badge decides, exactly as it did before the marker existed.
vi.mock("@/lib/config-store", () => ({
  setMany: vi.fn(),
  getKnown: vi.fn(async () => ({ value: undefined, known: true })),
}));
vi.mock("@/lib/hermes-env", () => ({ setHermesEnvValues: vi.fn() }));
vi.mock("@/lib/hermes-image-plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-image-plugin")>()),
  installHermesImagePlugin: vi.fn(),
}));

import { applyClawaiToHermes } from "@/lib/hermes-clawai";
import {
  CLAWBOX_AI_SPEECH_TIER,
  HERMES_CLOUD_TTS_PROVIDER,
  HERMES_LOCAL_TTS_PROVIDER,
  hermesSpeaksReplies,
} from "@/lib/hermes-tts";

const TOKEN = "claw_test_token";
const SCRIPT = "/home/clawbox/clawbox/scripts/openclaw/clawbox-tts.sh";
const CLOUD_BASE_URL = `tts.${HERMES_CLOUD_TTS_PROVIDER}.base_url`;

/** Every `hermes config set <key>`, in the order the box received them. */
function keysWritten(): string[] {
  return cliMock.mock.calls
    .map(([argv]) => argv as string[])
    .filter((argv) => argv[0] === "config" && argv[1] === "set")
    .map((argv) => argv[2]);
}

beforeEach(() => {
  cliMock.mockReset();
  cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  hasEngineMock.mockReset();
  hasEngineMock.mockResolvedValue(false);
  probeEngineMock.mockReset();
  probeEngineMock.mockResolvedValue(false);
  runnableMock.mockReset();
  runnableMock.mockResolvedValue(true);
  inventoryMock.mockReset();
  // An engine that IS installed, so a caller reading the inventory still gets
  // the right answer: what this file pins is which question is asked, not
  // which answer comes back.
  inventoryMock.mockResolvedValue([{ id: "kokoro", name: "Kokoro", kind: "tts", installed: true }]);
  box.config = {};
});

describe("the chat turn asks about the engine once", () => {
  it("goes through the shared helper, and never rebuilds the whole TTS inventory", async () => {
    box.config = {
      "tts.provider": HERMES_LOCAL_TTS_PROVIDER,
      [`tts.providers.${HERMES_LOCAL_TTS_PROVIDER}.type`]: "command",
      [`tts.providers.${HERMES_LOCAL_TTS_PROVIDER}.command`]: SCRIPT,
    };
    hasEngineMock.mockResolvedValue(true);

    await expect(hermesSpeaksReplies()).resolves.toBe(true);

    // ONE rule, in one place: `hasLocalTtsEngine` (stamp AND unit), the same
    // one `kokoroEntry` and the link path apply. A second derivation under the
    // same name was what this pins shut.
    expect(hasEngineMock).toHaveBeenCalledTimes(1);
    expect(inventoryMock, "the chat turn built the whole TTS inventory to answer a boolean")
      .not.toHaveBeenCalled();
  });

  it("still says no when the engine is absent", async () => {
    box.config = {
      "tts.provider": HERMES_LOCAL_TTS_PROVIDER,
      [`tts.providers.${HERMES_LOCAL_TTS_PROVIDER}.type`]: "command",
      [`tts.providers.${HERMES_LOCAL_TTS_PROVIDER}.command`]: SCRIPT,
    };
    hasEngineMock.mockResolvedValue(false);

    await expect(hermesSpeaksReplies()).resolves.toBe(false);
  });
});

describe("linking a box writes the cloud endpoint once", () => {
  it("does not repeat the endpoint and credential write to select the provider", async () => {
    // Nothing chosen, no on-device engine: the path that both refreshes the
    // cloud target and selects it.
    await applyClawaiToHermes(TOKEN, CLAWBOX_AI_SPEECH_TIER);

    const written = keysWritten();
    expect(
      written.filter((k) => k === CLOUD_BASE_URL),
      `the cloud endpoint was written ${written.filter((k) => k === CLOUD_BASE_URL).length} times`,
    ).toHaveLength(1);
    expect(written.filter((k) => k === `tts.${HERMES_CLOUD_TTS_PROVIDER}.api_key`)).toHaveLength(1);
    expect(written.filter((k) => k === "tts.provider")).toHaveLength(1);
  });

  it("still lands the definition before the selection", async () => {
    // The ordering `selectHermesEngine`'s docstring rests on: a box is never
    // pointed at a provider that has nowhere to send a request.
    await applyClawaiToHermes(TOKEN, CLAWBOX_AI_SPEECH_TIER);

    const written = keysWritten();
    expect(written.indexOf(CLOUD_BASE_URL)).toBeGreaterThanOrEqual(0);
    expect(written.indexOf("tts.provider")).toBeGreaterThan(written.indexOf(CLOUD_BASE_URL));
  });

  it("lands the endpoint before the credential, which is what makes an empty slot readable", async () => {
    // `ownRoute`'s `slotIsEmpty` arm treats "no URL and no key" as ours to
    // write, and its safety rests entirely on this order: because the endpoint
    // lands first, a partial write can leave URL-set/key-unset (still
    // recognisably ours) but never key-set/URL-unset, which the same rule would
    // read as an owner's slot for ever — never refreshed, never selected, and
    // nothing on the box able to undo it. Reordering these two lines is
    // therefore not a cosmetic change.
    await applyClawaiToHermes(TOKEN, CLAWBOX_AI_SPEECH_TIER);

    const written = keysWritten();
    const apiKey = `tts.${HERMES_CLOUD_TTS_PROVIDER}.api_key`;
    expect(written.indexOf(CLOUD_BASE_URL)).toBeGreaterThanOrEqual(0);
    expect(written.indexOf(apiKey)).toBeGreaterThan(written.indexOf(CLOUD_BASE_URL));
  });

  it("selects the on-device engine without spending writes on a cloud route it will not use", async () => {
    // The refresh is for the provider that SPEAKS through the slot. A box that
    // has its own voice pays neither the three `hermes config set` spawns nor
    // the proxy URL and device token parked in Hermes' generic OpenAI slot.
    box.config = {
      [`tts.providers.${HERMES_LOCAL_TTS_PROVIDER}.type`]: "command",
      [`tts.providers.${HERMES_LOCAL_TTS_PROVIDER}.command`]: SCRIPT,
    };
    probeEngineMock.mockResolvedValue(true);

    await applyClawaiToHermes(TOKEN, CLAWBOX_AI_SPEECH_TIER);

    const written = keysWritten();
    expect(written.filter((k) => k === "tts.provider")).toHaveLength(1);
    // ...and the cloud slot is left out of it entirely: this box speaks for
    // itself, so there is no route to keep fresh.
    expect(written.filter((k) => k.startsWith(`tts.${HERMES_CLOUD_TTS_PROVIDER}.`))).toEqual([]);
  });
});
