/**
 * The rule behind the owner's decision of 2026-09-14: TTS, STT and embeddings
 * default to the ClawBox AI subscription cloud on a box that has one, local
 * otherwise.
 *
 * Pinned here rather than only through a route, because three different
 * surfaces derive from this one function — the applier, the status route and
 * the Local AI card — and the three rules are deliberately NOT the same. Each
 * one has a cost attached to getting it wrong, named in the cases below.
 */
import { describe, expect, it } from "vitest";
import {
  CLOUD_TTS_ENTITLED_TIER,
  ownerChoiceFrom,
  resolveClawaiCloudDefaults,
  type CloudDefaultsFacts,
} from "@/lib/clawai-cloud-defaults-state";

function facts(over: Partial<CloudDefaultsFacts> = {}): CloudDefaultsFacts {
  return {
    linked: true,
    entitlement: "pro",
    embeddingsRouteReady: true,
    embeddingsSupported: true,
    ...over,
  };
}

describe("resolveClawaiCloudDefaults", () => {
  it("leaves an unlinked box entirely on its own engines", () => {
    const verdict = resolveClawaiCloudDefaults(facts({ linked: false }));
    for (const capability of ["tts", "stt", "embeddings"] as const) {
      expect(verdict[capability]).toEqual({ source: "local", reason: "not_linked" });
    }
  });

  it("transcribes in the cloud on every connected box, unpaid plan included", () => {
    // The proxy's transcription route has no tier gate, and `stt_primary` has
    // shipped defaulting to cloud since the feature existed.
    for (const entitlement of ["free", "flash", "pro", null] as const) {
      expect(resolveClawaiCloudDefaults(facts({ entitlement })).stt).toEqual({ source: "cloud", reason: null });
    }
  });

  it("speaks in the cloud only on the entitled tier", () => {
    // The proxy answers 403 to the others, so an unentitled pick would pay a
    // failed round trip before every spoken reply falls back to the box.
    expect(resolveClawaiCloudDefaults(facts({ entitlement: CLOUD_TTS_ENTITLED_TIER })).tts.source).toBe("cloud");
    for (const entitlement of ["free", "flash"] as const) {
      expect(resolveClawaiCloudDefaults(facts({ entitlement })).tts).toEqual({ source: "local", reason: "plan" });
    }
  });

  it("does not speak in the cloud on an entitlement nobody has told us", () => {
    expect(resolveClawaiCloudDefaults(facts({ entitlement: null })).tts).toEqual({ source: "local", reason: "plan" });
  });

  it("embeds in the cloud on a paid plan, once the route has answered", () => {
    for (const entitlement of ["flash", "pro"] as const) {
      expect(resolveClawaiCloudDefaults(facts({ entitlement })).embeddings).toEqual({ source: "cloud", reason: null });
    }
  });

  it("keeps the index on the box while the proxy route has not shipped", () => {
    // Until the website ships POST /api/ai/embeddings the probe answers false,
    // and a box pointed at a 404 would report a healthy index that finds
    // nothing.
    expect(resolveClawaiCloudDefaults(facts({ embeddingsRouteReady: false })).embeddings)
      .toEqual({ source: "local", reason: "route_unavailable" });
  });

  it("keeps the index on the box on an unpaid plan, and on an unknown one", () => {
    // Unknown is LOCAL here and not cloud: moving the index invalidates its
    // fingerprint and costs a full reindex, which is not spent on a guess.
    for (const entitlement of ["free", null] as const) {
      expect(resolveClawaiCloudDefaults(facts({ entitlement })).embeddings)
        .toEqual({ source: "local", reason: "plan" });
    }
  });

  it("never moves the index off the edition that indexes on the box", () => {
    // memory-index-local.ts refuses an embedder endpoint that is not loopback,
    // deliberately — the owner's document text is the request body there.
    expect(resolveClawaiCloudDefaults(facts({ embeddingsSupported: false })).embeddings)
      .toEqual({ source: "local", reason: "edition" });
  });

  it("does not let a paid plan speak in the cloud, nor a Max plan skip the probe", () => {
    // The two gates are separate on purpose; neither stands in for the other.
    const flash = resolveClawaiCloudDefaults(facts({ entitlement: "flash" }));
    expect(flash.tts.source).toBe("local");
    expect(flash.embeddings.source).toBe("cloud");
    const noRoute = resolveClawaiCloudDefaults(facts({ entitlement: "pro", embeddingsRouteReady: false }));
    expect(noRoute.tts.source).toBe("cloud");
    expect(noRoute.embeddings.source).toBe("local");
  });
});

describe("ownerChoiceFrom", () => {
  it("takes the recorded word over anything else", () => {
    expect(ownerChoiceFrom("owner", false)).toBe(true);
    // "auto" is the owner handing the capability BACK, which a stored local
    // engine must not read as a pin all over again.
    expect(ownerChoiceFrom("auto", true)).toBe(false);
  });

  it("reads a box that predates the key by what only a person could have written", () => {
    // Nothing but the owner's own click ever wrote `local` into stt_primary or
    // the voice choice, so an absent key over one is still a decision.
    expect(ownerChoiceFrom(undefined, true)).toBe(true);
    expect(ownerChoiceFrom(undefined, false)).toBe(false);
    expect(ownerChoiceFrom(null, true)).toBe(true);
  });

  it("does not treat a value it does not recognise as a decision either way", () => {
    expect(ownerChoiceFrom("something-else", false)).toBe(false);
    expect(ownerChoiceFrom(7, true)).toBe(true);
  });
});
