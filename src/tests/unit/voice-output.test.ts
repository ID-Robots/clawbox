import { describe, expect, it } from "vitest";
import {
  buildVoiceDisclosure,
  buildVoiceOutputStatus,
  cloudCredentialIsUnusable,
  cloudProviderIdFor,
  configuredTtsProviderId,
  DEFAULT_VOICE_STATE,
  engineForProviderId,
  isVoiceChoice,
  LOCAL_TTS_PROVIDER_ID,
  localCommandPath,
  providerIdForChoice,
  resolvePreferredEngine,
  selectionError,
  type LocalVoiceProbe,
  type VoiceConfigView,
  type VoiceEngine,
  type VoiceOutputState,
} from "@/lib/voice-output";

/**
 * TASK-434 — the voice selector's rules.
 *
 * Every assertion here is a fact read off a real box on 2026-08-22, not a
 * preference: a ClawBox carries a `claw_` portal token in `models.providers.
 * openai`, and a speech call with it comes back 401 because ClawBox AI has no
 * speech endpoint to point it at. So "present in the config" must not resolve
 * to "the box can speak with it" — that is the whole difference between this
 * selector and a list of options.
 */

const config = (over: Record<string, unknown> = {}) => ({
  messages: {
    tts: {
      provider: LOCAL_TTS_PROVIDER_ID,
      providers: {
        [LOCAL_TTS_PROVIDER_ID]: { command: "/home/clawbox/clawbox/scripts/openclaw/clawbox-tts.sh" },
      },
    },
  },
  models: { providers: { openai: { apiKey: "claw_example_not_a_real_token" } } },
  ...over,
}) as unknown as VoiceConfigView;

const healthyLocal: LocalVoiceProbe = {
  providerConfigured: true,
  commandPresent: true,
  engineInstalled: true,
  engineNames: ["Piper"],
};

const state = (over: Partial<VoiceOutputState> = {}): VoiceOutputState => ({
  ...DEFAULT_VOICE_STATE,
  ...over,
});

const engine = (over: Partial<VoiceEngine> & Pick<VoiceEngine, "id">): VoiceEngine => ({
  providerId: over.id === "local" ? LOCAL_TTS_PROVIDER_ID : "openai",
  label: over.id === "local" ? "On this box" : "ClawBox cloud",
  configured: true,
  detail: "",
  ...over,
});

describe("engine identity", () => {
  it("calls the shipped local provider local, and an unknown provider cloud", () => {
    expect(engineForProviderId(LOCAL_TTS_PROVIDER_ID)).toBe("local");
    expect(engineForProviderId("kokoro-server")).toBe("local");
    expect(engineForProviderId("openai")).toBe("cloud");
    expect(engineForProviderId("elevenlabs")).toBe("cloud");
    expect(engineForProviderId(null)).toBeNull();
  });

  it("reads the configured primary and the local command straight from the config", () => {
    expect(configuredTtsProviderId(config())).toBe(LOCAL_TTS_PROVIDER_ID);
    expect(localCommandPath(config())).toContain("clawbox-tts.sh");
    expect(configuredTtsProviderId({} as VoiceConfigView)).toBeNull();
  });

  it("prefers an explicitly configured cloud speech provider over the shipped default", () => {
    expect(cloudProviderIdFor(config())).toBe("openai");
    const custom = config({
      messages: {
        tts: {
          provider: LOCAL_TTS_PROVIDER_ID,
          providers: {
            [LOCAL_TTS_PROVIDER_ID]: { command: "/x/clawbox-tts.sh" },
            elevenlabs: { apiKey: "el-key", baseUrl: "https://api.elevenlabs.io" },
          },
        },
      },
    });
    expect(cloudProviderIdFor(custom)).toBe("elevenlabs");
  });

  it("reports no cloud engine at all when nothing is configured for one", () => {
    expect(cloudProviderIdFor({ models: { providers: {} } } as VoiceConfigView)).toBeNull();
  });
});

