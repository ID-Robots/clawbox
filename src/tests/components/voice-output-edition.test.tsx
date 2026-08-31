import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render as renderBare, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import VoiceOutputPanel from "@/components/VoiceOutputPanel";

/**
 * Settings → Voice was a dead end on the Hermes edition.
 *
 * Every write behind the panel runs the openclaw CLI (`config set
 * messages.tts.provider` for Select) and the Hermes SKU ships no openclaw
 * binary. The panel rendered anyway, offering a Select the route answered
 * with 409.
 *
 * The box now says the true thing once, and the panel repeats it, the same way
 * ClawKeep already handles a feature that is not part of this edition.
 */

// The panel's copy comes through the i18n provider, like every Settings panel.
const render = (ui: React.ReactElement) => renderBare(<I18nProvider>{ui}</I18nProvider>);

const OPENCLAW_STATUS = {
  // The source dropdown reads `choice` and nothing else: "local" is the box
  // itself, anything else shows as the cloud. A box with only its own engine.
  choice: "local",
  engines: [
    {
      id: "local",
      label: "On this box",
      detail: "Kokoro",
      providerId: "tts-local-cli",
      configured: true,
    },
  ],
  activeProviderId: "piper",
  activeEngine: "local",
  preferredEngine: "local",
  drifted: false,
  warning: null,
  language: "en",
  // The voice each engine speaks with. The LISTS to pick from are not part of
  // the payload — the panel carries its own catalogue (@/lib/voice-catalog).
  voice: { local: "af_heart", cloud: "alloy" },
};

function installFetch(payload: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => payload })));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Settings → Voice on an edition without OpenClaw", () => {
  it("says the feature is absent instead of pulsing a skeleton forever", async () => {
    installFetch({
      supportedOnEdition: false,
      error: "Voice output is an OpenClaw feature and is not part of this edition.",
    });

    render(<VoiceOutputPanel active />);

    await screen.findByTestId("voice-output-unsupported");
    expect(await screen.findByText(/Not available on this edition/)).toBeInTheDocument();
    // The three grey cards are what a customer saw while the panel waited for a
    // status the box was never going to produce.
    expect(screen.queryByTestId("voice-output-loading")).toBeNull();
  });

  it("offers no choice to make", async () => {
    installFetch({ supportedOnEdition: false });

    render(<VoiceOutputPanel active />);
    await screen.findByTestId("voice-output-unsupported");

    // A button that can only 409 is worse than no button: it reads as something
    // the customer did wrong.
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("Settings → Voice on the OpenClaw edition", () => {
  it("is unchanged — the real panel still renders", async () => {
    installFetch(OPENCLAW_STATUS);

    render(<VoiceOutputPanel active />);

    await waitFor(() => expect(screen.queryByTestId("voice-output-loading")).toBeNull());
    expect(screen.queryByTestId("voice-output-unsupported")).toBeNull();
    // The dropdowns show what the payload said: the source from `choice`, the
    // voice from `voice[source]`. The cloud row is offered but greyed — no
    // cloud engine was reported — rather than hidden.
    expect(screen.getByTestId("voice-panel")).toBeInTheDocument();
    expect(screen.getByTestId("voice-source")).toHaveValue("local");
    expect(screen.getByTestId("voice-voice")).toHaveValue("af_heart");
    const cloud = await screen.findByRole("option", { name: /ClawBox cloud/ }) as HTMLOptionElement;
    expect(cloud.disabled).toBe(true);
  });
});
