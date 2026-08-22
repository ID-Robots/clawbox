import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import VoiceOutputPanel, { isVoiceStatus } from "@/components/VoiceOutputPanel";

/**
 * TASK-434 — what the customer is actually told.
 *
 * The acceptance line this panel exists for is "the chosen and the actually-used
 * engine must both be visible", so the assertions are about both being on
 * screen at once, and about a voice the box cannot use reading as unavailable
 * rather than as a choice that silently does something else.
 */

function engine(over: Record<string, unknown> = {}) {
  return {
    id: "local", providerId: "tts-local-cli", label: "On this box",
    configured: true, proven: false, usable: true, detail: "Speaks on the box itself.",
    ...over,
  };
}

function status(over: Record<string, unknown> = {}) {
  return {
    choice: "auto",
    activeProviderId: "tts-local-cli",
    activeEngine: "local",
    preferredEngine: "local",
    drifted: false,
    engines: [
      engine(),
      engine({ id: "cloud", providerId: "openai", label: "ClawBox cloud", usable: false, configured: false, detail: "The cloud voice comes with ClawBox AI Max, and this box is not set up to call one." }),
    ],
    lastCheck: null,
    warning: null,
    ...over,
  };
}

function mockFetch(payloads: unknown[]) {
  const fn = vi.fn();
  for (const p of payloads) fn.mockResolvedValueOnce({ ok: true, json: async () => p });
  fn.mockResolvedValue({ ok: true, json: async () => payloads.at(-1) });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("Voice panel", () => {
  it("shows which voice is speaking and which one is chosen, together", async () => {
    mockFetch([status()]);
    render(<VoiceOutputPanel active />);
    const speaking = await screen.findByTestId("voice-speaking-now");
    expect(within(speaking).getByText("On this box")).toBeTruthy();
    expect(screen.getByTestId("voice-choice-auto").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("voice-choice-local").getAttribute("aria-checked")).toBe("false");
  });

  it("reads a voice the box cannot use as unavailable, with the reason", async () => {
    mockFetch([status()]);
    render(<VoiceOutputPanel active />);
    const cloud = await screen.findByTestId("voice-choice-cloud");
    expect(within(cloud).getByText("Not available")).toBeTruthy();
    expect(within(cloud).getByText(/comes with ClawBox AI Max/)).toBeTruthy();
    expect(cloud.getAttribute("aria-disabled")).toBe("true");
  });

  it("surfaces the box's refusal rather than pretending the pick worked", async () => {
    const fn = mockFetch([status()]);
    fn.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "That voice is not available on this box." }) });
    render(<VoiceOutputPanel active />);
    fireEvent.click(await screen.findByTestId("voice-choice-cloud"));
    expect(await screen.findByRole("alert")).toHaveTextContent("That voice is not available on this box.");
    // The panel must not paint the refused choice as chosen.
    expect(screen.getByTestId("voice-choice-cloud").getAttribute("aria-checked")).toBe("false");
  });

  it("sends the choice and adopts the box's answer", async () => {
    const fn = mockFetch([status()]);
    fn.mockResolvedValueOnce({
      ok: true,
      json: async () => status({ choice: "local", activeEngine: "local" }),
    });
    render(<VoiceOutputPanel active />);
    fireEvent.click(await screen.findByTestId("voice-choice-local"));
    await waitFor(() => {
      expect(screen.getByTestId("voice-choice-local").getAttribute("aria-checked")).toBe("true");
    });
    const body = JSON.parse((fn.mock.calls[1][1] as { body: string }).body);
    expect(body).toEqual({ action: "select", choice: "local" });
  });

  it("says which voice actually spoke, and names the one that failed before it", async () => {
    mockFetch([status({
      lastCheck: {
        at: 1_787_000_000_000,
        ok: true,
        servedByProviderId: "tts-local-cli",
        servedEngine: "local",
        attempts: [
          { providerId: "openai", engine: "cloud", ok: false, message: "rejected by the voice service", latencyMs: null },
          { providerId: "tts-local-cli", engine: "local", ok: true, message: null, latencyMs: 14893 },
        ],
        message: null,
      },
    })]);
    render(<VoiceOutputPanel active />);
    const last = await screen.findByTestId("voice-last-check");
    expect(within(last).getByText(/On this box spoke\./)).toBeTruthy();
    expect(within(last).getByText(/ClawBox cloud could not speak: rejected by the voice service/)).toBeTruthy();
    expect(within(last).getByText(/On this box spoke in 14\.9s\./)).toBeTruthy();
  });

  it("runs a real check when asked", async () => {
    const fn = mockFetch([status()]);
    fn.mockResolvedValueOnce({ ok: true, json: async () => status() });
    render(<VoiceOutputPanel active />);
    fireEvent.click(await screen.findByTestId("voice-check"));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    expect(JSON.parse((fn.mock.calls[1][1] as { body: string }).body)).toEqual({ action: "check" });
  });

  it("shows the privacy notice the box sent, and nothing when it sent none", async () => {
    mockFetch([status({
      activeProviderId: "openai",
      activeEngine: "cloud",
      warning: "Privacy notice: Voice uses ClawBox AI cloud TTS. Text sent for speech leaves this ClawBox.",
    })]);
    render(<VoiceOutputPanel active />);
    expect(await screen.findByTestId("voice-cloud-warning")).toHaveTextContent(/leaves this ClawBox/);
  });

  it("says nothing about the cloud when the box speaks locally", async () => {
    mockFetch([status()]);
    render(<VoiceOutputPanel active />);
    await screen.findByTestId("voice-speaking-now");
    expect(screen.queryByTestId("voice-cloud-warning")).toBeNull();
  });

  it("names the engine that will actually speak, not the one in the config", async () => {
    // The chosen cloud voice broke, so the gateway will fall back at request
    // time. Naming the configured primary here would tell the customer the one
    // thing this panel exists to stop them believing.
    mockFetch([status({
      choice: "cloud",
      activeProviderId: "openai",
      activeEngine: "cloud",
      preferredEngine: "local",
      drifted: true,
    })]);
    render(<VoiceOutputPanel active />);
    const speaking = await screen.findByTestId("voice-speaking-now");
    expect(within(speaking).getByText("On this box")).toBeTruthy();
    expect(await screen.findByTestId("voice-drift"))
      .toHaveTextContent(/You chose ClawBox cloud, but it cannot speak right now, so On this box answers instead/);
  });

  it("says nothing about a fallback when the chosen voice is the one speaking", async () => {
    mockFetch([status({ choice: "local", preferredEngine: "local" })]);
    render(<VoiceOutputPanel active />);
    await screen.findByTestId("voice-speaking-now");
    expect(screen.queryByTestId("voice-drift")).toBeNull();
  });

  it("moves the box itself when Auto resolves somewhere else, instead of asking the customer to re-pick", async () => {
    const both = [engine(), engine({ id: "cloud", providerId: "openai", label: "ClawBox cloud" })];
    const fn = mockFetch([status({ preferredEngine: "cloud", drifted: true, engines: both })]);
    fn.mockResolvedValueOnce({
      ok: true,
      json: async () => status({ activeProviderId: "openai", activeEngine: "cloud", preferredEngine: "cloud", drifted: false, engines: both }),
    });
    render(<VoiceOutputPanel active />);
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    expect(JSON.parse((fn.mock.calls[1][1] as { body: string }).body)).toEqual({ action: "select", choice: "auto" });
    const speaking = await screen.findByTestId("voice-speaking-now");
    expect(within(speaking).getByText("ClawBox cloud")).toBeTruthy();
  });

  it("does not keep rewriting the box when the drift will not clear", async () => {
    // A write that does not resolve the drift must not become a loop.
    const both = [engine(), engine({ id: "cloud", providerId: "openai", label: "ClawBox cloud" })];
    const drifting = status({ preferredEngine: "cloud", drifted: true, engines: both });
    const fn = mockFetch([drifting]);
    fn.mockResolvedValue({ ok: true, json: async () => drifting });
    render(<VoiceOutputPanel active />);
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    await new Promise(r => setTimeout(r, 300));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("keeps its last good reading when the box answers something that is not a status", async () => {
    const fn = mockFetch([status()]);
    render(<VoiceOutputPanel active />);
    await screen.findByTestId("voice-speaking-now");
    fn.mockResolvedValueOnce({ ok: true, json: async () => ({ engines: [] }) });
    fireEvent.click(screen.getByTestId("voice-check"));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    // Still rendered, still the old reading — not a blank panel and not a crash.
    expect(screen.getByTestId("voice-speaking-now")).toBeTruthy();
  });
});