describe("a portal token is not a cloud voice key", () => {
  it("rejects a claw_ token with no endpoint to send it to", () => {
    expect(cloudCredentialIsUnusable(config(), "openai")).toBe(true);
  });

  it("accepts the same token once a speech endpoint is configured for it", () => {
    const withEndpoint = config({
      models: { providers: { openai: { apiKey: "claw_example_not_a_real_token", baseUrl: "https://clawbox.com/api/ai" } } },
    });
    expect(cloudCredentialIsUnusable(withEndpoint, "openai")).toBe(false);
  });

  it("accepts a real provider key", () => {
    const real = config({ models: { providers: { openai: { apiKey: "sk-live-abc" } } } });
    expect(cloudCredentialIsUnusable(real, "openai")).toBe(false);
  });
});

describe("status", () => {
  it("shows the cloud voice as unavailable on a stock box, with a reason a customer can act on", () => {
    const status = buildVoiceOutputStatus(config(), healthyLocal, state());
    const cloud = status.engines.find(e => e.id === "cloud")!;
    expect(cloud.configured).toBe(false);
    // The old copy said ClawBox AI "does not serve the voice yet". It does, on
    // Max, since 2026-08-22 — so what a box landing here has to be told is that
    // ITS key does not open one, not that the product has none (TASK-490).
    expect(cloud.detail).toContain("comes with ClawBox AI Max");
    expect(cloud.detail).not.toContain("does not serve the voice yet");
    expect(cloud.detail).not.toContain("claw_");
  });

  it("does not promise an on-device voice to a box that has none", () => {
    // This branch is reached from the CLOUD credential alone and knows nothing
    // about the local engine. A box with no installed voice reaches it too, and
    // telling that customer the box "speaks with its own voice" would be the
    // same class of confident wrong sentence the old copy was.
    const bare: LocalVoiceProbe = {
      providerConfigured: false,
      commandPresent: false,
      engineInstalled: false,
      engineNames: [],
    };
    const status = buildVoiceOutputStatus(config(), bare, state());
    const cloud = status.engines.find(e => e.id === "cloud")!;
    const local = status.engines.find(e => e.id === "local")!;

    expect(local.configured).toBe(false);
    expect(status.preferredEngine).toBe(null);
    expect(cloud.detail).not.toMatch(/own voice|speaks on the box|this box speaks/i);
  });

  it("resolves Auto to the on-device voice when the cloud one cannot be used", () => {
    const status = buildVoiceOutputStatus(config(), healthyLocal, state());
    expect(status.choice).toBe("auto");
    expect(status.preferredEngine).toBe("local");
    expect(status.drifted).toBe(false);
  });

  it("resolves Auto to the cloud voice when the box really has one", () => {
    const real = config({ models: { providers: { openai: { apiKey: "sk-live-abc" } } } });
    const status = buildVoiceOutputStatus(real, healthyLocal, state());
    expect(status.preferredEngine).toBe("cloud");
    // The box is still configured for the local voice, so Auto has somewhere to move.
    expect(status.drifted).toBe(true);
  });

  it("marks the local voice unavailable when no on-device engine is installed", () => {
    const status = buildVoiceOutputStatus(config(), { ...healthyLocal, engineInstalled: false }, state());
    const local = status.engines.find(e => e.id === "local")!;
    expect(local.configured).toBe(false);
    expect(local.detail).toContain("cannot speak by itself");
    expect(status.preferredEngine).toBeNull();
  });

  it("shows English until the owner picks a sample language, and their pick afterwards", () => {
    expect(buildVoiceOutputStatus(config(), healthyLocal, state()).language).toBe("en");
    expect(buildVoiceOutputStatus(config(), healthyLocal, state({ language: "de" })).language).toBe("de");
  });
});

