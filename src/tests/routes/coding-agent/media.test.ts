/**
 * POST /setup-api/coding-agent/media/image and …/audio — the two routes that
 * let a delegated run put a real picture and a real recording into its project.
 *
 * They are the only routes on this box that spend the owner's ClawBox AI
 * allowance and the box's voice on the AGENT's say-so, and their only caller
 * holds the MCP bearer — which a run can read off disk and which a
 * prompt-injected run holds too. So what is pinned here is the fence, in every
 * shape it has to hold: no live run, a switch the owner turned off, the per-run
 * cap, a path outside the two folders, a symlink planted inside one of them
 * that leads out, an extension the caller chose, and a name already taken.
 *
 * The generator and the voice are mocked: this is about who may write where,
 * not about what a picture looks like.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/route-auth", () => ({ requireSession }));

const activeRunMedia = vi.hoisted(() => vi.fn());
const noteRunMedia = vi.hoisted(() => vi.fn());
const reserveRunMedia = vi.hoisted(() => vi.fn());
const releaseRunMedia = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-agent")>()),
  activeRunMedia,
  noteRunMedia,
  reserveRunMedia,
  releaseRunMedia,
}));

const generateClawaiImageBytes = vi.hoisted(() => vi.fn());
class FakeImageError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
vi.mock("@/lib/harness/clawai-images", () => ({
  generateClawaiImageBytes,
  ClawaiImageError: FakeImageError,
}));

// The one upstream slot, stubbed to a pass-through: its serialisation is
// webapp-icon's own test, and holding it here would only make this file slow.
// `slotBusy` is how this file asks for the one answer the pass-through cannot
// give — the queue already as deep as the route lets it get.
const FakeSlotBusy = vi.hoisted(() => class extends Error {});
const slotBusy = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/webapp-icon", () => ({
  GenerationSlotBusy: FakeSlotBusy,
  withGenerationSlot: <T,>(fn: () => Promise<T>) => {
    if (slotBusy.on) throw new FakeSlotBusy("queue full");
    return fn();
  },
}));

const speakReply = vi.hoisted(() => vi.fn());
vi.mock("@/lib/voice-speak", () => ({
  speakReply,
  withSpeechQueue: (fn: () => Promise<Response>) => fn(),
}));

// A one-pixel PNG's signature is all the routes look at; sharp is left alone
// (it re-encodes to a real PNG on the box, and to nothing here if it cannot
// load — both of which the route already treats as fine).
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64, 7)]);
// A real RIFF/WAVE header, because the route now refuses bytes whose container
// does not match the name it was asked to write.
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 0), Buffer.from("WAVE"), Buffer.alloc(4096, 3)]);

const RUN_ID = "run-abc12345";
let base: string;
let workingDir: string;
let evidenceDir: string;
let restore: () => void;
let postImage: (req: Request) => Promise<Response>;
let postAudio: (req: Request) => Promise<Response>;

function body(payload: Record<string, unknown>, kind: "image" | "audio"): Request {
  return new Request(`http://localhost/setup-api/coding-agent/media/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** The caps coding-agent keeps; the reservation below is judged against them. */
const CAPS = { images: 20, audio: 40 } as const;

/** The live run's own two counters, moved by the reservation and handed back
 *  by the release — REAL here rather than a frozen number, because "two
 *  overlapping calls cannot both take the last slot" is a property of the
 *  counter moving before the money is spent, and a constant cannot show it. */
let generated: { images: number; audio: number };

