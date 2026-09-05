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
const selectProviderMock = vi.hoisted(() => vi.fn());
const probeEngineMock = vi.hoisted(() => vi.fn());
const runnableMock = vi.hoisted(() => vi.fn());
const writeCloudMock = vi.hoisted(() => vi.fn());

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
  selectHermesProvider: selectProviderMock,
  writeHermesCloudTarget: writeCloudMock,
}));
vi.mock("@/lib/local-models", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/local-models")>()),
  probeLocalTtsEngine: probeEngineMock,
  localTtsCommandRunnable: runnableMock,
}));
// Every case here reaches `applyClawaiToHermes`, which resolves the vision
// model before it ever gets to the voice — and that resolver PROBES the
// ClawBox AI proxy. Unmocked, 24 unit tests each do network I/O whose failure
// mode is a delay. Stubbed to "unset", the state that writes no vision keys
// at all and leaves this suite about the voice.
vi.mock("@/lib/clawbox-ai-vision", () => ({
  resolveVisionModelId: vi.fn(async () => ({ id: null, reason: "unset" })),
  isClawboxAiVisionId: () => false,
}));

import { applyClawaiToHermes, CLAWBOX_AI_PROXY_URL } from "@/lib/hermes-clawai";
import {
  HERMES_LOCAL_TTS_PROVIDER,
  HERMES_FACTORY_TTS_PROVIDER,
  CLAWBOX_AI_SPEECH_TIER,
  HermesTtsWriteError,
} from "@/lib/hermes-tts";

const TOKEN = "claw_test_token";
/**
 * The device tier the proxy serves speech to. Read from the module rather than
 * typed here: the OpenClaw edition gates on the same value, and a copy would be
 * the drift the constant exists to prevent.
 */
const ENTITLED = CLAWBOX_AI_SPEECH_TIER;

/**
 * What `readHermesVoice()` answers; `provider` and `localRegistered` decide.
 *
 * `unread` is every read ANSWERED — the ordinary box. The cases that matter
 * most here override one flag at a time, because `hermes config get` exits the
 * same way for an unset key and for one that never answered.
 */
function voice(provider: string | null) {
  return {
    provider,
    localRegistered: true,
    localCommand: "/home/clawbox/clawbox/scripts/openclaw/clawbox-tts.sh",
    cloudVoice: null,
    cloudModel: null,
    cloudBaseUrl: null,
    cloudHasKey: false,
    unread: { provider: false, cloudRoute: false, localProvider: false },
  };
}

