import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A linked Hermes box with no on-device engine has a voice; it was not given one.
 *
 * Measured on the Hermes box during the #601 device leg (TASK-699):
 * `step_openclaw_tts` registered `tts.providers.clawbox-local` AND selected it
 * even where Kokoro never installed, so `tts.provider` named an engine that was
 * not there — every spoken reply failed while the Voice panel called the box
 * configured — and ClawBox cloud speech, the owner-decided default and the
 * parity with the OpenClaw edition, was left unwired (`tts.openai.base_url`
 * unset) on a box holding a `claw_` token.
 *
 * The installer half of the fix stops selecting an engine the box does not
 * have. It cannot make the other half of the decision: the cloud voice needs
 * this credential and the link happens after the install. So it is made here,
 * where the token is — and only where nothing an owner chose would be
 * overwritten.
 */

const cliMock = vi.hoisted(() => vi.fn());
const readVoiceMock = vi.hoisted(() => vi.fn());
const selectEngineMock = vi.hoisted(() => vi.fn());
const hasEngineMock = vi.hoisted(() => vi.fn());
const pendingMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/harness/hermes-features", () => ({ hermesAgentDrawsImages: vi.fn(async () => false) }));
vi.mock("@/lib/hermes-image-refresh", () => ({ refreshHermesImageTools: vi.fn() }));
vi.mock("@/lib/coding-agent", () => ({ getCodingAgentStatus: vi.fn(async () => ({ ready: false })) }));
vi.mock("@/lib/coding-agent-mcp-refresh", () => ({ refreshCodingAgentToolsIfReadinessChanged: vi.fn() }));
vi.mock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: vi.fn() }));
vi.mock("@/lib/config-store", () => ({ setMany: vi.fn() }));
vi.mock("@/lib/hermes-env", () => ({ setHermesEnvValues: vi.fn() }));
vi.mock("@/lib/hermes-image-plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-image-plugin")>()),
  installHermesImagePlugin: vi.fn(),
}));
// The two seams this suite is about. `hermes-tts` keeps its real constants —
// the provider NAMES are the contract with install.sh and a stubbed copy of
// them would pass whatever the module said.
vi.mock("@/lib/hermes-tts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-tts")>()),
  readHermesVoice: readVoiceMock,
  selectHermesEngine: selectEngineMock,
  hermesVoiceProbePending: pendingMock,
}));
vi.mock("@/lib/local-tts-engine", () => ({ hasLocalTtsEngine: hasEngineMock }));

import { applyClawaiToHermes } from "@/lib/hermes-clawai";
import {
  HERMES_LOCAL_TTS_PROVIDER,
  HERMES_FACTORY_TTS_PROVIDER,
  CLAWBOX_AI_SPEECH_TIER,
} from "@/lib/hermes-tts";

const TOKEN = "claw_test_token";
/**
 * The device tier the proxy serves speech to. Read from the module rather than
 * typed here: the OpenClaw edition gates on the same value, and a copy would be
 * the drift the constant exists to prevent.
 */
const ENTITLED = CLAWBOX_AI_SPEECH_TIER as "pro";

/** What `readHermesVoice()` answers; only `provider` decides anything here. */
function voice(provider: string | null) {
  return {
    provider,
    localRegistered: true,
    localCommand: "/home/clawbox/clawbox/scripts/openclaw/clawbox-tts.sh",
    cloudVoice: null,
    cloudModel: null,
    cloudBaseUrl: null,
    cloudHasKey: false,
  };
}

