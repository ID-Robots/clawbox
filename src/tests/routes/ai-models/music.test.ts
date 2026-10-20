/**
 * /setup-api/ai-models/music — ClawBox AI music for the harness with no music
 * tool of its own (Hermes; OpenClaw makes music through its own tool).
 *
 * Pinned: the gate is the configure route's (the `music` media flag, a linked
 * and unrefused credential, the Max plan) and GET says which part is missing;
 * a track lands in the chat's media tree under a name of the box's choosing;
 * one track at a time; and every failure of the shared media route comes back
 * with the status the MCP tool turns into a next step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const mocks = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  tier: "pro" as string | null,
  refused: false,
  dir: "",
  generate: vi.fn(),
}));

vi.mock("@/lib/route-auth", () => ({ requireSession: async () => null }));
vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => mocks.store[key]),
}));
vi.mock("@/lib/clawai-plan-tier", () => ({
  readClawaiEntitlementTier: vi.fn(async () => mocks.tier),
}));
vi.mock("@/lib/clawai-credential-refusal", () => ({
  clawaiCredentialRefusalOnRecord: vi.fn(async () => mocks.refused),
}));
vi.mock("@/lib/clawai-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clawai-media")>()),
  generateClawaiMusic: mocks.generate,
}));
vi.mock("@/lib/harness/media-root", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness/media-root")>()),
  chatGeneratedMusicDir: async () => mocks.dir,
}));

import { ClawaiMediaError } from "@/lib/clawai-media";

const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64, 1)]);

let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let base: string;

const post = (body: unknown) =>
  POST(new Request("http://localhost/setup-api/ai-models/music", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

const get = () => GET(new Request("http://localhost/setup-api/ai-models/music"));

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "music-route-"));
  mocks.dir = path.join(base, "chat-music");
  mocks.store = { clawai_media_flags: ["music"], clawai_token: "claw_token" };
  mocks.tier = "pro";
  mocks.refused = false;
  mocks.generate.mockReset();
  mocks.generate.mockResolvedValue({ bytes: MP3, mime: "audio/mpeg", extension: ".mp3" });
  vi.resetModules();
  const mod = await import("@/app/setup-api/ai-models/music/route");
  GET = mod.GET;
  POST = mod.POST;
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("GET — may this box make music?", () => {
  it("says yes on a linked Max box with the flag on, with the weekly number", async () => {
    expect(await (await get()).json()).toEqual({ available: true, weeklyTracks: 10 });
  });

  it.each([
    ["flag_off", () => { mocks.store.clawai_media_flags = []; }],
    ["not_linked", () => { delete mocks.store.clawai_token; }],
    ["refused", () => { mocks.refused = true; }],
    ["not_max", () => { mocks.tier = "flash"; }],
    ["not_max", () => { mocks.tier = null; }],
  ])("says no, %s", async (reason, arrange) => {
    arrange();

    const body = await (await get()).json();

    expect(body.available).toBe(false);
    expect(body.reason).toBe(reason);
    expect(typeof body.error).toBe("string");
  });
});

describe("POST — make a track", () => {
  it("writes the track into the chat's music folder and says where", async () => {
    const res = await post({ prompt: "a sea shanty", lyrics: "yo ho", instrumental: false });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(path.dirname(body.path)).toBe(mocks.dir);
    expect(path.basename(body.path)).toMatch(/^track-\d+-[0-9a-f]{8}\.mp3$/);
    expect(fs.readFileSync(body.path).equals(MP3)).toBe(true);
    expect(body).toMatchObject({ mime: "audio/mpeg", bytes: MP3.length, weeklyTracks: 10 });
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({
      token: "claw_token",
      prompt: "a sea shanty",
      lyrics: "yo ho",
      instrumental: false,
    }));
  });

  it("sends neither lyrics nor the switch when they were not given", async () => {
    await post({ prompt: "rain on a tin roof" });

    const call = mocks.generate.mock.calls[0][0];
    expect(call).not.toHaveProperty("lyrics");
    expect(call).not.toHaveProperty("instrumental");
  });

  it.each([
    [{}, /Say what the track/],
    [{ prompt: "   " }, /Say what the track/],
    [{ prompt: "x".repeat(2_001) }, /too long/],
    [{ prompt: "ok", lyrics: 7 }, /Lyrics must be text/],
    [{ prompt: "ok", lyrics: "y".repeat(3_001) }, /lyrics are too long/],
    [{ prompt: "ok", instrumental: "yes" }, /true or false/],
  ])("refuses %j", async (body, message) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(message);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("refuses bad JSON", async () => {
    expect((await post("{nope")).status).toBe(400);
  });

  it("answers 409 with the reason when the box may not make music", async () => {
    mocks.tier = "free";

    const res = await post({ prompt: "jingle" });

    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("not_max");
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("makes one track at a time and tells the second caller the box is busy", async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.generate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));

    const first = post({ prompt: "one" });
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    const second = await post({ prompt: "two" });

    expect(second.status).toBe(429);
    expect((await second.json()).code).toBe("busy");
    finish({ bytes: MP3, mime: "audio/mpeg", extension: ".mp3" });
    expect((await first).status).toBe(200);
    // …and the slot is free again afterwards.
    expect((await post({ prompt: "three" })).status).toBe(200);
  });

  it.each([
    ["limit", 429, "music_limit"],
    ["refused", 403, "refused"],
    ["not_served", 503, "not_served"],
    ["failed", 502, "failed"],
    ["timeout", 504, "timeout"],
  ] as const)("maps a %s failure to %i", async (failure, status, code) => {
    mocks.generate.mockRejectedValueOnce(new ClawaiMediaError(failure, "nope", failure === "limit" ? "2026-10-27T09:00:00Z" : null));

    const res = await post({ prompt: "jingle" });

    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.code).toBe(code);
    if (failure === "limit") expect(body.resetAt).toBe("2026-10-27T09:00:00Z");
  });

  it("frees the slot after a failure too", async () => {
    mocks.generate.mockRejectedValueOnce(new ClawaiMediaError("failed", "nope"));
    await post({ prompt: "x" });

    expect((await post({ prompt: "y" })).status).toBe(200);
  });
});