/** The live run these routes fence to, with both switches on and nothing spent. */
function liveRun(over: {
  media?: { images: boolean; audio: boolean };
  generated?: { images: number; audio: number };
} = {}) {
  const media = over.media ?? { images: true, audio: true };
  generated = { ...(over.generated ?? { images: 0, audio: 0 }) };
  activeRunMedia.mockImplementation(() => ({
    id: RUN_ID,
    directory: workingDir,
    media,
    generated: { ...generated },
  }));
  reserveRunMedia.mockImplementation((_id: string, kind: "images" | "audio") => {
    const cap = CAPS[kind];
    if (generated[kind] >= cap) return { ok: false, reason: "cap", used: generated[kind], cap };
    generated[kind] += 1;
    return { ok: true, used: generated[kind], cap };
  });
  releaseRunMedia.mockImplementation((_id: string, kind: "images" | "audio") => {
    generated[kind] -= 1;
  });
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-media-"));
  const root = path.join(base, "clawbox");
  workingDir = path.join(base, "Projects", "site");
  evidenceDir = path.join(root, "data", "coding-agent-artifacts", RUN_ID);
  fs.mkdirSync(workingDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  process.env.HOME = base;
  process.env.CLAWBOX_ROOT = root;

  requireSession.mockReset().mockResolvedValue(null);
  slotBusy.on = false;
  activeRunMedia.mockReset();
  noteRunMedia.mockReset();
  reserveRunMedia.mockReset();
  releaseRunMedia.mockReset();
  generateClawaiImageBytes.mockReset().mockResolvedValue({ bytes: PNG, extension: "png" });
  speakReply.mockReset().mockResolvedValue(
    new Response(new Uint8Array(WAV), { headers: { "Content-Type": "audio/wav", "X-ClawBox-Voice-Engine": "local" } }),
  );

  vi.resetModules();
  postImage = (await import("@/app/setup-api/coding-agent/media/image/route")).POST;
  postAudio = (await import("@/app/setup-api/coding-agent/media/audio/route")).POST;
  liveRun();
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("who may ask at all", () => {
  it("refuses when no run is live — this is a run's tool, not the agent's", async () => {
    activeRunMedia.mockReturnValue(null);
    const res = await postImage(body({ path: "hero.png", prompt: "a crab" }, "image"));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("no_run");
    expect(generateClawaiImageBytes).not.toHaveBeenCalled();
  });

  it("refuses each kind on its own switch, and spends nothing doing so", async () => {
    liveRun({ media: { images: false, audio: true } });
    const picture = await postImage(body({ path: "hero.png", prompt: "a crab" }, "image"));
    expect(picture.status).toBe(409);
    expect((await picture.json()).code).toBe("switched_off");
    expect(generateClawaiImageBytes).not.toHaveBeenCalled();
    // The other switch is still on, so the other route still works.
    const clip = await postAudio(body({ path: "intro.wav", text: "Hello" }, "audio"));
    expect(clip.status).toBe(200);
  });

  it("refuses past the per-run cap, and says how far the run got", async () => {
    liveRun({ generated: { images: 20, audio: 0 } });
    const res = await postImage(body({ path: "hero.png", prompt: "a crab" }, "image"));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("cap");
    expect(json.used).toBe(20);
    expect(generateClawaiImageBytes).not.toHaveBeenCalled();
  });

  it("passes the session check on to the shared helper", async () => {
    requireSession.mockResolvedValue(new Response("no", { status: 401 }));
    expect((await postImage(body({ path: "hero.png", prompt: "x" }, "image"))).status).toBe(401);
  });
});

describe("where it may write", () => {
  it("writes a relative path inside the working folder, and records it against the run", async () => {
    fs.mkdirSync(path.join(workingDir, "assets"));
    const res = await postImage(body({ path: "assets/hero.png", prompt: "a crab" }, "image"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.path).toBe(path.join(fs.realpathSync(workingDir), "assets", "hero.png"));
    expect(fs.existsSync(json.path)).toBe(true);
    expect(noteRunMedia).toHaveBeenCalledWith(RUN_ID, json.path);
    // Nothing is left behind by the temp-and-rename write.
    expect(fs.readdirSync(path.join(workingDir, "assets"))).toEqual(["hero.png"]);
  });

  it("writes into the evidence folder too — the run's other own place", async () => {
    const res = await postAudio(body({ path: path.join(evidenceDir, "note.wav"), text: "Hello" }, "audio"));
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(evidenceDir, "note.wav"))).toBe(true);
  });

  it("refuses a path outside both folders, however it is spelled", async () => {
    for (const target of ["../escape.png", path.join(base, "escape.png"), "/etc/escape.png"]) {
      const res = await postImage(body({ path: target, prompt: "x" }, "image"));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("outside");
    }
    expect(generateClawaiImageBytes).not.toHaveBeenCalled();
  });

  it("refuses a symlink planted inside the run's own folder that leads out of it", async () => {
    // The typed path is inside the folder; only the resolved parent is not.
    const outside = path.join(base, "elsewhere");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workingDir, "link"));
    const res = await postImage(body({ path: "link/hero.png", prompt: "x" }, "image"));
    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(outside, "hero.png"))).toBe(false);
  });

  it("lets the ROUTE choose the extension, never the caller", async () => {
    // A caller that could name report.md would be choosing what the artifacts
    // route and the app serve those bytes as.
    const res = await postImage(body({ path: "report.md", prompt: "x" }, "image"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("bad_extension");
    expect((await postAudio(body({ path: "intro.png", text: "hi" }, "audio"))).status).toBe(400);
  });

  it("never replaces a file the run already wrote, unless asked to", async () => {
    fs.writeFileSync(path.join(workingDir, "hero.png"), "mine");
    const res = await postImage(body({ path: "hero.png", prompt: "x" }, "image"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("exists");
    expect(fs.readFileSync(path.join(workingDir, "hero.png"), "utf-8")).toBe("mine");
    const forced = await postImage(body({ path: "hero.png", prompt: "x", overwrite: true }, "image"));
    expect(forced.status).toBe(200);
    expect(fs.readFileSync(path.join(workingDir, "hero.png"), "utf-8")).not.toBe("mine");
  });
});

describe("what the far side answers", () => {
  it("relays a spent allowance as the status the image module chose", async () => {
    generateClawaiImageBytes.mockRejectedValue(new FakeImageError(429, "You have used up today's ClawBox AI pictures."));
    const res = await postImage(body({ path: "hero.png", prompt: "x" }, "image"));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.code).toBe("allowance");
    expect(json.error).toMatch(/used up today/);
    expect(fs.existsSync(path.join(workingDir, "hero.png"))).toBe(false);
  });

  it("relays an unlinked box as 503 without writing anything", async () => {
    generateClawaiImageBytes.mockRejectedValue(new FakeImageError(503, "This ClawBox is not linked to ClawBox AI yet."));
    const res = await postImage(body({ path: "hero.png", prompt: "x" }, "image"));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("not_linked");
  });

  it("relays the voice's own refusal, code and numbers intact", async () => {
    // The memory guard is a fact about the box at this moment, and the run is
    // told exactly that rather than "could not speak".
    speakReply.mockResolvedValue(
      Response.json(
        { error: "The box is short of memory for its voice right now (2.4 GB free, needs 3 GB).", code: "local_memory", available: "2.4", needed: "3" },
        { status: 502 },
      ),
    );
    const res = await postAudio(body({ path: "intro.wav", text: "Hello" }, "audio"));
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.code).toBe("local_memory");
    expect(json.available).toBe("2.4");
    expect(fs.existsSync(path.join(workingDir, "intro.wav"))).toBe(false);
    expect(noteRunMedia).not.toHaveBeenCalled();
  });

  it("names the engine that spoke, so the run can say which voice it used", async () => {
    const res = await postAudio(body({ path: "intro.wav", text: "Hello" }, "audio"));
    const json = await res.json();
    expect(json.engine).toBe("local");
    expect(json.bytes).toBe(WAV.length);
    expect(json.used).toBe(1);
  });

  it("refuses to put a name on the file that its bytes do not earn", async () => {
    // A Hermes box speaks through its own harness, which may answer MP3. The
    // .wav the run asked for would be a lie the next thing to open the file
    // believes, so nothing is written and the run is told what to ask for.
    const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(4096, 9)]);
    speakReply.mockResolvedValueOnce(
      new Response(new Uint8Array(mp3), { headers: { "Content-Type": "audio/mpeg", "X-ClawBox-Voice-Engine": "local" } }),
    );
    const res = await postAudio(body({ path: "intro.wav", text: "Hello" }, "audio"));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("format");
    expect(json.extension).toBe(".mp3");
    expect(fs.existsSync(path.join(workingDir, "intro.wav"))).toBe(false);
    expect(noteRunMedia).not.toHaveBeenCalled();
  });

  it("writes the file when the run asks for the name the voice actually answers in", async () => {
    const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(4096, 9)]);
    speakReply.mockResolvedValueOnce(
      new Response(new Uint8Array(mp3), { headers: { "Content-Type": "audio/mpeg", "X-ClawBox-Voice-Engine": "local" } }),
    );
    const res = await postAudio(body({ path: "intro.mp3", text: "Hello" }, "audio"));
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(workingDir, "intro.mp3"))).toBe(true);
  });

  it("refuses an empty prompt or an empty line before it spends anything", async () => {
    expect((await postImage(body({ path: "hero.png", prompt: "   " }, "image"))).status).toBe(400);
    expect((await postAudio(body({ path: "intro.wav", text: "" }, "audio"))).status).toBe(400);
    expect(generateClawaiImageBytes).not.toHaveBeenCalled();
    expect(speakReply).not.toHaveBeenCalled();
  });
});

