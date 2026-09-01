import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render as renderBare, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import VoiceOutputPanel, { isVoiceStatus } from "@/components/VoiceOutputPanel";
import { sampleSentence } from "@/lib/voice-catalog";

/**
 * Settings → Voice, the compact version: where speech comes from, the
 * language, the voice, and a sentence to hear.
 *
 * Pinned here: every dropdown posts to the route that owns the change and
 * adopts the box's answer (never an optimistic flip — the wait is named
 * instead); an engine the box does not have cannot be picked; the Play button
 * speaks the text in the box with the engine and voice on screen; a refusal
 * is shown in the box's words, or in the owner's language when the box sent a
 * code for it; and a clip does not outlive the controls it was made with.
 */

function engine(over: Record<string, unknown> = {}) {
  return {
    id: "local", providerId: "tts-local-cli", label: "On this box",
    configured: true, detail: "Speaks on the box itself.",
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
      engine({ id: "cloud", providerId: "openai", label: "ClawBox cloud", configured: true, detail: "Speaks in the cloud." }),
    ],
    warning: "Privacy notice: Voice uses ClawBox AI cloud TTS. Text sent for speech leaves this ClawBox.",
    disclosure: { kind: "uses-cloud", providers: ["ClawBox AI"], primaryIsLocal: false },
    language: "en",
    voice: { local: "af_heart", cloud: "alloy" },
    ...over,
  };
}

let posts: { url: string; body: unknown }[] = [];

interface MockOptions {
  answer?: unknown;
  /** Hold every tts POST until the returned `release` is called. */
  hold?: boolean;
  refuse?: { status: number; body: Record<string, unknown> };
  sample?: { status: number; body?: Record<string, unknown> };
}

function mockFetch(first: unknown, opts: MockOptions = {}) {
  posts = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url === "/setup-api/tts/sample") {
        if (opts.sample && opts.sample.status !== 200) return json(opts.sample.body ?? {}, opts.sample.status);
        return new Response(new Uint8Array(2048), { status: 200, headers: { "content-type": "audio/wav" } });
      }
      if (opts.hold) await held;
      if (opts.refuse) return json(opts.refuse.body, opts.refuse.status);
      return json(opts.answer ?? first);
    }
    return json(first);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, release };
}

// The panel's copy comes through the i18n provider, like every Settings
// panel; the provider's own preference fetch lands on the mock above and
// resolves to English.
const render = (ui: React.ReactElement) => renderBare(<I18nProvider>{ui}</I18nProvider>);

const MEDIA = window.HTMLMediaElement.prototype;
/**
 * What jsdom ships before any test patches it — put back after EVERY test,
 * pass or fail. `vi.stubGlobal("URL", Object.assign(URL, …))` looked like a
 * stub but mutated the real URL, so unstubAllGlobals restored the patched
 * object; and the `play` patch was undone only by the last line of the test
 * that made it, so one failing assertion there left every later test with a
 * player that refused everything.
 */
const original = {
  createObjectURL: URL.createObjectURL,
  revokeObjectURL: URL.revokeObjectURL,
  play: Object.getOwnPropertyDescriptor(MEDIA, "play"),
};

/**
 * jsdom has no object URLs, and its media elements never really play. `play`
 * is patched only when the test says how the browser answers.
 */
function stubAudio(play?: () => Promise<void>) {
  URL.createObjectURL = vi.fn(() => "blob:sample");
  URL.revokeObjectURL = vi.fn();
  if (play) Object.defineProperty(MEDIA, "play", { configurable: true, value: play });
}

afterEach(() => {
  vi.unstubAllGlobals();
  URL.createObjectURL = original.createObjectURL;
  URL.revokeObjectURL = original.revokeObjectURL;
  if (original.play) Object.defineProperty(MEDIA, "play", original.play);
  else Reflect.deleteProperty(MEDIA, "play");
});

