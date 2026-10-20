/**
 * describe_video on the ClawBox MCP server (mcp/tools/browser.ts) — video
 * understanding by frames on the vision model the box already uses.
 *
 * Pinned: registered only where the device said the `video_frames` flag is on;
 * the client waits longer than the device's sampling plus its vision call and
 * less than Hermes gives one tool call; a run is held to its own folders; and
 * a refusal keeps a next step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "../helpers/env";
import { captureRegistrar } from "../helpers/mcp-registrar";
import { ApiError } from "../../../mcp/lib/errors";
import { DESCRIBE_VIDEO_CALL_TIMEOUT_MS, registerBrowserTools } from "../../../mcp/tools/browser";

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));

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

let restore: () => void;
let base: string;

function browser(canDescribeVideo?: boolean) {
  const h = captureRegistrar("hermes");
  registerBrowserTools(h.reg, canDescribeVideo === undefined ? undefined : { canDescribeVideo });
  return h;
}

beforeEach(() => {
  restore = saveEnv("CLAWBOX_RUN_DIR", "CLAWBOX_RUN_ARTIFACTS_DIR");
  delete process.env.CLAWBOX_RUN_DIR;
  delete process.env.CLAWBOX_RUN_ARTIFACTS_DIR;
  base = fs.mkdtempSync(path.join(os.tmpdir(), "describe-video-"));
  apiPost.mockReset();
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("registration", () => {
  it("exists where the device said video frames are on", () => {
    expect(browser(true).names()).toContain("describe_video");
  });

  it.each([[false], [undefined]])("does not exist otherwise (%s)", (flag) => {
    const h = browser(flag);
    expect(h.names()).not.toContain("describe_video");
    // …and describe_image is untouched either way.
    expect(h.names()).toContain("describe_image");
  });
});

describe("the call", () => {
  it("waits above the device's own work and inside Hermes' tool budget", () => {
    const registration = fs.readFileSync(path.resolve(process.cwd(), "scripts/register-mcp.sh"), "utf-8");
    const seconds = Number(/"timeout":\s*(\d+)/.exec(registration)?.[1]);
    // The route's vision budget alone is 90 s; sampling comes on top.
    expect(DESCRIBE_VIDEO_CALL_TIMEOUT_MS).toBeGreaterThan(90_000);
    expect(DESCRIBE_VIDEO_CALL_TIMEOUT_MS).toBeLessThan(seconds * 1000);
  });

  it("asks the route with the path, the frame count and the question", async () => {
    apiPost.mockResolvedValue({ description: "a cat jumps onto a table", frames: [1.5, 4.5], durationSeconds: 6 });

    const out = await browser(true).call("describe_video", { path: "/home/clawbox/clip.mp4", frames: 2, prompt: "is there a cat?" });

    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain("a cat jumps onto a table");
    expect(out.text).toContain("From 2 frames at 1.5s, 4.5s");
    expect(apiPost).toHaveBeenCalledWith(
      "/setup-api/vision/describe-video",
      { path: "/home/clawbox/clip.mp4", frames: 2, prompt: "is there a cat?" },
      expect.objectContaining({ timeoutMs: DESCRIBE_VIDEO_CALL_TIMEOUT_MS }),
    );
  });

  it("holds a run to its own folders before asking", async () => {
    process.env.CLAWBOX_RUN_DIR = path.join(base, "work");
    process.env.CLAWBOX_RUN_ARTIFACTS_DIR = path.join(base, "artifacts", "run-ab12cd34");

    const out = await browser(true).call("describe_video", { path: "/etc/clip.mp4", frames: 6 });

    expect(out.isError).toBe(true);
    if (!out.isError) expect.fail("expected a refusal");
    expect(out.error.code).toBe("BLOCKED_PATH");
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("names the run, so the route fences on it", async () => {
    process.env.CLAWBOX_RUN_DIR = path.join(base, "work");
    process.env.CLAWBOX_RUN_ARTIFACTS_DIR = path.join(base, "artifacts", "run-ab12cd34");
    apiPost.mockResolvedValue({ description: "ok", frames: [0] });

    await browser(true).call("describe_video", { path: "clip.webm", frames: 1 });

    expect(apiPost.mock.calls[0][1]).toEqual({
      path: path.join(base, "work", "clip.webm"),
      frames: 1,
      codingRunId: "run-ab12cd34",
    });
  });

  it("turns the flag being off into a plain refusal", async () => {
    apiPost.mockRejectedValue(new ApiError(409, JSON.stringify({ error: "off" })));

    const out = await browser(true).call("describe_video", { path: "/home/clawbox/clip.mp4", frames: 6 });

    expect(out.isError).toBe(true);
    if (out.isError) expect(out.error.code).toBe("CONFLICT");
  });

  it("reports a description that did not come back", async () => {
    apiPost.mockResolvedValue({ description: null, error: "No frame could be read from that file" });

    const out = await browser(true).call("describe_video", { path: "/home/clawbox/clip.mp4", frames: 6 });

    expect(out.isError).toBe(true);
    if (out.isError) expect(out.error.message).toContain("No frame could be read");
  });
});