/**
 * The per-run cap is a promise about the owner's money, and it used to be
 * checked against a snapshot and only moved once the bytes came back. Between
 * those two moments sit an upstream picture and a queued voice — seconds of
 * it — so two calls that overlapped both passed a gate with room for one.
 */
describe("the slot a call holds", () => {
  it("hands the slot back when nothing was written, so a failure costs the run nothing", async () => {
    generateClawaiImageBytes.mockRejectedValue(new FakeImageError(502, "The picture service is down."));
    expect((await postImage(body({ path: "hero.png", prompt: "x" }, "image"))).status).toBe(502);
    expect(generated.images).toBe(0);
    expect(releaseRunMedia).toHaveBeenCalledWith(RUN_ID, "images");
  });

  it("hands a clip's slot back when the voice refused", async () => {
    speakReply.mockResolvedValue(Response.json({ error: "busy", code: "busy" }, { status: 429 }));
    expect((await postAudio(body({ path: "intro.wav", text: "Hello" }, "audio"))).status).toBe(429);
    expect(generated.audio).toBe(0);
  });

  it("hands the slot back when the voice answered a format the name cannot carry", async () => {
    const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(4096, 9)]);
    speakReply.mockResolvedValue(
      new Response(new Uint8Array(mp3), { headers: { "Content-Type": "audio/mpeg" } }),
    );
    expect((await postAudio(body({ path: "intro.wav", text: "Hello" }, "audio"))).status).toBe(409);
    expect(generated.audio).toBe(0);
  });

  it("lets only one of two overlapping calls take the last picture", async () => {
    liveRun({ generated: { images: CAPS.images - 1, audio: 0 } });
    // A generator that does not answer at once is the whole point: the second
    // request reaches the counter while the first is still upstream.
    generateClawaiImageBytes.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ bytes: PNG, extension: "png" }), 5)),
    );
    const [first, second] = await Promise.all([
      postImage(body({ path: "one.png", prompt: "x" }, "image")),
      postImage(body({ path: "two.png", prompt: "x" }, "image")),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const refused = first.status === 409 ? first : second;
    expect((await refused.json()).code).toBe("cap");
    expect(generated.images).toBe(CAPS.images);
  });

  it("tells a run to come back later rather than queueing it behind the drawing", async () => {
    slotBusy.on = true;
    const res = await postImage(body({ path: "hero.png", prompt: "x" }, "image"));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("busy");
    // Refused before the slot was spent, so the run still has all of them.
    expect(generated.images).toBe(0);
  });
});

