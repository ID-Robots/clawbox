import { describe, expect, it } from "vitest";
import {
  applyCheck,
  buildVoiceDisclosure,
  buildVoiceOutputStatus,
  cloudCredentialIsUnusable,
  cloudProviderIdFor,
  configuredTtsProviderId,
  DEFAULT_VOICE_STATE,
  engineForProviderId,
  failedVoiceCheck,
  isVoiceChoice,
  LOCAL_TTS_PROVIDER_ID,
  localCommandPath,
  parseVoiceCheck,
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
  models: { providers: { openai: { apiKey: "claw_84d065b" } } },
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
  engineChecks: {},
  ...over,
});

const engine = (over: Partial<VoiceEngine> & Pick<VoiceEngine, "id">): VoiceEngine => ({
  providerId: over.id === "local" ? LOCAL_TTS_PROVIDER_ID : "openai",
  label: over.id === "local" ? "On this box" : "ClawBox cloud",
  configured: true,
  proven: false,
  usable: true,
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
      models: { providers: { openai: { apiKey: "claw_84d065b", baseUrl: "https://clawbox.com/api/ai" } } },
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
    expect(cloud.usable).toBe(false);
    expect(cloud.detail).toContain("does not serve the voice yet");
    expect(cloud.detail).not.toContain("claw_");
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

  it("marks the local voice unusable when no on-device engine is installed", () => {
    const status = buildVoiceOutputStatus(config(), { ...healthyLocal, engineInstalled: false }, state());
    const local = status.engines.find(e => e.id === "local")!;
    expect(local.usable).toBe(false);
    expect(local.detail).toContain("cannot speak by itself");
    expect(status.preferredEngine).toBeNull();
  });

  it("marks an engine unusable after a real check through it failed, and says so", () => {
    const failed = state({
      engineChecks: {
        local: { providerId: LOCAL_TTS_PROVIDER_ID, engine: "local", ok: false, message: "no voice model", latencyMs: 12, at: 5 },
      },
    });
    const local = buildVoiceOutputStatus(config(), healthyLocal, failed).engines.find(e => e.id === "local")!;
    expect(local.usable).toBe(false);
    expect(local.detail).toContain("no voice model");
  });

  it("marks an engine proven once a real check through it succeeded", () => {
    const proven = state({
      engineChecks: {
        local: { providerId: LOCAL_TTS_PROVIDER_ID, engine: "local", ok: true, message: null, latencyMs: 900, at: 5 },
      },
    });
    const local = buildVoiceOutputStatus(config(), healthyLocal, proven).engines.find(e => e.id === "local")!;
    expect(local.proven).toBe(true);
    expect(local.usable).toBe(true);
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

  it("steps aside rather than pinning an engine the box cannot use", () => {
    const noCloud = [engine({ id: "local" }), engine({ id: "cloud", usable: false })];
    expect(resolvePreferredEngine("auto", noCloud)).toBe("local");
    expect(resolvePreferredEngine("cloud", noCloud)).toBe("local");
  });

  it("resolves to nothing when neither engine can speak", () => {
    const none = [engine({ id: "local", usable: false }), engine({ id: "cloud", usable: false })];
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

  it("says nothing when no cloud voice can be reached at all", () => {
    const engines = [engine({ id: "local" }), engine({ id: "cloud", usable: false })];
    expect(buildVoiceDisclosure(LOCAL_TTS_PROVIDER_ID, engines)).toBeNull();
  });
});

describe("reading a real check", () => {
  it("records which provider actually spoke", () => {
    const check = parseVoiceCheck({
      ok: true,
      provider: LOCAL_TTS_PROVIDER_ID,
      attempts: [{ provider: LOCAL_TTS_PROVIDER_ID, outcome: "success", reasonCode: "success", latencyMs: 14893 }],
    }, 100);
    expect(check.ok).toBe(true);
    expect(check.servedEngine).toBe("local");
    expect(check.attempts[0].latencyMs).toBe(14893);
  });

  it("keeps the failed cloud attempt AND the local one that spoke after it", () => {
    const check = parseVoiceCheck({
      ok: true,
      provider: LOCAL_TTS_PROVIDER_ID,
      attempts: [
        { provider: "openai", outcome: "error", error: "OpenAI TTS API error (401)" },
        { provider: LOCAL_TTS_PROVIDER_ID, outcome: "success", latencyMs: 1200 },
      ],
    }, 100);
    expect(check.ok).toBe(true);
    expect(check.servedEngine).toBe("local");
    expect(check.attempts.map(a => a.engine)).toEqual(["cloud", "local"]);
    expect(check.attempts[0].ok).toBe(false);
  });

  it("never lets a credential out of a provider's error text", () => {
    const check = parseVoiceCheck({
      ok: false,
      attempts: [{
        provider: "openai",
        outcome: "error",
        error: "Incorrect API key provided: claw_84d065b0000000000000000000063c.",
      }],
    }, 100);
    expect(check.ok).toBe(false);
    expect(check.attempts[0].message).toBeNull();
    expect(JSON.stringify(check)).not.toContain("claw_");
  });

  it("is not a success just because the CLI exited ok with nothing spoken", () => {
    expect(parseVoiceCheck({ ok: true, attempts: [] }, 100).ok).toBe(false);
    expect(parseVoiceCheck("not json at all", 100).ok).toBe(false);
  });

  it("records a run that never reached a provider", () => {
    const check = failedVoiceCheck("The voice check took too long and was stopped.", 7);
    expect(check.ok).toBe(false);
    expect(check.message).toContain("took too long");
    expect(check.attempts).toEqual([]);
  });

  it("folds every attempt into the per-engine memory the panel reads", () => {
    const check = parseVoiceCheck({
      ok: true,
      attempts: [
        { provider: "openai", outcome: "error", error: "rejected" },
        { provider: LOCAL_TTS_PROVIDER_ID, outcome: "success", latencyMs: 900 },
      ],
    }, 42);
    const next = applyCheck(state(), check);
    expect(next.engineChecks.cloud?.ok).toBe(false);
    expect(next.engineChecks.local?.ok).toBe(true);
    expect(next.engineChecks.local?.at).toBe(42);
    expect(next.lastCheck).toBe(check);
  });
});

describe("refusing an explicit pick", () => {
  const both = [engine({ id: "local" }), engine({ id: "cloud" })];

  it("allows either engine when both work", () => {
    expect(selectionError("local", both)).toBeNull();
    expect(selectionError("cloud", both)).toBeNull();
    expect(selectionError("auto", both)).toBeNull();
  });

  it("refuses a named engine the box cannot use instead of substituting the other", () => {
    const noCloud = [engine({ id: "local" }), engine({ id: "cloud", usable: false })];
    expect(selectionError("cloud", noCloud)).toContain("not available");
    // Auto is still fine — resolving to whatever works is what Auto means.
    expect(selectionError("auto", noCloud)).toBeNull();
  });

  it("refuses Auto only when the box has no voice at all", () => {
    const none = [engine({ id: "local", usable: false }), engine({ id: "cloud", usable: false })];
    expect(selectionError("auto", none)).toContain("no voice");
  });

  it("still reports what will actually speak after a pick that later broke", () => {
    // Chosen cloud, cloud failed, so the gateway falls back — the panel must
    // say "On this box" rather than keep claiming the cloud voice.
    const broken = [engine({ id: "local" }), engine({ id: "cloud", usable: false })];
    expect(resolvePreferredEngine("cloud", broken)).toBe("local");
  });
});
