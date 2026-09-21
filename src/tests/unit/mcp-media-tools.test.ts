/**
 * The two media tools a delegated run gets (mcp/tools/media.ts).
 *
 * They are the only tools on this server that make the DEVICE spend something
 * on the agent's say-so — a picture out of the owner's daily allowance, a
 * cloud voice billed per character — so what is pinned here is everything that
 * keeps a small model from spending it twice:
 *
 *   - the client waits LONGER than the backend, or it pays for an answer it
 *     discards and asks the same question again;
 *   - a spent allowance and a busy voice come back as CONFLICT with "carry on
 *     without", never as a retryable outage;
 *   - every success says how many are left, which is what stops the loop
 *     before the per-run cap has to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "../helpers/env";
import { captureRegistrar, type CaptureHarness } from "../helpers/mcp-registrar";
import { ApiError } from "../../../mcp/lib/errors";
import { AUDIO_CALL_TIMEOUT_MS, IMAGE_CALL_TIMEOUT_MS, registerMediaTools } from "../../../mcp/tools/media";

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

let base: string;
let workingDir: string;
let restore: () => void;

function mediaTools(): CaptureHarness {
  const h = captureRegistrar("openclaw");
  registerMediaTools(h.reg);
  return h;
}

/** The one apiPost call to `route`, as [body, options]. */
function postTo(route: string) {
  const calls = apiPost.mock.calls.filter(([r]) => r === route);
  expect(calls).toHaveLength(1);
  return [calls[0][1], calls[0][2]] as [Record<string, unknown>, { timeoutMs?: number } | undefined];
}

