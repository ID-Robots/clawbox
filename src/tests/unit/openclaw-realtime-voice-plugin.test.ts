import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import plugin from "../../../scripts/openclaw-plugins/clawbox-realtime-voice/index.mjs";
import {
  buildClawboxRealtimeProvider,
  createClawboxRealtimeBridge,
  fetchClientSecret,
  isProxyUrl,
  DEFAULT_MODEL,
  MAX_SESSION_SECONDS,
  PROVIDER_ID,
} from "../../../scripts/openclaw-plugins/clawbox-realtime-voice/realtime-bridge.mjs";
import {
  CLAWAI_REALTIME_MODEL_ID,
  CLAWAI_REALTIME_PROVIDER_ID,
  CLAWAI_REALTIME_WEEKLY_MINUTES,
} from "@/lib/clawai-plan-tier";

// ClawBox's realtime voice provider. OpenClaw Talk on Max with no OpenAI key on
// the box: the bridge trades the box's ClawBox AI token at the proxy for a
// short-lived OpenAI client secret and opens OpenAI's realtime socket with it.
// The proxy and the socket are stand-ins here; what is pinned is what the box
// sends where, and what it does with the answers.

const PLUGIN_DIR = path.resolve(__dirname, "../../../scripts/openclaw-plugins/clawbox-realtime-voice");
const PROXY = "https://clawbox.com/api/ai";
const TOKEN = "claw_box_token";
const SECRET = "ek_short_lived";
const CONFIG = { baseUrl: PROXY, apiKey: TOKEN };

type Sent = Record<string, unknown> & { type: string };

