/**
 * The device half of the ClawBox AI proxy's shared media route
 * (src/lib/clawai-media.ts).
 *
 * Pinned: the wire contract the proxy is built against (the path under
 * `<proxy>/media`, the `Key` credential, the body), both answers it may give —
 * the result inline or a queue handle polled to COMPLETED — every refusal turned
 * into the failure that says what to do next, the token never leaving the
 * proxy's origin, and a file accepted only when its own bytes say it is audio.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CLAWAI_MEDIA_MAX_BYTES,
  CLAWAI_MUSIC_LIMIT_CODE,
  ClawaiMediaError,
  fetchClawaiMediaFile,
  generateClawaiMusic,
  runClawaiMediaJob,
  type ClawaiMediaDeps,
} from "@/lib/clawai-media";
import { parseClawaiAllowanceRefusal } from "@/lib/clawai-allowance";

const PROXY = "https://clawbox.com/api/ai";
const TOKEN = "claw_test_token";
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64, 1)]);
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(32)]);

type Call = { url: string; init: RequestInit };

/** A fetch that answers from a script, recording every call. */
function scripted(answers: Array<(call: Call) => Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const next = answers.shift();
    if (!next) throw new Error(`unexpected call to ${call.url}`);
    return next(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A clock the test moves, and a sleep that moves it. */
function clock(): Pick<ClawaiMediaDeps, "now" | "sleep"> {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

const dataUrl = (bytes: Buffer, mime = "audio/mpeg") => `data:${mime};base64,${bytes.toString("base64")}`;

async function failure(promise: Promise<unknown>): Promise<ClawaiMediaError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ClawaiMediaError);
    return err as ClawaiMediaError;
  }
  throw new Error("expected a ClawaiMediaError");
}