describe("Voice panel", () => {
  it("shows the source, language and voice the box reports, and the sample sentence in that language", async () => {
    mockFetch(status({ language: "de" }));
    render(<VoiceOutputPanel active />);
    expect(await screen.findByTestId("voice-source")).toHaveValue("cloud");
    expect(screen.getByTestId("voice-language")).toHaveValue("de");
    expect(screen.getByTestId("voice-voice")).toHaveValue("alloy");
    expect(screen.getByTestId("voice-sample-text")).toHaveValue(sampleSentence("de"));
    // No privacy notice: the panel used to carry one on every cloud source and
    // it was removed.
    expect(screen.queryByTestId("voice-cloud-warning")).toBeNull();
    // And the labels are the translated ones, not keys.
    expect(await screen.findByText("Speak from")).toBeInTheDocument();
  });

  it("switches the source through the route and adopts the box's answer", async () => {
    mockFetch(status(), { answer: status({ choice: "local", warning: null, disclosure: null }) });
    render(<VoiceOutputPanel active />);
    fireEvent.change(await screen.findByTestId("voice-source"), { target: { value: "local" } });
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/tts", body: { action: "select", choice: "local" } }));
    await waitFor(() => expect(screen.getByTestId("voice-source")).toHaveValue("local"));
    // The voice list follows the source.
    expect(screen.getByTestId("voice-voice")).toHaveValue("af_heart");
  });

  it("names the wait while the box writes, instead of flipping the select early", async () => {
    // The write is the openclaw CLI's 8-12 s cold start. The select keeps the
    // box's value — the route can refuse — so the panel says what it is doing.
    const { release } = mockFetch(status(), { answer: status({ choice: "local", warning: null, disclosure: null }), hold: true });
    render(<VoiceOutputPanel active />);
    fireEvent.change(await screen.findByTestId("voice-source"), { target: { value: "local" } });
    expect(await screen.findByTestId("voice-saving")).toHaveTextContent("Saving…");
    expect(screen.getByTestId("voice-source")).toHaveValue("cloud");
    release();
    await waitFor(() => expect(screen.getByTestId("voice-source")).toHaveValue("local"));
    expect(screen.queryByTestId("voice-saving")).toBeNull();
  });

  it("shows no privacy notice, in either direction of the fall-through", async () => {
    // The panel used to draw two: an amber one where the cloud speaks first,
    // and a muted line where the box's own voice leads and the cloud stands
    // behind it. Both are gone. The box still SENDS the fact — `disclosure` and
    // `warning` are untouched on the wire — so this pins the UI, not the API.
    mockFetch(status({
      choice: "local", activeProviderId: "tts-local-cli", activeEngine: "local", preferredEngine: "local",
      warning: "Privacy notice: If local speech is unavailable, voice may use ClawBox AI cloud TTS. Text sent for speech may leave this ClawBox.",
      disclosure: { kind: "may-use-cloud", providers: ["ClawBox AI"], primaryIsLocal: true },
    }));
    render(<VoiceOutputPanel active />);
    expect(await screen.findByTestId("voice-source")).toHaveValue("local");
    expect(screen.queryByTestId("voice-cloud-fallback-note")).toBeNull();
    expect(screen.queryByTestId("voice-cloud-warning")).toBeNull();
    expect(screen.queryByText(/Privacy notice/i)).toBeNull();
  });

  it("cannot pick an engine the box does not have", async () => {
    const s = status();
    s.engines[0] = engine({ configured: false });
    mockFetch(s);
    render(<VoiceOutputPanel active />);
    await screen.findByTestId("voice-source");
    const option = await screen.findByRole("option", { name: /This box/ }) as HTMLOptionElement;
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

  it("hands the clip to a real player, with the engine and voice on screen", async () => {
    stubAudio();
    mockFetch(status({ choice: "local", voice: { local: "bm_george", cloud: "alloy" } }));
    render(<VoiceOutputPanel active />);
    fireEvent.change(await screen.findByTestId("voice-sample-text"), { target: { value: "Testing, one two three." } });
    fireEvent.click(screen.getByTestId("voice-play"));
    await waitFor(() => expect(posts).toContainEqual({
      url: "/setup-api/tts/sample",
      body: { text: "Testing, one two three.", engine: "local", voice: "bm_george" },
    }));
    // A controls element the owner can press, not a detached Audio object the
    // browser may refuse with nothing left to click.
    const player = await screen.findByTestId("voice-sample-audio");
    expect(player).toHaveAttribute("src", "blob:sample");
    expect(player).toHaveAttribute("controls");
  });

  it("drops the clip when the engine, voice or language changes", async () => {
    // A German cloud clip under a panel now reading "This box / Italiano"
    // reads as a sample of those — and keeps speaking in the old voice if it
    // was still playing.
    stubAudio();
    mockFetch(status(), { answer: status({ language: "it" }) });
    render(<VoiceOutputPanel active />);
    fireEvent.click(await screen.findByTestId("voice-play"));
    await screen.findByTestId("voice-sample-audio");
    fireEvent.change(screen.getByTestId("voice-language"), { target: { value: "it" } });
    await waitFor(() => expect(screen.queryByTestId("voice-sample-audio")).toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:sample");
  });

  it("counts the seconds while the box speaks", async () => {
    // A local sample can take 15 s on a cold Kokoro; "Speaking…" alone for
    // that long reads as a hang.
    stubAudio();
    const { release } = mockFetch(status(), { hold: true });
    // The sample fetch is held the way the tts POST is.
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (init?.method === "POST" && input.toString() === "/setup-api/tts/sample") {
        // Held long enough that "Speaking… 1s" survives a loaded CI runner:
        // the 1s tick renders at ~1000ms and the label moves on when the
        // sample resolves, so a short hold left a ~200ms observation window.
        await new Promise<void>((resolve) => setTimeout(resolve, 3500));
        return new Response(new Uint8Array(2048), { status: 200, headers: { "content-type": "audio/wav" } });
      }
      return new Response(JSON.stringify(status()), { status: 200, headers: { "content-type": "application/json" } });
    }));
    render(<VoiceOutputPanel active />);
    const play = await screen.findByTestId("voice-play");
    fireEvent.click(play);
    expect(await screen.findByText("Speaking… 0s")).toBeInTheDocument();
    expect(await screen.findByText("Speaking… 1s", {}, { timeout: 6000 })).toBeInTheDocument();
    await screen.findByTestId("voice-sample-audio");
    release();
  });

  it("says the sound was blocked rather than losing the sample, when the browser refuses to start it", async () => {
    // A browser that declines programmatic playback — Safari's rule once the
    // audio arrived after an await.
    stubAudio(() => Promise.reject(new Error("NotAllowedError")));
    mockFetch(status());
    render(<VoiceOutputPanel active />);
    fireEvent.click(await screen.findByTestId("voice-play"));
    expect(await screen.findByTestId("voice-autoplay-blocked")).toBeInTheDocument();
    // ...and the player is still there to press.
    expect(screen.getByTestId("voice-sample-audio")).toBeInTheDocument();
  });

  it("cannot play a sample with an engine the box does not have", async () => {
    // `choice: "cloud"` is a legacy value the panel honours, so the source can
    // be an engine whose own option is greyed out. Play used to ask the box
    // to speak with it anyway, and all it produced was a refusal to read.
    stubAudio();
    const s = status({ choice: "cloud" });
    s.engines[1] = engine({ id: "cloud", providerId: "openai", label: "ClawBox cloud", configured: false });
    mockFetch(s);
    render(<VoiceOutputPanel active />);
    const play = await screen.findByTestId("voice-play");
    expect(screen.getByTestId("voice-source")).toHaveValue("cloud");
    expect(play).toBeDisabled();
    fireEvent.click(play);
    await new Promise((r) => setTimeout(r, 20));
    expect(posts.filter((p) => p.url === "/setup-api/tts/sample")).toEqual([]);
    expect(screen.queryByTestId("voice-sample-audio")).toBeNull();
  });

  it("shows the box's refusal in its own words when it sent no code", async () => {
    stubAudio();
    mockFetch(status(), { sample: { status: 409, body: { error: "The cloud voice is not set up on this box." } } });
    render(<VoiceOutputPanel active />);
    fireEvent.click(await screen.findByTestId("voice-play"));
    expect(await screen.findByRole("alert")).toHaveTextContent("The cloud voice is not set up on this box.");
    expect(screen.queryByTestId("voice-sample-audio")).toBeNull();
  });

  it("says the box's reason in the owner's language when it sent a code, numbers included", async () => {
    // The memory guard: a fact about the box, with the figures the owner needs
    // to know how far off it is, translated from the code rather than shown in
    // the box's English.
    stubAudio();
    mockFetch(status(), { sample: { status: 502, body: { error: "The box is short of memory…", code: "local_memory", available: "2.4", needed: "3" } } });
    render(<VoiceOutputPanel active />);
    fireEvent.click(await screen.findByTestId("voice-play"));
    expect(await screen.findByRole("alert")).toHaveTextContent("short of memory for its voice right now (2.4 GB free, needs 3 GB)");
  });

  it("notes that the box's own voice is English only when another language is picked", async () => {
    mockFetch(status({ choice: "local", language: "es" }));
    render(<VoiceOutputPanel active />);
    expect(await screen.findByTestId("voice-local-english-only")).toBeInTheDocument();
  });

  it("moves the box itself when Auto resolves somewhere else, once, and says so while it does", async () => {
    const drifted = status({ drifted: true, activeProviderId: "tts-local-cli", activeEngine: "local" });
    const { release } = mockFetch(drifted, { answer: drifted, hold: true });
    render(<VoiceOutputPanel active />);
    await screen.findByTestId("voice-source");
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/tts", body: { action: "select", choice: "auto" } }));
    // A write the owner did not ask for announces itself while it runs, and
    // only while it runs — the standing status text went on the owner's request.
    expect(await screen.findByTestId("voice-saving")).toHaveTextContent(/Restoring your Auto choice/);
    release();
    await waitFor(() => expect(screen.queryByTestId("voice-saving")).toBeNull());
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

  it("accepts a status without the structured notice, and rejects a malformed one", () => {
    const s = status() as Record<string, unknown>;
    expect(isVoiceStatus({ ...s, disclosure: undefined })).toBe(true);
    expect(isVoiceStatus({ ...s, disclosure: null })).toBe(true);
    expect(isVoiceStatus({ ...s, disclosure: { kind: "maybe", providers: [] } })).toBe(false);
  });
});
