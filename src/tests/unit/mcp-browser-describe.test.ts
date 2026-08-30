/**
 * The described calls of the browser family (mcp/tools/browser.ts).
 *
 * Two promises. The client waits LONGER than the backend: a describe_image
 * call, and any browser call carrying describe:true, is given a timeout
 * above vision-describe's whole budget — a client that gives up first pays
 * for an answer it discards and then asks again, which is the double-fire
 * describe_image had at apiPost's 8 s default. And describe_image is ONE
 * call: the backend owns the retry now, so the tool never re-fires on its
 * own, not on a refusal and not on a failed description.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "../helpers/env";
import { captureRegistrar, type CaptureHarness } from "../helpers/mcp-registrar";
import { DESCRIBE_TIMEOUT_MS } from "@/lib/vision-describe";
import { ApiError } from "../../../mcp/lib/errors";
import { DESCRIBE_CALL_TIMEOUT_MS, registerBrowserTools } from "../../../mcp/tools/browser";

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));

// The real api() applies the caller's per-route rules before an ApiError
// escapes; the stub must too, or a mapped refusal would test nothing.
vi.mock("../../../mcp/lib/api", async () => {
  const { ApiError, matchRule } = await import("../../../mcp/lib/errors");
  return {
    apiPost: async (route: string, body: unknown, options?: { rules?: Parameters<typeof matchRule>[1] }) => {
      try {
        return await apiPost(route, body, options);
      } catch (err) {
        if (err instanceof ApiError) throw matchRule(err, options?.rules) ?? err;
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
let restore: () => void;

/**
 * ONE module instance throughout, deliberately: classifyError tells a
 * ToolError and an ApiError by instanceof, and a module reset refreshes the
 * tool and the error classes but not the api mock above, which keeps the
 * classes it captured first — every mapped refusal would then come back as
 * the raw status. The tool's only module state is the session id, which
 * browser_close clears where a test needs a fresh launch.
 */
function browserTools(): CaptureHarness {
  const h = captureRegistrar("openclaw");
  registerBrowserTools(h.reg);
  return h;
}

/** The apiPost calls whose body matched, as [body, options] pairs. */
function postsTo(route: string, pick: (body: Record<string, unknown>) => boolean) {
  return apiPost.mock.calls
    .filter(([r, body]) => r === route && pick(body as Record<string, unknown>))
    .map(([, body, options]) => [body, options] as [Record<string, unknown>, { timeoutMs?: number } | undefined]);
}

beforeEach(() => {
  restore = saveEnv("CLAWBOX_RUN_DIR", "CLAWBOX_RUN_ARTIFACTS_DIR");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-describe-"));
  process.env.CLAWBOX_RUN_DIR = path.join(base, "work");
  process.env.CLAWBOX_RUN_ARTIFACTS_DIR = path.join(base, "evidence");
  apiPost.mockReset();
  apiPost.mockImplementation(async (route: string, body: { action?: string }) => {
    if (route === "/setup-api/vision/describe") return { description: "a red square", error: null };
    if (body.action === "launch") return { sessionId: "browser-1" };
    return { url: "https://example.test/", title: "Example", screenshot: "iVBORw0KGgo=", description: "A page." };
  });
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("waiting longer than the backend", () => {
  it("pins the describe-call timeout above vision-describe's whole budget plus a page load", () => {
    // 15 s is the browser route's page-load ceiling, which a described
    // navigate pays before the vision round trip even starts.
    expect(DESCRIBE_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(DESCRIBE_TIMEOUT_MS + 15_000);
  });

  it("gives a described capture the long timeout and a plain one the short", async () => {
    const h = browserTools();
    await h.call("browser_close");
    expect((await h.call("browser_screenshot")).isError).toBe(false);
    const described = postsTo("/setup-api/browser", (b) => b.action === "screenshot" && b.describe === true);
    expect(described).toHaveLength(1);
    expect(described[0][1]?.timeoutMs).toBe(DESCRIBE_CALL_TIMEOUT_MS);
    const launch = postsTo("/setup-api/browser", (b) => b.action === "launch");
    expect(launch).toHaveLength(1);
    expect(launch[0][1]?.timeoutMs).toBeLessThan(DESCRIBE_CALL_TIMEOUT_MS);
  });
});

describe("describe_image", () => {
  it("is one call, with the long timeout, and relays the description", async () => {
    const h = browserTools();
    const out = await h.call("describe_image", { path: "frame.png", prompt: "what color?" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toBe("a red square");
    const calls = postsTo("/setup-api/vision/describe", () => true);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual({ path: path.join(base, "work", "frame.png"), prompt: "what color?" });
    expect(calls[0][1]?.timeoutMs).toBe(DESCRIBE_CALL_TIMEOUT_MS);
  });

  it("does not re-fire on a failed description or on a refusal", async () => {
    const h = browserTools();
    apiPost.mockResolvedValueOnce({ description: null, error: "the vision request timed out" });
    const failed = await h.call("describe_image", { path: "frame.png" });
    expect(failed.isError).toBe(true);
    if (failed.isError) expect(failed.error.code).toBe("ENDPOINT_DOWN");
    expect(postsTo("/setup-api/vision/describe", () => true)).toHaveLength(1);

    apiPost.mockRejectedValueOnce(new ApiError(403, JSON.stringify({ error: "outside" })));
    const refused = await h.call("describe_image", { path: "frame.png" });
    expect(refused.isError).toBe(true);
    if (refused.isError) expect(refused.error.code).toBe("BLOCKED_PATH");
    expect(postsTo("/setup-api/vision/describe", () => true)).toHaveLength(2);
  });

  it("refuses a path outside the run's two folders before asking the device", async () => {
    const h = browserTools();
    expect((await h.call("describe_image", { path: path.join(base, "evidence", "shot-001.png") })).isError).toBe(false);
    const out = await h.call("describe_image", { path: path.join(base, "elsewhere", "photo.png") });
    expect(out.isError).toBe(true);
    if (out.isError) expect(out.error.code).toBe("BLOCKED_PATH");
    expect(postsTo("/setup-api/vision/describe", () => true)).toHaveLength(1);
  });
});
