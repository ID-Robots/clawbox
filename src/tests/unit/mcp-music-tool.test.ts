/**
 * music_generate on the ClawBox MCP server (mcp/tools/ai.ts) — the music tool
 * Hermes does not have, and that an OpenClaw box must not get beside its own.
 *
 * Pinned: registered on Hermes only, and only where the device said music is
 * available; the client waits longer than the device's media job and less than
 * Hermes gives one tool call; every refusal keeps the device's reason; and a
 * finished track comes back as the `MEDIA:` line the chat plays.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { captureRegistrar } from "../helpers/mcp-registrar";
import { ApiError } from "../../../mcp/lib/errors";
import type { McpContext } from "../../../mcp/lib/context";
import { MUSIC_CALL_TIMEOUT_MS, registerAiTools } from "../../../mcp/tools/ai";
import { CLAWAI_MEDIA_JOB_BUDGET_MS } from "@/lib/clawai-media";

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));

// The real api() applies the caller's per-route rules before an ApiError
// escapes; the stub must too, or a mapped refusal would test nothing.
vi.mock("../../../mcp/lib/api", async () => {
  const { ApiError: Err, matchRule } = await import("../../../mcp/lib/errors");
  return {
    apiPost: async (route: string, body: unknown, options?: { rules?: Parameters<typeof matchRule>[1] }) => {
      try {
        return await apiPost(route, body, options);
      } catch (err) {
        if (err instanceof Err) throw matchRule(err, options?.rules) ?? err;
        throw err;
      }
    },
    apiGet: vi.fn(),
    apiTry: async () => null,
    API_BASE: "http://127.0.0.1:80",
    CLAWBOX_ROOT: "/home/clawbox/clawbox",
  };
});

const ctx = (edition: "openclaw" | "hermes", canGenerateMusic: boolean): McpContext => ({
  edition,
  install: edition,
  appHarness: edition,
  profile: "full",
  capabilities: { screenGrabber: null, imageConvert: false, journal: false, du: false },
  providers: [],
  emailCanRead: false,
  codingAgent: false,
  canGenerateImages: true,
  canGenerateMusic,
});

function aiTools(edition: "openclaw" | "hermes", canGenerateMusic: boolean) {
  const h = captureRegistrar(edition);
  registerAiTools(h.reg, ctx(edition, canGenerateMusic));
  return h;
}

beforeEach(() => {
  apiPost.mockReset();
});

describe("registration", () => {
  it("is offered on Hermes where the device said music is available", () => {
    expect(aiTools("hermes", true).names()).toContain("music_generate");
  });

  it("is not offered where the device said no", () => {
    expect(aiTools("hermes", false).names()).not.toContain("music_generate");
  });

  it("is never offered on OpenClaw, whose harness has its own music_generate", () => {
    expect(aiTools("openclaw", true).names()).not.toContain("music_generate");
  });
});

describe("timing", () => {
  it("waits longer than the device's media job, and less than Hermes gives a tool call", () => {
    const registration = fs.readFileSync(path.resolve(process.cwd(), "scripts/register-mcp.sh"), "utf-8");
    const seconds = Number(/"timeout":\s*(\d+)/.exec(registration)?.[1]);
    expect(seconds).toBeGreaterThan(0);
    expect(MUSIC_CALL_TIMEOUT_MS).toBeGreaterThan(CLAWAI_MEDIA_JOB_BUDGET_MS);
    expect(MUSIC_CALL_TIMEOUT_MS).toBeLessThan(seconds * 1000);
  });

  it("passes that timeout on the call it makes", async () => {
    apiPost.mockResolvedValue({ path: "/data/chat-media/chat-music/track-1.mp3", bytes: 2048, weeklyTracks: 10 });

    await aiTools("hermes", true).call("music_generate", { prompt: "lofi", instrumental: false });

    expect(apiPost).toHaveBeenCalledWith(
      "/setup-api/ai-models/music",
      { prompt: "lofi" },
      expect.objectContaining({ timeoutMs: MUSIC_CALL_TIMEOUT_MS }),
    );
  });
});

describe("a finished track", () => {
  it("comes back as the MEDIA line the chat plays", async () => {
    apiPost.mockResolvedValue({ path: "/data/chat-media/chat-music/track-1.mp3", bytes: 4096, weeklyTracks: 10 });

    const out = await aiTools("hermes", true).call("music_generate", { prompt: "sea shanty", lyrics: "yo ho", instrumental: true });

    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/^MEDIA:\/data\/chat-media\/chat-music\/track-1\.mp3$/m);
    expect(out.text).toContain("10 tracks a week");
    expect(apiPost.mock.calls[0][1]).toEqual({ prompt: "sea shanty", lyrics: "yo ho", instrumental: true });
  });

  it("is an error, not a success, when the device names no file", async () => {
    apiPost.mockResolvedValue({});

    const out = await aiTools("hermes", true).call("music_generate", { prompt: "x", instrumental: false });

    expect(out.isError).toBe(true);
  });
});

describe("refusals keep the device's reason", () => {
  it.each([
    [409, { reason: "not_max" }, /Max plan/],
    [409, { reason: "not_linked" }, /not linked/],
    [409, { reason: "refused" }, /refused this box's credential/],
    [409, { reason: "flag_off" }, /not switched on/],
    [429, { code: "busy" }, /already making a track/],
    [429, { code: "music_limit" }, /music allowance is used up/],
    [503, { code: "not_served" }, /does not serve music yet/],
    [504, { code: "timeout" }, /too long/],
    [502, { code: "failed" }, /could not make that track/],
  ])("%i %j", async (status, body, message) => {
    apiPost.mockRejectedValue(new ApiError(status, JSON.stringify({ error: "x", ...body })));

    const out = await aiTools("hermes", true).call("music_generate", { prompt: "jingle", instrumental: false });

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.message).toMatch(message);
    // One call: no refusal here is worth a second ask from the tool itself.
    expect(apiPost).toHaveBeenCalledTimes(1);
  });
});
