import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * POST /setup-api/chat/images — the composer's picture button, server side.
 *
 * The route is a thin shell over `clawai-images.ts`; what it owns, and what
 * these tests are about, is the DURABLE TRANSCRIPT. Two records, written in the
 * order the chat route already established for a turn:
 *
 *   - the REQUEST before the upstream call, so a generation that dies half way
 *     leaves something visibly incomplete rather than nothing at all;
 *   - the PICTURE only on success, so a refresh never shows an answer to a
 *     question that was never asked.
 *
 * That order is the whole reason the write is here and not in the browser: a
 * customer who closes the tab on a 15-second generation still finds the picture
 * waiting on their next visit.
 */

let tmpHome: string;
let originalHome: string | undefined;
let originalClawboxRoot: string | undefined;
let POST: (req: NextRequest) => Promise<Response>;
let harness: "hermes" | "openclaw";
let generate: ReturnType<typeof vi.fn>;

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/setup-api/chat/images", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

/** Every line the transcript holds, oldest first. */
function transcript(): Array<Record<string, unknown>> {
  const file = path.join(tmpHome, "data", "chat-transcripts", "desktop.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(async () => {
  vi.resetModules();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "chat-images-route-"));
  originalHome = process.env.HOME;
  originalClawboxRoot = process.env.CLAWBOX_ROOT;
  process.env.HOME = tmpHome;
  process.env.CLAWBOX_ROOT = tmpHome;
  harness = "hermes";

  vi.doMock("@/lib/harness", () => ({ getActiveHarness: async () => harness }));
  generate = vi.fn(async () => ({
    path: "/home/clawbox/clawbox/data/chat-media/chat-generated/abc.png",
    media: "/setup-api/chat/media?path=%2Fabc.png",
  }));
  vi.doMock("@/lib/harness/clawai-images", async () => {
    // The real error class, so the route's `instanceof` branch is the one under
    // test rather than a stand-in that always takes the 500 path.
    const actual = await vi.importActual<typeof import("@/lib/harness/clawai-images")>(
      "@/lib/harness/clawai-images",
    );
    return { ...actual, generateClawaiImage: generate };
  });

  POST = (await import("@/app/setup-api/chat/images/route")).POST;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalClawboxRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = originalClawboxRoot;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("POST /setup-api/chat/images", () => {
  it("hands back the media ref and records both halves of the exchange", async () => {
    const res = await POST(request({ prompt: "a red maple leaf" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      media: ["/setup-api/chat/media?path=%2Fabc.png"],
    });
    expect(generate).toHaveBeenCalledWith("a red maple leaf", expect.anything());

    const rows = transcript();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ role: "user", text: "a red maple leaf" });
    // The picture is stored as the ref the bubble holds, not as an absolute
    // path — so a replayed transcript is byte-identical to the live
    // conversation rather than showing a path as text.
    expect(rows[1]).toMatchObject({
      role: "assistant",
      media: ["/setup-api/chat/media?path=%2Fabc.png"],
    });
  });

  it("records the request BEFORE the upstream call, so a dead generation is visible", async () => {
    // The order is the property, not the count: a service that restarts under a
    // 15-second call must leave a question with no answer, which reads as
    // incomplete, rather than an answer to nothing or a silent gap.
    let duringCall: Array<Record<string, unknown>> = [];
    generate.mockImplementation(async () => {
      duringCall = transcript();
      throw new Error("the box went away");
    });
    await POST(request({ prompt: "a cat" }));
    expect(duringCall).toHaveLength(1);
    expect(duringCall[0]).toMatchObject({ role: "user", text: "a cat" });
  });

  it("records a failure too, and answers with the sentence the customer sees", async () => {
    const { ClawaiImageError } = await import("@/lib/harness/clawai-images");
    generate.mockRejectedValue(
      new ClawaiImageError(429, "You have used up today's ClawBox AI pictures."),
    );
    const res = await POST(request({ prompt: "a cat" }));
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({
      error: "You have used up today's ClawBox AI pictures.",
    });
    // Without this row a refresh shows a request with nothing under it and no
    // hint that the box tried — the same screen a still-running generation
    // produces, which is the worse of the two to be wrong about.
    const rows = transcript();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ role: "system", variant: "error" });
    expect(rows[1].text).toContain("today's ClawBox AI pictures");
  });

  it("says nothing at all about an unexpected failure", async () => {
    // A failure that is not a `ClawaiImageError` came from the filesystem or the
    // runtime, and those quote paths. The box's log keeps the detail.
    generate.mockRejectedValue(new Error("EACCES: permission denied, open '/home/clawbox/secret'"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(request({ prompt: "a cat" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Could not generate the picture.");
    expect(body.error).not.toContain("/home/clawbox");
    warn.mockRestore();
  });

  it("leaves no failure line when the customer simply stopped", async () => {
    const { ClawaiImageError } = await import("@/lib/harness/clawai-images");
    generate.mockRejectedValue(new ClawaiImageError(499, "Stopped."));
    const res = await POST(request({ prompt: "a cat" }));
    expect(res.status).toBe(499);
    // The request they made is already recorded, which is where an unanswered
    // one belongs — but a cancellation is not an error and must not be drawn
    // as one on the next refresh.
    const rows = transcript();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "user" });
  });

  it("refuses a prompt that is missing, empty or absurd", async () => {
    for (const body of [{}, { prompt: "   " }, { prompt: 42 }]) {
      const res = await POST(request(body));
      expect(res.status).toBe(400);
    }
    const long = await POST(request({ prompt: "x".repeat(4001) }));
    expect(long.status).toBe(400);
    // Nothing was sent upstream and nothing was written: a bad request must not
    // cost the customer a line in their own transcript.
    expect(generate).not.toHaveBeenCalled();
    expect(transcript()).toHaveLength(0);
  });

  it("refuses a body that is not JSON", async () => {
    const res = await POST(request("not json at all"));
    expect(res.status).toBe(400);
  });

  it("writes no transcript on a harness whose gateway holds the conversation", async () => {
    // On OpenClaw the transcript is the gateway's, and writing these rows into a
    // file nothing reads would be a quiet lie about where the chat lives. The
    // picture still comes back — the route is edition-neutral — but the replay
    // log stays the property of the harness that owns one.
    harness = "openclaw";
    const res = await POST(request({ prompt: "a cat" }));
    expect(res.status).toBe(200);
    expect(transcript()).toHaveLength(0);
  });
});