describe("choice resolution", () => {
  const both = [engine({ id: "local" }), engine({ id: "cloud" })];

  it("honours an explicit pick", () => {
    expect(resolvePreferredEngine("local", both)).toBe("local");
    expect(resolvePreferredEngine("cloud", both)).toBe("cloud");
  });

  it("follows the standing cloud-first recommendation for Auto", () => {
    expect(resolvePreferredEngine("auto", both)).toBe("cloud");
  });

  it("steps aside rather than pinning an engine the box does not have", () => {
    const noCloud = [engine({ id: "local" }), engine({ id: "cloud", configured: false })];
    expect(resolvePreferredEngine("auto", noCloud)).toBe("local");
    expect(resolvePreferredEngine("cloud", noCloud)).toBe("local");
  });

  it("resolves to nothing when neither engine can speak", () => {
    const none = [
      engine({ id: "local", configured: false }),
      engine({ id: "cloud", configured: false }),
    ];
    expect(resolvePreferredEngine("auto", none)).toBeNull();
    expect(providerIdForChoice("local", none)).toBeNull();
  });

  it("maps a choice to the provider id that gets written", () => {
    expect(providerIdForChoice("local", both)).toBe(LOCAL_TTS_PROVIDER_ID);
    expect(providerIdForChoice("cloud", both)).toBe("openai");
  });

  it("accepts only the three real choices", () => {
    expect(isVoiceChoice("auto")).toBe(true);
    expect(isVoiceChoice("cheapest")).toBe(false);
    expect(isVoiceChoice(null)).toBe(false);
  });
});

describe("the privacy notice is the chat one, not a second one", () => {
  it("warns plainly when the cloud voice is the primary", () => {
    const engines = [engine({ id: "local" }), engine({ id: "cloud" })];
    expect(buildVoiceDisclosure("openai", engines)).toContain("Voice uses ClawBox AI cloud TTS");
  });

  it("warns conditionally when the cloud voice is only the fallback", () => {
    const engines = [engine({ id: "local" }), engine({ id: "cloud" })];
    const notice = buildVoiceDisclosure(LOCAL_TTS_PROVIDER_ID, engines);
    expect(notice).toContain("may use ClawBox AI cloud TTS");
  });

  it("says nothing when the box has no cloud voice at all", () => {
    const engines = [engine({ id: "local" }), engine({ id: "cloud", configured: false })];
    expect(buildVoiceDisclosure(LOCAL_TTS_PROVIDER_ID, engines)).toBeNull();
  });

  it("hands the Voice tab the same fact unworded, so it can be said in the owner's language", () => {
    const real = config({
      messages: { tts: { provider: LOCAL_TTS_PROVIDER_ID, providers: { [LOCAL_TTS_PROVIDER_ID]: { command: "/x/clawbox-tts.sh" } } } },
      models: { providers: { openai: { apiKey: "sk-live-abc" } } },
    });
    const status = buildVoiceOutputStatus(real, healthyLocal, state({ choice: "local" }));
    expect(status.disclosure).toEqual({ kind: "may-use-cloud", providers: ["ClawBox AI"], primaryIsLocal: true });
    expect(status.warning).toContain("may use ClawBox AI cloud TTS");
    // And no cloud voice means no fact to disclose, in either shape.
    const stock = buildVoiceOutputStatus(config(), healthyLocal, state());
    expect(stock.disclosure).toBeNull();
    expect(stock.warning).toBeNull();
  });
});

describe("refusing an explicit pick", () => {
  const both = [engine({ id: "local" }), engine({ id: "cloud" })];

  it("allows either engine when both work", () => {
    expect(selectionError("local", both)).toBeNull();
    expect(selectionError("cloud", both)).toBeNull();
    expect(selectionError("auto", both)).toBeNull();
  });

  it("refuses a named engine the box does not have instead of substituting the other", () => {
    const noCloud = [engine({ id: "local" }), engine({ id: "cloud", configured: false })];
    expect(selectionError("cloud", noCloud)).toContain("not available");
    // Auto is still fine — resolving to whatever works is what Auto means.
    expect(selectionError("auto", noCloud)).toBeNull();
  });

  it("refuses Auto only when the box has no voice at all", () => {
    const none = [
      engine({ id: "local", configured: false }),
      engine({ id: "cloud", configured: false }),
    ];
    expect(selectionError("auto", none)).toContain("no voice");
  });

  it("still refuses an engine the box genuinely does not have", () => {
    // A stock ClawBox: the portal token is not a cloud voice key, so there is
    // nothing to pick and the refusal stands.
    const engines = buildVoiceOutputStatus(config(), healthyLocal, state()).engines;
    expect(selectionError("cloud", engines)).toContain("not available");
    expect(providerIdForChoice("cloud", engines)).toBeNull();
  });
});