class FakeSocket {
  static last: FakeSocket | null = null;
  sent: Sent[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string, public protocols: string[]) {
    FakeSocket.last = this;
    queueMicrotask(() => this.start());
  }
  /** How the far end answers the handshake: it opens. */
  start() { this.onopen?.(); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code: number) { this.closedWith = code; }
  emit(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
  of(type: string) { return this.sent.filter((e) => e.type === type); }
}

function proxy(status = 200, body: unknown = { value: SECRET, expires_at: 1, session_seconds: 600, session_id: "rt_1" }) {
  return vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

function bridge(req: Record<string, unknown> = {}, fetchImpl = proxy()) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let clock = 1_000_000;
  const b = createClawboxRealtimeBridge(
    { providerConfig: CONFIG, ...req },
    {
      fetch: fetchImpl,
      WebSocket: FakeSocket,
      now: () => clock,
      setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
      clearTimeout: () => {},
    },
  );
  return { b, fetchImpl, timers, advance: (ms: number) => { clock += ms; } };
}

describe("clawbox-realtime-voice plugin", () => {
  it("registers the clawbox realtime voice provider its manifest declares", () => {
    const providers: Array<{ id: string }> = [];
    plugin.register({ registerRealtimeVoiceProvider: (p: { id: string }) => providers.push(p) });

    const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "openclaw.plugin.json"), "utf-8"));
    expect(manifest.id).toBe(plugin.id);
    expect(manifest.contracts.realtimeVoiceProviders).toEqual([PROVIDER_ID]);
    expect(providers.map((p) => p.id)).toEqual([PROVIDER_ID]);
  });

  it("names the same provider, model and allowance as the TypeScript side", () => {
    expect(PROVIDER_ID).toBe(CLAWAI_REALTIME_PROVIDER_ID);
    expect(DEFAULT_MODEL).toBe(CLAWAI_REALTIME_MODEL_ID);
    expect(MAX_SESSION_SECONDS).toBe(CLAWAI_REALTIME_WEEKLY_MINUTES * 60);
  });

  it("offers only the Gateway relay, on 24 kHz PCM", () => {
    const p = buildClawboxRealtimeProvider();
    expect(p.capabilities.transports).toEqual(["gateway-relay"]);
    expect(p.capabilities.inputAudioFormats).toEqual([{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }]);
  });

  it("is configured only by a ClawBox AI token at a proxy address", () => {
    const { isConfigured } = buildClawboxRealtimeProvider();
    expect(isConfigured({ providerConfig: CONFIG })).toBe(true);
    // An OpenAI key is exactly what this provider exists not to need.
    expect(isConfigured({ providerConfig: { baseUrl: PROXY, apiKey: "sk-owner" } })).toBe(false);
    expect(isConfigured({ providerConfig: { baseUrl: PROXY } })).toBe(false);
    expect(isConfigured({ providerConfig: { baseUrl: "http://evil.example", apiKey: TOKEN } })).toBe(false);
    expect(isConfigured({})).toBe(false);
  });

  it("sends the token only to HTTPS, or to a loopback proxy in development", () => {
    expect(isProxyUrl(PROXY)).toBe(true);
    expect(isProxyUrl("http://127.0.0.1:3000/api/ai")).toBe(true);
    expect(isProxyUrl("http://clawbox.com/api/ai")).toBe(false);
    expect(isProxyUrl("https://user:pass@clawbox.com/api/ai")).toBe(false);
    expect(isProxyUrl("not a url")).toBe(false);
  });

  describe("the token exchange", () => {
    it("asks the proxy for a client secret with the box's token, and nothing else", async () => {
      const fetchImpl = proxy();
      const secret = await fetchClientSecret({ baseUrl: `${PROXY}/`, token: TOKEN, model: DEFAULT_MODEL, voice: "cedar", fetchImpl });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe(`${PROXY}/realtime/client_secrets`);
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(String(init?.body))).toEqual({ model: DEFAULT_MODEL, voice: "cedar" });
      expect(secret).toEqual({
        value: SECRET,
        url: `wss://api.openai.com/v1/realtime?model=${DEFAULT_MODEL}`,
        sessionSeconds: 600,
        sessionId: "rt_1",
      });
    });

    it("never calls anything without a ClawBox AI token", async () => {
      const fetchImpl = proxy();
      await expect(fetchClientSecret({ baseUrl: PROXY, token: "sk-owner", model: DEFAULT_MODEL, fetchImpl })).rejects.toThrow(/not linked/);
      await expect(fetchClientSecret({ baseUrl: "http://evil.example", token: TOKEN, model: DEFAULT_MODEL, fetchImpl })).rejects.toThrow(/not one realtime Talk will use/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([
      [401, {}, /Re-link ClawBox AI/],
      [403, {}, /Max plan/],
      [402, {}, /Max plan/],
      [404, {}, /not available yet/],
      [429, { resets_at: "Monday" }, /minutes are used up\. They come back on Monday\./],
      [500, {}, /HTTP 500/],
    ])("turns a %i into a sentence a Talk client can show", async (status, body, message) => {
      const err = await fetchClientSecret({ baseUrl: PROXY, token: TOKEN, model: DEFAULT_MODEL, fetchImpl: proxy(status, body) }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(message);
      expect((err as Error).message).not.toContain(TOKEN);
    });

    it("refuses an answer without a secret, and a socket address that is not wss://", async () => {
      await expect(fetchClientSecret({ baseUrl: PROXY, token: TOKEN, model: DEFAULT_MODEL, fetchImpl: proxy(200, {}) })).rejects.toThrow(/without a realtime session secret/);
      await expect(
        fetchClientSecret({ baseUrl: PROXY, token: TOKEN, model: DEFAULT_MODEL, fetchImpl: proxy(200, { value: SECRET, url: "ws://plain.example/rt" }) }),
      ).rejects.toThrow(/not wss/);
    });

    it("reports an unreachable proxy without leaking the token", async () => {
      const fetchImpl = vi.fn(async () => { throw new Error(`connect ECONNREFUSED ${TOKEN}`); });
      const err = (await fetchClientSecret({ baseUrl: PROXY, token: TOKEN, model: DEFAULT_MODEL, fetchImpl }).catch((e: Error) => e)) as Error;
      expect(err.message).toMatch(/Could not reach ClawBox AI/);
      expect(err.message).not.toContain(TOKEN);
    });

    it("caps a session at the weekly allowance whatever the proxy grants", async () => {
      const big = await fetchClientSecret({ baseUrl: PROXY, token: TOKEN, model: DEFAULT_MODEL, fetchImpl: proxy(200, { value: SECRET, session_seconds: 99_999 }) });
      const none = await fetchClientSecret({ baseUrl: PROXY, token: TOKEN, model: DEFAULT_MODEL, fetchImpl: proxy(200, { value: SECRET }) });
      expect(big.sessionSeconds).toBe(MAX_SESSION_SECONDS);
      expect(none.sessionSeconds).toBe(MAX_SESSION_SECONDS);
    });
  });

  describe("a Talk session", () => {
    it("opens OpenAI's realtime socket with the ephemeral secret and configures the session", async () => {
      const onReady = vi.fn();
      const { b, fetchImpl } = bridge({ onReady, instructions: "Be brief.", providerConfig: { ...CONFIG, speakerVoice: "cedar" } });
      await b.connect();

      const socket = FakeSocket.last!;
      expect(socket.url).toBe(`wss://api.openai.com/v1/realtime?model=${DEFAULT_MODEL}`);
      expect(socket.protocols).toEqual(["realtime", `openai-insecure-api-key.${SECRET}`]);
      // The only thing the box ever sent is its own token, to the proxy.
      expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([`${PROXY}/realtime/client_secrets`]);
      const [update] = socket.of("session.update");
      expect(update.session).toMatchObject({
        type: "realtime",
        instructions: "Be brief.",
        audio: { input: { format: { type: "audio/pcm", rate: 24000 } }, output: { format: { type: "audio/pcm", rate: 24000 }, voice: "cedar" } },
      });
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(b.isConnected()).toBe(true);
    });

    it("holds microphone audio sent before the socket opened, then relays it", async () => {
      const { b } = bridge();
      const connecting = b.connect();
      b.sendAudio(Buffer.from([1, 2]));
      await connecting;
      b.sendAudio(Buffer.from([3, 4]));

      const appended = FakeSocket.last!.of("input_audio_buffer.append").map((e) => e.audio);
      expect(appended).toEqual([Buffer.from([1, 2]).toString("base64"), Buffer.from([3, 4]).toString("base64")]);
    });

    it("hands the assistant's audio, both transcripts and the user's barge-in to the host", async () => {
      const onAudio = vi.fn();
      const onTranscript = vi.fn();
      const onClearAudio = vi.fn();
      const { b } = bridge({ onAudio, onTranscript, onClearAudio });
      await b.connect();
      const socket = FakeSocket.last!;

      socket.emit({ type: "response.output_audio.delta", item_id: "item_1", delta: Buffer.from([9, 8]).toString("base64") });
      socket.emit({ type: "response.output_audio_transcript.done", transcript: "Hello." });
      socket.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "Hi there" });
      socket.emit({ type: "input_audio_buffer.speech_started" });

      expect(onAudio).toHaveBeenCalledWith(Buffer.from([9, 8]), { itemId: "item_1" });
      expect(onTranscript).toHaveBeenCalledWith("assistant", "Hello.", true);
      expect(onTranscript).toHaveBeenCalledWith("user", "Hi there", true);
      expect(onClearAudio).toHaveBeenCalledWith("barge-in");
    });

    it("routes a tool call to the host and its result back to the model", async () => {
      const onToolCall = vi.fn();
      const { b } = bridge({ onToolCall });
      await b.connect();
      const socket = FakeSocket.last!;

      socket.emit({ type: "response.function_call_arguments.done", item_id: "i", call_id: "call_1", name: "openclaw_agent_consult", arguments: '{"question":"weather"}' });
      expect(onToolCall).toHaveBeenCalledWith({ itemId: "i", callId: "call_1", name: "openclaw_agent_consult", args: { question: "weather" } });

      b.submitToolResult("call_1", { status: "working" }, { willContinue: true });
      expect(socket.of("response.create")).toHaveLength(0);
      b.submitToolResult("call_1", "Sunny.");
      expect(socket.of("conversation.item.create").map((e) => e.item)).toEqual([
        { type: "function_call_output", call_id: "call_1", output: '{"status":"working"}' },
        { type: "function_call_output", call_id: "call_1", output: "Sunny." },
      ]);
      expect(socket.of("response.create")).toHaveLength(1);
    });

    it("surfaces a provider error without closing the session", async () => {
      const onError = vi.fn();
      const { b } = bridge({ onError });
      await b.connect();
      FakeSocket.last!.emit({ type: "error", error: { message: "rate limited" } });

      expect(onError.mock.calls[0][0].message).toBe("rate limited");
      expect(b.isConnected()).toBe(true);
    });

    it("does not report OpenAI's answer to a barge-in with nothing playing as a failure", async () => {
      const onError = vi.fn();
      const { b } = bridge({ onError });
      await b.connect();
      b.handleBargeIn();
      FakeSocket.last!.emit({
        type: "error",
        error: { type: "invalid_request_error", code: "response_cancel_not_active", message: "Cancellation failed: no active response found" },
      });

      expect(FakeSocket.last!.of("response.cancel")).toHaveLength(1);
      expect(onError).not.toHaveBeenCalled();
      expect(b.isConnected()).toBe(true);
    });

    it("ends the session at the proxy's grant and reports the seconds it really ran", async () => {
      const onClose = vi.fn();
      const { b, fetchImpl, timers, advance } = bridge({ onClose });
      await b.connect();

      const cap = timers.find((t) => t.ms === 600_000);
      expect(cap).toBeDefined();
      advance(600_000);
      cap!.fn();
      await Promise.resolve();

      expect(onClose).toHaveBeenCalledWith("allowance");
      expect(FakeSocket.last!.closedWith).toBe(1000);
      expect(b.isConnected()).toBe(false);
      const usage = fetchImpl.mock.calls.find(([url]) => url === `${PROXY}/realtime/usage`);
      expect(JSON.parse(String(usage?.[1]?.body))).toEqual({ session_id: "rt_1", seconds: 600 });
    });

    it("closes once, however often it is asked", async () => {
      const onClose = vi.fn();
      const { b, fetchImpl, advance } = bridge({ onClose });
      await b.connect();
      advance(42_400);
      await b.close();
      await b.close();

      expect(onClose).toHaveBeenCalledTimes(1);
      const reports = fetchImpl.mock.calls.filter(([url]) => url === `${PROXY}/realtime/usage`);
      expect(reports).toHaveLength(1);
      expect(JSON.parse(String(reports[0][1]?.body)).seconds).toBe(42);
    });

    it("fails at once when OpenAI drops the socket before it opens, and hands the minutes back once", async () => {
      class RefusedSocket extends FakeSocket {
        start() { this.onclose?.(); }
      }
      const fetchImpl = proxy();
      const timers: Array<{ fn: () => void; ms: number }> = [];
      const b = createClawboxRealtimeBridge(
        { providerConfig: CONFIG },
        {
          fetch: fetchImpl,
          WebSocket: RefusedSocket,
          setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
          clearTimeout: () => {},
        },
      );

      await expect(b.connect()).rejects.toThrow(/Could not open the realtime Talk connection/);
      await b.close();

      const reports = fetchImpl.mock.calls.filter(([url]) => url === `${PROXY}/realtime/usage`);
      expect(reports).toHaveLength(1);
      expect(JSON.parse(String(reports[0][1]?.body))).toEqual({ session_id: "rt_1", seconds: 0 });
      expect(FakeSocket.last!.closedWith).toBe(1000);
    });

    it("hands the minutes back when the session is closed while its secret is on the way", async () => {
      const answered = proxy();
      let answer!: () => void;
      const gate = new Promise<void>((resolve) => { answer = resolve; });
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/realtime/client_secrets")) await gate;
        return answered(url, init);
      });
      const { b } = bridge({}, fetchImpl);
      FakeSocket.last = null;

      const connecting = b.connect();
      await b.close();
      answer();
      await connecting;

      const reports = fetchImpl.mock.calls.filter(([url]) => url === `${PROXY}/realtime/usage`);
      expect(reports).toHaveLength(1);
      expect(JSON.parse(String(reports[0][1]?.body))).toEqual({ session_id: "rt_1", seconds: 0 });
      // Nothing was opened for a session nobody is waiting for.
      expect(FakeSocket.last).toBeNull();
    });

    it("reports once, and does not fail the connect, when closed while the socket is still opening", async () => {
      class PendingSocket extends FakeSocket {
        // Never answers the handshake. Closing a socket that is still opening
        // fires its close event, as a WHATWG WebSocket does.
        start() {}
        close(code: number) {
          super.close(code);
          this.onclose?.();
        }
      }
      const fetchImpl = proxy();
      const onClose = vi.fn();
      const timers: Array<{ fn: () => void; ms: number }> = [];
      const b = createClawboxRealtimeBridge(
        { providerConfig: CONFIG, onClose },
        {
          fetch: fetchImpl,
          WebSocket: PendingSocket,
          setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
          clearTimeout: () => {},
        },
      );
      FakeSocket.last = null;

      const connecting = b.connect();
      await vi.waitFor(() => expect(FakeSocket.last).toBeInstanceOf(PendingSocket));
      await b.close();
      await expect(connecting).resolves.toBeUndefined();

      const reports = fetchImpl.mock.calls.filter(([url]) => url === `${PROXY}/realtime/usage`);
      expect(reports).toHaveLength(1);
      expect(JSON.parse(String(reports[0][1]?.body))).toEqual({ session_id: "rt_1", seconds: 0 });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(b.isConnected()).toBe(false);
    });

    it("fails the connect with the proxy's sentence when the week's minutes are used up", async () => {
      const { b } = bridge({}, proxy(429, {}));
      FakeSocket.last = null;
      await expect(b.connect()).rejects.toThrow(/minutes are used up/);
      expect(FakeSocket.last).toBeNull();
    });
  });
});
