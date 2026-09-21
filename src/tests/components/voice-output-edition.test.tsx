import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render as renderBare, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import VoiceOutputPanel from "@/components/VoiceOutputPanel";

/**
 * Settings → Voice on a box that does not run OpenClaw.
 *
 * This suite used to assert the opposite of what it asserts now, and the
 * reason it was wrong is worth keeping: the panel was hidden behind a card
 * reading "Speaking out loud is an OpenClaw feature, and this ClawBox does not
 * run OpenClaw", on the premise that every write behind it ran the openclaw
 * CLI. The premise was about the LOOKUP, not the hardware — Hermes ships its
 * own `tts:` provider block and its own speak endpoint, and the on-device
 * engine is the same `clawbox-tts.sh` either way. So the card told the owner
 * of a perfectly capable box that their box could not speak.
 *
 * What is left of that fact is one note about CHANNELS, which really are the
 * gateway's, and it sits beside working controls instead of replacing them.
 */

// The panel's copy comes through the i18n provider, like every Settings panel.
const render = (ui: React.ReactElement) => renderBare(<I18nProvider>{ui}</I18nProvider>);

/** What a linked Hermes box now answers: a real status, plus the channel fact. */
const HERMES_STATUS = {
  choice: "auto",
  engines: [
    { id: "local", label: "On this box", detail: "Kokoro", providerId: "tts-local-cli", configured: true },
    { id: "cloud", label: "ClawBox cloud", detail: "", providerId: "openai", configured: true },
  ],
  activeProviderId: "openai",
  activeEngine: "cloud",
  preferredEngine: "cloud",
  drifted: false,
  warning: null,
  language: "en",
  voice: { local: "af_heart", cloud: "fable" },
  channels: { supportedOnEdition: false, error: "Spoken replies on channels are an OpenClaw feature." },
};

const OPENCLAW_STATUS = {
  choice: "local",
  engines: [
    { id: "local", label: "On this box", detail: "Kokoro", providerId: "tts-local-cli", configured: true },
  ],
  activeProviderId: "piper",
  activeEngine: "local",
  preferredEngine: "local",
  drifted: false,
  warning: null,
  language: "en",
  voice: { local: "af_heart", cloud: "alloy" },
  channels: { supportedOnEdition: true },
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
  it("renders the panel, not a card saying the box cannot speak", async () => {
    installFetch(HERMES_STATUS);

    render(<VoiceOutputPanel active />);

    await screen.findByTestId("voice-panel");
    // The card this suite used to demand. Its copy is gone from the product.
    expect(screen.queryByTestId("voice-output-unsupported")).toBeNull();
    expect(screen.queryByText(/Not available on this edition/)).toBeNull();
    expect(screen.queryByTestId("voice-output-loading")).toBeNull();
  });

  it("offers all four controls the OpenClaw edition offers", async () => {
    installFetch(HERMES_STATUS);

    render(<VoiceOutputPanel active />);

    // Speak from / Language / Voice / Hear it — the whole panel, on a box the
    // product used to tell "this ClawBox does not run OpenClaw".
    expect(await screen.findByTestId("voice-source")).toBeInTheDocument();
    expect(screen.getByTestId("voice-language")).toBeInTheDocument();
    expect(screen.getByTestId("voice-voice")).toBeInTheDocument();
    expect(screen.getByTestId("voice-sample-text")).toBeInTheDocument();
    expect(screen.getByTestId("voice-play")).toBeEnabled();
  });

  it("says the one thing that really is the gateway's, without disabling anything", async () => {
    installFetch(HERMES_STATUS);

    render(<VoiceOutputPanel active />);

    const note = await screen.findByTestId("voice-channels-unavailable");
    // The note names channels and does NOT claim the box cannot speak.
    expect(note.textContent).toMatch(/channels/i);
    expect(note.textContent).not.toMatch(/does not run OpenClaw/i);
    // Beside the controls, never instead of them.
    expect(screen.getByTestId("voice-panel")).toBeInTheDocument();
    expect(screen.getByTestId("voice-play")).toBeEnabled();
  });
});

describe("Settings → Voice on the OpenClaw edition", () => {
  it("is unchanged — the real panel still renders", async () => {
    installFetch(OPENCLAW_STATUS);

    render(<VoiceOutputPanel active />);

    await waitFor(() => expect(screen.queryByTestId("voice-output-loading")).toBeNull());
    expect(screen.getByTestId("voice-panel")).toBeInTheDocument();
    expect(screen.getByTestId("voice-source")).toHaveValue("local");
    expect(screen.getByTestId("voice-voice")).toHaveValue("af_heart");
    const cloud = await screen.findByRole("option", { name: /ClawBox cloud/ }) as HTMLOptionElement;
    expect(cloud.disabled).toBe(true);
  });

  it("shows no channel note, because channels work here", async () => {
    installFetch(OPENCLAW_STATUS);

    render(<VoiceOutputPanel active />);

    await screen.findByTestId("voice-panel");
    expect(screen.queryByTestId("voice-channels-unavailable")).toBeNull();
  });
});