describe("runClawaiMediaJob — the wire contract", () => {
  it("posts the input to <proxy>/media/<model> with the Key credential", async () => {
    const { fetchImpl, calls } = scripted([json({ audio: { url: dataUrl(MP3) } })]);

    const result = await runClawaiMediaJob(
      { proxyUrl: `${PROXY}/`, token: TOKEN, model: "google/lyria-3-pro-preview", input: { prompt: "lofi" } },
      { fetchImpl, ...clock() },
    );

    expect(result).toEqual({ audio: { url: dataUrl(MP3) } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${PROXY}/media/google/lyria-3-pro-preview`);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Key ${TOKEN}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ prompt: "lofi" });
  });

  it("polls a queued job to COMPLETED and fetches its result", async () => {
    const { fetchImpl, calls } = scripted([
      json({ request_id: "r1", status_url: `${PROXY}/media/m/requests/r1/status`, response_url: `${PROXY}/media/m/requests/r1` }),
      json({ status: "IN_QUEUE" }),
      json({ status: "IN_PROGRESS" }),
      json({ status: "COMPLETED" }),
      json({ audio: { url: "https://storage.example.com/t.mp3" } }),
    ]);

    const result = await runClawaiMediaJob(
      { proxyUrl: PROXY, token: TOKEN, model: "m", input: { prompt: "p" } },
      { fetchImpl, ...clock() },
    );

    expect(result).toEqual({ audio: { url: "https://storage.example.com/t.mp3" } });
    expect(calls.map((c) => c.url)).toEqual([
      `${PROXY}/media/m`,
      `${PROXY}/media/m/requests/r1/status`,
      `${PROXY}/media/m/requests/r1/status`,
      `${PROXY}/media/m/requests/r1/status`,
      `${PROXY}/media/m/requests/r1`,
    ]);
    // Every poll carries the credential: it is the proxy being asked.
    for (const call of calls.slice(1)) {
      expect((call.init.headers as Record<string, string>).authorization).toBe(`Key ${TOKEN}`);
    }
  });

  it("derives the queue URLs from fal's layout when the handle names none", async () => {
    const { fetchImpl, calls } = scripted([
      json({ request_id: "abc" }),
      json({ status: "COMPLETED" }),
      json({ audio: { url: dataUrl(MP3) } }),
    ]);

    await runClawaiMediaJob({ proxyUrl: PROXY, token: TOKEN, model: "m", input: {} }, { fetchImpl, ...clock() });

    expect(calls[1].url).toBe(`${PROXY}/media/m/requests/abc/status`);
    expect(calls[2].url).toBe(`${PROXY}/media/m/requests/abc`);
  });

  it("never sends the token to a queue URL on another origin", async () => {
    const { fetchImpl, calls } = scripted([
      json({ request_id: "r1", status_url: "https://elsewhere.example.com/status", response_url: `${PROXY}/media/m/requests/r1` }),
    ]);

    const err = await failure(runClawaiMediaJob({ proxyUrl: PROXY, token: TOKEN, model: "m", input: {} }, { fetchImpl, ...clock() }));

    expect(err.failure).toBe("failed");
    expect(calls).toHaveLength(1);
  });

  it("reports a job the proxy failed", async () => {
    const { fetchImpl } = scripted([
      json({ request_id: "r1" }),
      json({ status: "FAILED", error: { message: "upstream refused the prompt" } }),
    ]);

    const err = await failure(runClawaiMediaJob({ proxyUrl: PROXY, token: TOKEN, model: "m", input: {} }, { fetchImpl, ...clock() }));

    expect(err.failure).toBe("failed");
    expect(err.message).toBe("upstream refused the prompt");
  });

  it("gives up as a timeout when the job outlives the budget", async () => {
    const answers = [json({ request_id: "r1" }), ...Array.from({ length: 50 }, () => json({ status: "IN_PROGRESS" }))];
    const { fetchImpl } = scripted(answers);

    const err = await failure(runClawaiMediaJob(
      { proxyUrl: PROXY, token: TOKEN, model: "m", input: {} },
      { fetchImpl, ...clock(), budgetMs: 20_000, pollMs: 5_000 },
    ));

    expect(err.failure).toBe("timeout");
  });

  it("turns a transport failure into a failure, not a throw of its own", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;

    const err = await failure(runClawaiMediaJob({ proxyUrl: PROXY, token: TOKEN, model: "m", input: {} }, { fetchImpl, ...clock() }));

    expect(err.failure).toBe("failed");
  });
});

describe("runClawaiMediaJob — refusals", () => {
  it.each([
    [401, "refused"],
    [403, "refused"],
    [404, "not_served"],
    [501, "not_served"],
    [500, "failed"],
    [502, "failed"],
  ])("answers %i as %s", async (status, expected) => {
    const { fetchImpl } = scripted([json({ error: { message: "no" } }, status)]);

    const err = await failure(runClawaiMediaJob({ proxyUrl: PROXY, token: TOKEN, model: "m", input: {} }, { fetchImpl, ...clock() }));

    expect(err.failure).toBe(expected);
  });

  it("reads a spent weekly cap, with its frees-up instant", async () => {
    const { fetchImpl } = scripted([json({
      error: { code: CLAWAI_MUSIC_LIMIT_CODE, message: "Weekly music allowance used up.", resetAt: "2026-10-27T09:00:00Z" },
    }, 429)]);

    const err = await failure(runClawaiMediaJob({ proxyUrl: PROXY, token: TOKEN, model: "m", input: {} }, { fetchImpl, ...clock() }));

    expect(err.failure).toBe("limit");
    expect(err.resetAt).toBe("2026-10-27T09:00:00Z");
    expect(err.message).toBe("Weekly music allowance used up.");
  });

  it("does not read some other 429 as the music cap", async () => {
    const { fetchImpl } = scripted([json({ error: { message: "slow down" } }, 429)]);

    const err = await failure(runClawaiMediaJob({ proxyUrl: PROXY, token: TOKEN, model: "m", input: {} }, { fetchImpl, ...clock() }));

    expect(err.failure).toBe("failed");
  });

  it("is never mistaken for the weekly CHAT allowance by the chat's reader", () => {
    // `_` is a word character, so `\bweekly_limit_exceeded\b` has no boundary
    // inside the music code — a music refusal quoted anywhere must not tell
    // the customer their chat allowance is spent.
    const raw = `429 {"error":{"code":"${CLAWAI_MUSIC_LIMIT_CODE}","message":"Weekly music allowance used up."}}`;
    expect(parseClawaiAllowanceRefusal(raw)).toBeNull();
  });
});

describe("fetchClawaiMediaFile", () => {
  it("decodes a data: URL and earns the format from the bytes", async () => {
    const file = await fetchClawaiMediaFile({ audio: { url: dataUrl(WAV, "audio/mpeg") } });

    // The header said mpeg; the bytes say WAV, and the bytes win.
    expect(file.extension).toBe(".wav");
    expect(file.mime).toBe("audio/wav");
    expect(file.bytes.equals(WAV)).toBe(true);
  });

  it("downloads an https link WITHOUT the portal token and without following redirects", async () => {
    const { fetchImpl, calls } = scripted([() => new Response(MP3, { status: 200 })]);

    const file = await fetchClawaiMediaFile({ audio_file: { url: "https://storage.example.com/t.mp3" } }, { fetchImpl, ...clock() });

    expect(file.extension).toBe(".mp3");
    expect(calls[0].init.headers).toBeUndefined();
    expect(calls[0].init.redirect).toBe("error");
  });

  it.each([
    ["http://storage.example.com/t.mp3"],
    ["file:///etc/passwd"],
    ["/home/clawbox/t.mp3"],
  ])("refuses %s", async (url) => {
    const { fetchImpl, calls } = scripted([]);

    const err = await failure(fetchClawaiMediaFile({ audio: { url } }, { fetchImpl, ...clock() }));

    expect(err.failure).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  it("refuses a file that is not audio, whatever it is called", async () => {
    const err = await failure(fetchClawaiMediaFile({ audio: { url: dataUrl(Buffer.from("<html>not a song</html>")) } }));

    expect(err.message).toMatch(/not audio/);
  });

  it("refuses a file larger than the cap, before reading it when the length is declared", async () => {
    const { fetchImpl } = scripted([() => new Response(MP3, {
      status: 200,
      headers: { "content-length": String(CLAWAI_MEDIA_MAX_BYTES + 1) },
    })]);

    const err = await failure(fetchClawaiMediaFile({ audio_url: "https://storage.example.com/t.mp3" }, { fetchImpl, ...clock() }));

    expect(err.message).toMatch(/larger/);
  });

  it("says so when a finished job names no file", async () => {
    const err = await failure(fetchClawaiMediaFile({ text: "done" }));

    expect(err.message).toMatch(/named no audio file/);
  });
});

describe("generateClawaiMusic", () => {
  it("asks for Lyria 3 Pro with the prompt, the lyrics and the instrumental switch", async () => {
    const { fetchImpl, calls } = scripted([json({ audio: { url: dataUrl(MP3) } })]);

    const track = await generateClawaiMusic(
      { proxyUrl: PROXY, token: TOKEN, prompt: "sea shanty", lyrics: "yo ho", instrumental: false },
      { fetchImpl, ...clock() },
    );

    expect(track.extension).toBe(".mp3");
    expect(calls[0].url).toBe(`${PROXY}/media/google/lyria-3-pro-preview`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ prompt: "sea shanty", lyrics: "yo ho", instrumental: false });
  });

  it("sends only what was asked for", async () => {
    const { fetchImpl, calls } = scripted([json({ audio: { url: dataUrl(MP3) } })]);

    await generateClawaiMusic({ proxyUrl: PROXY, token: TOKEN, prompt: "rain" }, { fetchImpl, ...clock() });

    expect(JSON.parse(String(calls[0].init.body))).toEqual({ prompt: "rain" });
  });
});
