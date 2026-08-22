import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { buildCloudTtsWarning } from "@/lib/tts-cloud-warning";
import { isLocalProviderId, LOCAL_TTS_PROVIDER_ID } from "@/lib/voice-output";

/**
 * Two contracts the Voice panel cannot be allowed to break silently.
 *
 * 1. The provider id it writes must be the one install.sh selects. If the
 *    installer ever renames it, "On this box" would write a primary no plugin
 *    answers and the box would go mute with a green-looking setting — asserted
 *    against the SHIPPED script, not a copy of its value.
 *
 * 2. It must agree with the chat privacy banner (TASK-409) about what counts as
 *    a local engine. They are two surfaces describing the same fact, and the
 *    one way to make a privacy notice actively harmful is to have the settings
 *    page call an engine on-device while the banner does not.
 */

const INSTALLER = new URL("../../../install.sh", import.meta.url);

describe("the voice selector agrees with the installer", () => {
  it("writes the provider id install.sh selects", async () => {
    const script = await fs.readFile(INSTALLER, "utf8");
    expect(script).toContain(`oc_config_set messages.tts.provider "${LOCAL_TTS_PROVIDER_ID}"`);
  });

  it("reads the provider entry install.sh writes", async () => {
    const script = await fs.readFile(INSTALLER, "utf8");
    expect(script).toContain(`oc_config_set messages.tts.providers.${LOCAL_TTS_PROVIDER_ID}`);
  });
});

describe("the voice selector agrees with the chat privacy banner", () => {
  const ids = [
    "tts-local-cli",
    "kokoro",
    "kokoro-server",
    "piper",
    "local-tts",
    "openai",
    "elevenlabs",
    "azure",
    "google-cloud-tts",
  ];

  it.each(ids)("classifies %s the same way the banner does", (id) => {
    // The banner has no exported predicate, so ask it the only question it
    // answers: an engine it considers local produces no cloud warning when it
    // is the sole configured provider.
    const warning = buildCloudTtsWarning({
      enabled: true,
      provider: id,
      fallbackProviders: [],
      providerStates: [{ id, label: id, configured: true }],
    });
    const bannerSaysLocal = warning === null;
    expect(isLocalProviderId(id)).toBe(bannerSaysLocal);
  });
});