describe("pointing a linked Hermes box at a voice it can actually use", () => {
  beforeEach(() => {
    cliMock.mockReset();
    readVoiceMock.mockReset();
    selectProviderMock.mockReset();
    probeEngineMock.mockReset();
    cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    selectProviderMock.mockResolvedValue(undefined);
    writeCloudMock.mockReset();
    writeCloudMock.mockResolvedValue(undefined);
    probeEngineMock.mockResolvedValue(false);
    runnableMock.mockResolvedValue(true);
  });

  it("selects the cloud voice when nothing has been chosen and there is no engine", async () => {
    readVoiceMock.mockResolvedValue(voice(null));

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectProviderMock).toHaveBeenCalledWith("cloud");
  });

  it("replaces Hermes' factory cloud rather than speaking through Microsoft", async () => {
    // `edge` is Hermes' own default and a third cloud the customer never
    // chose; hermes-tts.ts treats it as factory-unset for exactly this reason.
    readVoiceMock.mockResolvedValue(voice(HERMES_FACTORY_TTS_PROVIDER));

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectProviderMock).toHaveBeenCalledWith("cloud");
  });

  it("replaces an on-device selection that has no engine behind it", async () => {
    // The state the box was measured in: selected, and mute.
    readVoiceMock.mockResolvedValue(voice(HERMES_LOCAL_TTS_PROVIDER));
    probeEngineMock.mockResolvedValue(false);

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectProviderMock).toHaveBeenCalledWith("cloud");
  });

  it("leaves the on-device voice alone when the box really can speak for itself", async () => {
    // Linking a box is not a reason to move an owner off the on-device engine
    // — that engine is the product's whole claim.
    readVoiceMock.mockResolvedValue(voice(HERMES_LOCAL_TTS_PROVIDER));
    probeEngineMock.mockResolvedValue(true);

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectProviderMock).not.toHaveBeenCalled();
  });

  it("selects the on-device engine on a box that has one and never chose", async () => {
    // An UNSET key is not evidence of a missing engine: install.sh leaves it
    // unset when a `hermes config set` hiccups, and a box provisioned before
    // the Hermes arm existed never had one written. Sending such an owner's
    // words off the device would be permanent — the next step_openclaw_tts
    // sees `openai` and preserves it as the owner's choice for good.
    readVoiceMock.mockResolvedValue(voice(null));
    probeEngineMock.mockResolvedValue(true);

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectProviderMock).toHaveBeenCalledWith("local");
  });

  it("does not select the on-device engine that Hermes has no definition for", async () => {
    // The engine is on the box, but `tts.providers.clawbox-local.type` is not
    // `command`, so Hermes would refuse the provider outright. Registering it
    // is install.sh's job; the cloud is the working answer until it has run.
    readVoiceMock.mockResolvedValue({ ...voice(null), localRegistered: false });
    probeEngineMock.mockResolvedValue(true);

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectProviderMock).toHaveBeenCalledWith("cloud");
  });

  it("refreshes the cloud credential on a box already speaking through it", async () => {
    // `writeHermesCloudTarget` is the ONLY writer of `tts.openai.*` on this
    // edition, so returning early over an already-chosen cloud left
    // `tts.openai.api_key` holding the token the portal has just rotated:
    // every utterance 401s while `hermesSpeaksReplies` — which asks only that
    // the two keys are non-empty — calls the voice configured. The OpenClaw
    // sibling rewrites its speech apiKey on every gateway start.
    readVoiceMock.mockResolvedValue(voice("openai"));

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(writeCloudMock).toHaveBeenCalledWith(TOKEN);
    // ...and the SELECTION is still left where the owner's box had it.
    expect(selectProviderMock).not.toHaveBeenCalled();
  });

  it("does not take over a speech route the owner pointed somewhere else", async () => {
    // On Hermes `openai` is the generic OpenAI-compatible slot, not ours: an
    // owner may have aimed it at a self-hosted speech server with their own
    // key, and install.sh preserves `openai` as their choice. Refreshing it
    // would redirect their speech to our proxy with our token while the
    // selection — and every panel — stayed exactly the same. The OpenClaw
    // sibling this refresh is modelled on refuses for the same reason.
    readVoiceMock.mockResolvedValue({
      ...voice("openai"),
      cloudBaseUrl: "https://speech.example.internal/v1",
    });

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(writeCloudMock).not.toHaveBeenCalled();
    expect(selectProviderMock).not.toHaveBeenCalled();
  });

  it("does not take over a speech route whose read never answered", async () => {
    // `hermes config get` exits the same way for an unset key and for one an
    // OOM-killed Python start never answered, and `readHermesVoice` reports
    // both as `cloudBaseUrl: null`. Reading the second as "unset, so ours"
    // hands an owner's own speech server, their key and their model to our
    // proxy on one slow read, with `tts.provider` and every panel unchanged.
    // Fail closed: not refreshing a token costs a 401 the Voice panel fixes.
    readVoiceMock.mockResolvedValue({
      ...voice("openai"),
      unread: { provider: false, cloudRoute: true, localProvider: false },
    });

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(writeCloudMock).not.toHaveBeenCalled();
    expect(selectProviderMock).not.toHaveBeenCalled();
  });

  it("does not move a box off its own voice when the definition could not be read", async () => {
    // The mirror, and the more expensive one: an unread
    // `tts.providers.clawbox-local.type` reads as "this box has no on-device
    // voice", and moving it off is PERMANENT — the next step_openclaw_tts sees
    // `openai`, falls into its "already set" arm and preserves it for good. A
    // box that had never sent a syllable off-device would speak every reply
    // through the proxy after one timed-out read.
    readVoiceMock.mockResolvedValue({
      ...voice(HERMES_LOCAL_TTS_PROVIDER),
      // What an unread definition really looks like: the reads that would have
      // filled these two are the ones that did not answer.
      localRegistered: false,
      localCommand: null,
      unread: { provider: false, cloudRoute: false, localProvider: true },
    });
    probeEngineMock.mockResolvedValue(true);

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectProviderMock).not.toHaveBeenCalled();
  });

  it("does not move a box off its own voice when the engine probe could not answer", async () => {
    // Same end state reached without any Hermes read failing: a wedged user
    // systemd bus makes `systemctl --user is-enabled` answer nothing, which as
    // a plain boolean is "no engine". `probeLocalTtsEngine` says `null` — "I
    // could not ask" — and over a `clawbox-local` selection that is not a
    // reason to send the owner's words off the device.
    readVoiceMock.mockResolvedValue(voice(HERMES_LOCAL_TTS_PROVIDER));
    probeEngineMock.mockResolvedValue(null);

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectProviderMock).not.toHaveBeenCalled();
  });

  it("still reaches the cloud when the engine cannot be asked and nothing was chosen", async () => {
    // The guard above is only for a box already ON its own voice. An unset key
    // is not a selection to protect — to Hermes it IS Microsoft's Edge cloud —
    // so leaving it alone would be the worse outcome of the two.
    readVoiceMock.mockResolvedValue(voice(null));
    probeEngineMock.mockResolvedValue(null);

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectProviderMock).toHaveBeenCalledWith("cloud");
  });

  it("still selects the on-device engine when the cloud credential will not write", async () => {
    // The cloud target is the CLOUD path's definition write; nothing about
    // selecting Kokoro depends on it. Written before the engine question, one
    // failed `hermes config set tts.openai.*` abandoned the whole decision and
    // left a box with a working engine on an unset key — which is Edge.
    readVoiceMock.mockResolvedValue(voice(null));
    probeEngineMock.mockResolvedValue(true);
    writeCloudMock.mockRejectedValue(new HermesTtsWriteError("Could not write tts.openai.base_url."));

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectProviderMock).toHaveBeenCalledWith("local");
  });

  it("does not park our proxy and token in the slot of a box speaking with something else", async () => {
    // An owner on ElevenLabs: the refresh exists for the provider that speaks
    // THROUGH the slot, and three `hermes config set` spawns inside the link
    // for a route this box will never use would also leave the ClawBox proxy
    // and the device credential in Hermes' generic OpenAI slot.
    readVoiceMock.mockResolvedValue(voice("elevenlabs"));

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(writeCloudMock).not.toHaveBeenCalled();
    expect(selectProviderMock).not.toHaveBeenCalled();
  });

  it("writes to the same route it recognises as its own", async () => {
    // `ownRoute` compares `tts.openai.base_url` with `hermes-clawai`'s
    // CLAWBOX_AI_PROXY_URL while `writeHermesCloudTarget` writes the one
    // `harness/credentials` exports. They are the same value only because that
    // module re-exports this one; a copy would silently stop us recognising
    // our own route and re-open the rotated-token hole.
    const { CLAWBOX_AI_PROXY_URL: written } = await import("@/lib/harness/credentials");

    expect(written).toBe(CLAWBOX_AI_PROXY_URL);
  });

  it("does not select a cloud voice it was not allowed to point", async () => {
    // Nothing on-device, and the cloud slot is the owner's. Selecting `openai`
    // here would speak through THEIR endpoint with THEIR key.
    readVoiceMock.mockResolvedValue({
      ...voice(null),
      cloudBaseUrl: "https://speech.example.internal/v1",
    });

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(writeCloudMock).not.toHaveBeenCalled();
    expect(selectProviderMock).not.toHaveBeenCalled();
  });

  it("still refreshes our own route, trailing slash and all", async () => {
    readVoiceMock.mockResolvedValue({ ...voice("openai"), cloudBaseUrl: `${CLAWBOX_AI_PROXY_URL}/` });

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(writeCloudMock).toHaveBeenCalledWith(TOKEN);
  });

  it("does not select an on-device voice whose script cannot be run", async () => {
    // Stamp and unit present, execute bit gone — the state `local-models.ts`
    // documents ("the file can lose the bit long after the config was
    // written"), and the one `hermesSpeaksReplies` and the Voice route both
    // refuse. Selecting it would leave an entitled box permanently mute with
    // the cloud voice it holds a credential for one write away.
    readVoiceMock.mockResolvedValue(voice(null));
    probeEngineMock.mockResolvedValue(true);
    runnableMock.mockResolvedValue(false);

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectProviderMock).toHaveBeenCalledWith("cloud");
  });

  it("writes nothing at all to the voice config on an unentitled box", async () => {
    readVoiceMock.mockResolvedValue(voice("openai"));

    await applyClawaiToHermes(TOKEN, "flash");

    expect(writeCloudMock).not.toHaveBeenCalled();
    expect(selectProviderMock).not.toHaveBeenCalled();
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

    expect(selectProviderMock).not.toHaveBeenCalled();
  });

  it("leaves the selection alone when the read did not get an answer", async () => {
    // `readHermesVoice` answers null for BOTH "unset" and "the hermes config
    // get never completed" — its own docstring says so. One OOM-killed Python
    // start on a loaded Jetson during a re-link would otherwise replace an
    // owner's ElevenLabs with the cloud, silently. The shell half of this same
    // change refuses to make that mistake at length; this is the seam the
    // module already provides for asking which of the two it holds.
    readVoiceMock.mockResolvedValue({ ...voice(null), unread: { provider: true, cloudRoute: false, localProvider: false } });

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectProviderMock).not.toHaveBeenCalled();
    expect(writeCloudMock).not.toHaveBeenCalled();
  });

  it("leaves an owner's own provider alone", async () => {
    readVoiceMock.mockResolvedValue(voice("elevenlabs"));

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(selectProviderMock).not.toHaveBeenCalled();
  });

  it("does not fail the link when the voice cannot be pointed", async () => {
    // A link that worked must not report failure because the voice write did
    // not — the Voice panel is still there to set it by hand.
    readVoiceMock.mockResolvedValue(voice(null));
    selectProviderMock.mockRejectedValue(new Error("hermes: timed out"));

    await expect(applyClawaiToHermes(TOKEN, ENTITLED)).resolves.toBeDefined();
  });

  it("does not ask the box to speak with a credential it was not given", async () => {
    // The token written to `tts.openai.api_key` is the one just linked, not a
    // stale read: a cloud voice authenticated with the wrong key 401s on every
    // utterance under a panel that says it is configured. And ONCE — the
    // selection no longer carries a credential of its own, so it cannot write
    // this block a second time.
    readVoiceMock.mockResolvedValue(voice(null));

    await applyClawaiToHermes(TOKEN, ENTITLED);

    expect(writeCloudMock.mock.calls).toEqual([[TOKEN]]);
  });

  it("does not select a cloud voice whose endpoint write did not land", async () => {
    // The invariant `selectHermesCloudVoiceIfUnvoiced` states in as many words
    // — "a failure there leaves `tts.provider` untouched rather than selecting
    // a provider that cannot answer". `writeHermesCloudTarget` really does
    // throw `HermesTtsWriteError` (its `set` throws on the first non-zero
    // exit), and until this case every test in the suite resolved it, so a
    // change that moved the write after the selection would have stayed green.
    readVoiceMock.mockResolvedValue(voice(null));
    writeCloudMock.mockRejectedValue(new HermesTtsWriteError("Could not write tts.openai.base_url."));

    await expect(applyClawaiToHermes(TOKEN, ENTITLED)).resolves.toBeDefined();

    expect(selectProviderMock).not.toHaveBeenCalled();
  });
});