describe("pointing a linked Hermes box at a voice it can actually use", () => {
  beforeEach(() => {
    cliMock.mockReset();
    readVoiceMock.mockReset();
    selectEngineMock.mockReset();
    hasEngineMock.mockReset();
    cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    selectEngineMock.mockResolvedValue(undefined);
    hasEngineMock.mockResolvedValue(false);
    pendingMock.mockReturnValue(false);
  });

  it("selects the cloud voice when nothing has been chosen and there is no engine", async () => {
    readVoiceMock.mockResolvedValue(voice(null));

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectEngineMock).toHaveBeenCalledWith("cloud", TOKEN);
  });

  it("replaces Hermes' factory cloud rather than speaking through Microsoft", async () => {
    // `edge` is Hermes' own default and a third cloud the customer never
    // chose; hermes-tts.ts treats it as factory-unset for exactly this reason.
    readVoiceMock.mockResolvedValue(voice(HERMES_FACTORY_TTS_PROVIDER));

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectEngineMock).toHaveBeenCalledWith("cloud", TOKEN);
  });

  it("replaces an on-device selection that has no engine behind it", async () => {
    // The state the box was measured in: selected, and mute.
    readVoiceMock.mockResolvedValue(voice(HERMES_LOCAL_TTS_PROVIDER));
    hasEngineMock.mockResolvedValue(false);

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectEngineMock).toHaveBeenCalledWith("cloud", TOKEN);
  });

  it("leaves the on-device voice alone when the box really can speak for itself", async () => {
    // Linking a box is not a reason to move an owner off the on-device engine
    // — that engine is the product's whole claim.
    readVoiceMock.mockResolvedValue(voice(HERMES_LOCAL_TTS_PROVIDER));
    hasEngineMock.mockResolvedValue(true);

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectEngineMock).not.toHaveBeenCalled();
  });

  it("does not point an unentitled box at a route it may not call", async () => {
    // Cloud speech is served only to the device tier the proxy answers; below
    // it every utterance is a 403. The Voice route refuses the pick on such a
    // box and gateway-pre-start.sh refuses to write it on the OpenClaw side —
    // "the panel would call the cloud voice configured … and every spoken reply
    // would pay a failed round trip". Honestly mute beats aimed at a 403, and
    // nothing would move it back: install.sh then sees `openai` and preserves
    // it as an owner's choice.
    readVoiceMock.mockResolvedValue(voice(null));

    await applyClawaiToHermes(TOKEN, "flash");

    expect(selectEngineMock).not.toHaveBeenCalled();
  });

  it("leaves the selection alone when the read did not get an answer", async () => {
    // `readHermesVoice` answers null for BOTH "unset" and "the hermes config
    // get never completed" — its own docstring says so. One OOM-killed Python
    // start on a loaded Jetson during a re-link would otherwise replace an
    // owner's ElevenLabs with the cloud, silently. The shell half of this same
    // change refuses to make that mistake at length; this is the seam the
    // module already provides for asking which of the two it holds.
    readVoiceMock.mockResolvedValue(voice(null));
    pendingMock.mockReturnValue(true);

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectEngineMock).not.toHaveBeenCalled();
  });

  it("leaves an owner's own provider alone", async () => {
    readVoiceMock.mockResolvedValue(voice("elevenlabs"));

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectEngineMock).not.toHaveBeenCalled();
  });

  it("does not fail the link when the voice cannot be pointed", async () => {
    // A link that worked must not report failure because the voice write did
    // not — the Voice panel is still there to set it by hand.
    readVoiceMock.mockResolvedValue(voice(null));
    selectEngineMock.mockRejectedValue(new Error("hermes: timed out"));

    await expect(applyClawaiToHermes(TOKEN, ENTITLED)).resolves.toBeDefined();
  });

  it("does not ask the box to speak with a credential it was not given", async () => {
    // The token that reaches `selectHermesEngine` is the one just linked, not
    // a stale read: a cloud voice authenticated with the wrong key 401s on
    // every utterance under a panel that says it is configured.
    readVoiceMock.mockResolvedValue(voice(null));

    await applyClawaiToHermes(TOKEN, ENTITLED);

    const [, token] = selectEngineMock.mock.calls[0] ?? [];
    expect(token).toBe(TOKEN);
  });
});
