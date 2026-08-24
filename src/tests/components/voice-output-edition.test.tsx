import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import VoiceOutputPanel from "@/components/VoiceOutputPanel";

/**
 * Settings → Voice was a dead end on the Hermes edition.
 *
 * Every action behind the panel runs the openclaw CLI — `capability tts
 * convert` for Check, `config set messages.tts.provider` for Select — and the
 * Hermes SKU ships no openclaw binary. The panel rendered anyway, offering a
 * Check that reported a blank failure and a Select the route answered with 409.
 *
 * The box now says the true thing once, and the panel repeats it, the same way
 * ClawKeep already handles a feature that is not part of this edition.
 */

const OPENCLAW_STATUS = {
  choice: "auto",
  engines: [
    {
      id: "local",
      label: "On this box",
      detail: "Piper",
      providerId: "piper",
      configured: true,
      proven: true,
      usable: true,
    },
  ],
  activeProviderId: "piper",
  activeEngine: "local",
  preferredEngine: "local",
  drifted: false,
  warning: null,
  lastCheck: null,
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
    expect(screen.getByText(/Not available on this edition/)).toBeInTheDocument();
    // The three grey cards are what a customer saw while the panel waited for a
    // status the box was never going to produce.
    expect(screen.queryByTestId("voice-output-loading")).toBeNull();
  });

  it("offers neither a choice to make nor a check to run", async () => {
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
    expect(screen.getByText("ClawBox cloud")).toBeInTheDocument();
  });
});