beforeEach(() => {
  restore = saveEnv("CLAWBOX_RUN_DIR", "CLAWBOX_RUN_ARTIFACTS_DIR", "CLAWBOX_RUN_MEDIA");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-media-"));
  workingDir = path.join(base, "work");
  process.env.CLAWBOX_RUN_DIR = workingDir;
  process.env.CLAWBOX_RUN_ARTIFACTS_DIR = path.join(base, "evidence");
  process.env.CLAWBOX_RUN_MEDIA = "images,audio";
  apiPost.mockReset();
  apiPost.mockImplementation(async (route: string) =>
    route.endsWith("/image")
      ? { path: path.join(workingDir, "assets", "hero.png"), bytes: 831_000, used: 3, cap: 20 }
      : { path: path.join(workingDir, "intro.wav"), bytes: 96_000, used: 1, cap: 40, engine: "local" },
  );
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("when they exist at all", () => {
  it("registers nothing outside a run, whatever the media variable says", () => {
    // A tool that existed on the assistant's own server would answer "no run"
    // forever, which on Hermes is a per-server circuit breaker waiting to trip.
    delete process.env.CLAWBOX_RUN_DIR;
    expect(mediaTools().names()).toEqual([]);
  });

  it("registers one tool per switch, and none when the runner named neither", () => {
    process.env.CLAWBOX_RUN_MEDIA = "images";
    expect(mediaTools().names()).toEqual(["generate_image"]);
    process.env.CLAWBOX_RUN_MEDIA = "audio";
    expect(mediaTools().names()).toEqual(["generate_audio"]);
    delete process.env.CLAWBOX_RUN_MEDIA;
    expect(mediaTools().names()).toEqual([]);
  });
});

describe("waiting longer than the backend", () => {
  it("gives each call more time than the device's own budget for it", () => {
    // 120 s upstream for a picture, 90 s for the local voice — plus the
    // box-wide queue each of them may sit in before its turn.
    expect(IMAGE_CALL_TIMEOUT_MS).toBeGreaterThan(120_000);
    expect(AUDIO_CALL_TIMEOUT_MS).toBeGreaterThan(90_000);
    void mediaTools();
  });

  it("passes that timeout on the call it actually makes", async () => {
    const h = mediaTools();
    await h.call("generate_image", { prompt: "a crab", path: "assets/hero.png", size: "1024" });
    expect(postTo("/setup-api/coding-agent/media/image")[1]?.timeoutMs).toBe(IMAGE_CALL_TIMEOUT_MS);
    apiPost.mockClear();
    await h.call("generate_audio", { text: "Hello", path: "intro.wav" });
    expect(postTo("/setup-api/coding-agent/media/audio")[1]?.timeoutMs).toBe(AUDIO_CALL_TIMEOUT_MS);
  });
});

describe("what the run is told", () => {
  it("resolves a relative path against the working folder and says what it wrote", async () => {
    const h = mediaTools();
    const out = await h.call("generate_image", { prompt: "a crab", path: "assets/hero.png", size: "512" });
    expect(out.isError).toBe(false);
    const [body] = postTo("/setup-api/coding-agent/media/image");
    expect(body.path).toBe(path.join(workingDir, "assets", "hero.png"));
    expect(body.size).toBe("512");
    if (out.isError) throw new Error("unreachable");
    // The budget, on every success: a model that cannot see what it has spent
    // keeps asking until the cap answers for it.
    expect(out.text).toContain("3 of 20 pictures used");
    expect(out.text).toContain("assets/hero.png");
  });

  it("names the engine that spoke, so the run can report which voice it used", async () => {
    const h = mediaTools();
    const out = await h.call("generate_audio", { text: "Hello", path: "intro.wav" });
    if (out.isError) throw new Error("unreachable");
    expect(out.text).toContain("local");
    expect(out.text).toContain("1 of 40 clips used");
  });

  it("refuses a path outside the run's folders before it asks the device", async () => {
    const h = mediaTools();
    const out = await h.call("generate_image", { prompt: "x", path: "/etc/hero.png" });
    expect(out.isError).toBe(true);
    if (!out.isError) throw new Error("unreachable");
    expect(out.error.code).toBe("BLOCKED_PATH");
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe("what a refusal tells it to do next", () => {
  it("reads a spent allowance as a conflict to stop at, not an outage to retry", async () => {
    apiPost.mockRejectedValue(new ApiError(429, JSON.stringify({ error: "used up today", code: "bad_request" })));
    const h = mediaTools();
    const out = await h.call("generate_image", { prompt: "x", path: "hero.png" });
    expect(out.isError).toBe(true);
    if (!out.isError) throw new Error("unreachable");
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.next).toMatch(/do not retry/i);
  });

  it("reads an unlinked box as a reason to stop asking for the rest of the run", async () => {
    apiPost.mockRejectedValue(new ApiError(503, JSON.stringify({ error: "not linked", code: "bad_request" })));
    const h = mediaTools();
    const out = await h.call("generate_audio", { text: "x", path: "a.wav" });
    if (!out.isError) throw new Error("unreachable");
    expect(out.error.code).toBe("ENDPOINT_DOWN");
    expect(out.error.next).toMatch(/do not call this tool again/i);
  });

  it("reads the device's own fence as a blocked path", async () => {
    apiPost.mockRejectedValue(new ApiError(403, JSON.stringify({ error: "outside", code: "outside" })));
    const h = mediaTools();
    const out = await h.call("generate_image", { prompt: "x", path: "hero.png" });
    if (!out.isError) throw new Error("unreachable");
    expect(out.error.code).toBe("BLOCKED_PATH");
  });

  it("reads a switch that is off, a spent cap and a taken name as one conflict", async () => {
    apiPost.mockRejectedValue(new ApiError(409, JSON.stringify({ error: "switched off", code: "switched_off" })));
    const h = mediaTools();
    const out = await h.call("generate_image", { prompt: "x", path: "hero.png" });
    if (!out.isError) throw new Error("unreachable");
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.next).toMatch(/one different file name at most/i);
  });
});

describe("the tool contract", () => {
  it("declares the run family, so only a delegated run's server registers them", () => {
    const h = mediaTools();
    for (const name of ["generate_image", "generate_audio"]) {
      expect(h.get(name).opts.family).toBe("browser");
      expect(h.get(name).opts.readOnly).not.toBe(true);
    }
  });

  it("tells the run not to draw the project's own icon", () => {
    // The box draws it (src/lib/project-icon.ts) and places it with a
    // never-overwrite write, so a run that drew its own would have paid for a
    // picture it cannot place.
    expect(mediaTools().get("generate_image").description).toMatch(/icon or favicon/i);
  });
});
