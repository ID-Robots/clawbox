import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import VoiceOutputPanel, { isVoiceStatus } from "@/components/VoiceOutputPanel";
import { sampleSentence } from "@/lib/voice-catalog";

/**
 * Settings → Voice, the compact version: where speech comes from, the
 * language, the voice, and a sentence to hear.
 *
 * Pinned here: every dropdown posts to the route that owns the change and
 * adopts the box's answer (never an optimistic flip); an engine the box does
 * not have cannot be picked; the Play button speaks the text in the box with
 * the engine and voice on screen; and a refusal is shown in the box's words.
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
    activeProviderId: "openai",
    activeEngine: "cloud",
    preferredEngine: "cloud",
    drifted: false,
    engines: [
      engine(),
      engine({ id: "cloud", providerId: "openai", label: "ClawBox cloud", configured: true, usable: true, detail: "Speaks in the cloud." }),
    ],
    lastCheck: null,
    warning: "Voice uses ClawBox AI cloud TTS. Text sent for speech leaves this ClawBox.",
    language: "en",
    voice: { local: "af_heart", cloud: "alloy" },
    ...over,
  };
}

let posts: { url: string; body: unknown }[] = [];

function mockFetch(first: unknown, opts: { answer?: unknown; refuse?: { status: number; error: string }; sample?: { status: number; error?: string } } = {}) {
  posts = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url === "/setup-api/tts/sample") {
        if (opts.sample && opts.sample.status !== 200) return json({ error: opts.sample.error }, opts.sample.status);
        return new Response(new Uint8Array(2048), { status: 200, headers: { "content-type": "audio/wav" } });
      }
      if (opts.refuse) return json({ error: opts.refuse.error }, opts.refuse.status);
      return json(opts.answer ?? first);
    }
    return json(first);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** jsdom has neither object URLs nor a playing Audio element. */
const played: string[] = [];
function stubAudio() {
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:sample"),
    revokeObjectURL: vi.fn(),
  }));
  vi.stubGlobal("Audio", class {
    src: string;
    constructor(src: string) { this.src = src; played.push(src); }
    play() { return Promise.resolve(); }
    pause() {}
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  played.length = 0;
});

describe("Voice panel", () => {
  it("shows the source, language and voice the box reports, and the sample sentence in that language", async () => {
    mockFetch(status({ language: "de" }));
    render(<VoiceOutputPanel active />);
    expect(await screen.findByTestId("voice-source")).toHaveValue("cloud");
    expect(screen.getByTestId("voice-language")).toHaveValue("de");
    expect(screen.getByTestId("voice-voice")).toHaveValue("alloy");
    expect(screen.getByTestId("voice-sample-text")).toHaveValue(sampleSentence("de"));
    // The privacy notice rides with the cloud source.
    expect(screen.getByTestId("voice-cloud-warning")).toHaveTextContent(/leaves this ClawBox/);
  });

  it("switches the source through the route and adopts the box's answer", async () => {
    mockFetch(status(), { answer: status({ choice: "local", warning: null }) });
    render(<VoiceOutputPanel active />);
    fireEvent.change(await screen.findByTestId("voice-source"), { target: { value: "local" } });
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/tts", body: { action: "select", choice: "local" } }));
    await waitFor(() => expect(screen.getByTestId("voice-source")).toHaveValue("local"));
    // The voice list follows the source, and so does the cloud notice.
    expect(screen.getByTestId("voice-voice")).toHaveValue("af_heart");
    expect(screen.queryByTestId("voice-cloud-warning")).toBeNull();
  });

  it("cannot pick an engine the box does not have", async () => {
    const s = status();
    s.engines[0] = engine({ configured: false, usable: false });
    mockFetch(s);
    render(<VoiceOutputPanel active />);
    await screen.findByTestId("voice-source");
    const option = screen.getByRole("option", { name: /This box/ }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(option.textContent).toMatch(/no voice installed/);
  });

  it("posts a voice change for the engine on screen, and a language change with a fresh sample", async () => {
    mockFetch(status(), { answer: status({ voice: { local: "af_heart", cloud: "nova" }, language: "fr" }) });
    render(<VoiceOutputPanel active />);
    fireEvent.change(await screen.findByTestId("voice-voice"), { target: { value: "nova" } });
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/tts", body: { action: "voice", engine: "cloud", voice: "nova" } }));
    fireEvent.change(screen.getByTestId("voice-sample-text"), { target: { value: "my own words" } });
    fireEvent.change(screen.getByTestId("voice-language"), { target: { value: "fr" } });
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/tts", body: { action: "language", language: "fr" } }));
    await waitFor(() => expect(screen.getByTestId("voice-sample-text")).toHaveValue(sampleSentence("fr")));
  });

  it("plays the text in the box with the engine and voice on screen", async () => {
    stubAudio();
    mockFetch(status({ choice: "local", voice: { local: "bm_george", cloud: "alloy" } }));
    render(<VoiceOutputPanel active />);
    fireEvent.change(await screen.findByTestId("voice-sample-text"), { target: { value: "Testing, one two three." } });
    fireEvent.click(screen.getByTestId("voice-play"));
    await waitFor(() => expect(posts).toContainEqual({
      url: "/setup-api/tts/sample",
      body: { text: "Testing, one two three.", engine: "local", voice: "bm_george" },
    }));
    await waitFor(() => expect(played).toEqual(["blob:sample"]));
  });

  it("shows the box's refusal in its own words", async () => {
    stubAudio();
    mockFetch(status(), { sample: { status: 409, error: "The cloud voice is not set up on this box." } });
    render(<VoiceOutputPanel active />);
    fireEvent.click(await screen.findByTestId("voice-play"));
    expect(await screen.findByRole("alert")).toHaveTextContent("The cloud voice is not set up on this box.");
    expect(played).toEqual([]);
  });

  it("notes that the box's own voice is English only when another language is picked", async () => {
    mockFetch(status({ choice: "local", language: "es" }));
    render(<VoiceOutputPanel active />);
    expect(await screen.findByTestId("voice-local-english-only")).toBeInTheDocument();
  });

  it("moves the box itself when Auto resolves somewhere else, once", async () => {
    mockFetch(status({ drifted: true, activeProviderId: "tts-local-cli", activeEngine: "local" }), { answer: status({ drifted: true, activeProviderId: "tts-local-cli", activeEngine: "local" }) });
    render(<VoiceOutputPanel active />);
    await screen.findByTestId("voice-source");
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/tts", body: { action: "select", choice: "auto" } }));
    await new Promise((r) => setTimeout(r, 50));
    expect(posts.filter((p) => p.url === "/setup-api/tts")).toHaveLength(1);
  });

  it("keeps its last good reading when the box answers something that is not a status", async () => {
    mockFetch(status(), { answer: { engines: [] } });
    render(<VoiceOutputPanel active />);
    fireEvent.change(await screen.findByTestId("voice-voice"), { target: { value: "nova" } });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(screen.getByTestId("voice-voice")).toHaveValue("alloy");
  });
});

describe("status validation", () => {
  it("rejects a payload without the voice each engine speaks with", () => {
    const s = status() as Record<string, unknown>;
    expect(isVoiceStatus(s)).toBe(true);
    expect(isVoiceStatus({ ...s, voice: { local: "af_heart" } })).toBe(false);
    expect(isVoiceStatus({ ...s, language: null })).toBe(false);
  });

  it("rejects a payload whose engines are half a shape", () => {
    const s = status() as Record<string, unknown>;
    expect(isVoiceStatus({ ...s, engines: [{ id: "local" }] })).toBe(false);
  });
});