describe("status validation", () => {
  it("rejects a payload whose engines are half a shape", () => {
    expect(isVoiceStatus(status())).toBe(true);
    expect(isVoiceStatus({ ...status(), engines: [{ id: "local" }] })).toBe(false);
    expect(isVoiceStatus({ ...status(), choice: "fastest" })).toBe(false);
    expect(isVoiceStatus({ ...status(), drifted: "yes" })).toBe(false);
    expect(isVoiceStatus({ engines: [] })).toBe(false);
    expect(isVoiceStatus(null)).toBe(false);
  });

  it("rejects a last check that is missing the fields the render reads", () => {
    expect(isVoiceStatus({ ...status(), lastCheck: { ok: true } })).toBe(false);
    expect(isVoiceStatus({ ...status(), lastCheck: { at: 1, ok: true, attempts: [], servedByProviderId: null, servedEngine: null, message: null } })).toBe(true);
  });
});

describe("a damaged check record cannot take the window down", () => {
  const withCheck = (attempts: unknown[], over: Record<string, unknown> = {}) => ({
    ...status(),
    lastCheck: { at: 1, ok: true, servedByProviderId: "tts-local-cli", servedEngine: "local", attempts, message: null, ...over },
  });

  it("rejects a check whose attempts are not attempts", () => {
    expect(isVoiceStatus(withCheck([null]))).toBe(false);
    expect(isVoiceStatus(withCheck([{ providerId: "openai" }]))).toBe(false);
    expect(isVoiceStatus(withCheck([{ providerId: "openai", engine: "cloud", ok: false, message: null, latencyMs: null }]))).toBe(true);
  });

  it("rejects a served provider the panel would print as `undefined`", () => {
    expect(isVoiceStatus(withCheck([], { servedByProviderId: 7 }))).toBe(false);
    expect(isVoiceStatus(withCheck([], { servedEngine: "quantum" }))).toBe(false);
    expect(isVoiceStatus(withCheck([], { message: 7 }))).toBe(false);
  });
});

describe("absent and broken are different answers", () => {
  it("offers a voice whose last check failed, and says so", async () => {
    mockFetch([status({
      engines: [
        engine(),
        engine({ id: "cloud", providerId: "openai", label: "ClawBox cloud", configured: true, usable: false, detail: "The last voice check failed: provider_error" }),
      ],
    })]);
    render(<VoiceOutputPanel active />);
    const cloud = await screen.findByTestId("voice-choice-cloud");
    expect(within(cloud).getByText("Last check failed")).toBeTruthy();
    expect(within(cloud).queryByText("Not available")).toBeNull();
    // Still pickable: refusing it would make the failure permanent, since
    // nothing else would ever route a check through it again.
    expect(cloud.getAttribute("aria-disabled")).toBe("false");
  });

  it("does not offer a voice the box does not have", async () => {
    mockFetch([status()]);
    render(<VoiceOutputPanel active />);
    const cloud = await screen.findByTestId("voice-choice-cloud");
    expect(within(cloud).getByText("Not available")).toBeTruthy();
    expect(within(cloud).queryByText("Last check failed")).toBeNull();
    expect(cloud.getAttribute("aria-disabled")).toBe("true");
  });
});