describe("what the run is told back", () => {
  it("refuses a body that is not an object, rather than throwing a 500 at the caller", async () => {
    const post = (kind: "image" | "audio", raw: string) =>
      (kind === "image" ? postImage : postAudio)(
        new Request(`http://localhost/setup-api/coding-agent/media/${kind}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: raw,
        }),
      );
    for (const raw of ["null", "[]", "7"]) {
      expect((await post("image", raw)).status).toBe(400);
      expect((await post("audio", raw)).status).toBe(400);
    }
    expect(generateClawaiImageBytes).not.toHaveBeenCalled();
    expect(speakReply).not.toHaveBeenCalled();
  });

  it("treats a size every object inherits as no size at all", async () => {
    // `in` answered for "constructor", and the pixel count became a function.
    const res = await postImage(body({ path: "hero.png", prompt: "x", size: "constructor" }, "image"));
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(workingDir, "hero.png"))).toBe(true);
  });

  it("never names a size it did not produce", async () => {
    // These bytes carry a PNG signature and nothing else, so sharp refuses
    // them and the picture is written through untouched — which is deliberate,
    // but a reply that still said "512" would have the run building its page
    // around a number nothing made.
    const res = await postImage(body({ path: "hero.png", prompt: "x", size: "512" }, "image"));
    expect(res.status).toBe(200);
    expect((await res.json()).size).toBeNull();
  });
});
