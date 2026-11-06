import { describe, expect, it, vi } from "vitest";
import { progressPercent, readInstallStream, type InstallProgress } from "@/lib/install-stream";

function streamOf(text: string, { chunkSize = 1024 } = {}): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  return new Response(body);
}

describe("readInstallStream", () => {
  it("reports every status line and the success that ends it", async () => {
    const seen: InstallProgress[] = [];
    const outcome = await readInstallStream(
      streamOf('{"status":"one"}\n{"status":"two"}\n{"success":true}\n'),
      (p) => seen.push(p),
    );
    expect(outcome).toEqual({ ok: true });
    expect(seen.map((p) => p.status)).toEqual(["one", "two"]);
  });

  it("carries the bytes a bar is drawn from", async () => {
    const seen: InstallProgress[] = [];
    await readInstallStream(
      streamOf('{"completed":50,"total":200}\n{"success":true}\n'),
      (p) => seen.push(p),
    );
    expect(seen[0]).toEqual({ status: undefined, completed: 50, total: 200 });
    expect(progressPercent(seen[0])).toBe(25);
  });

  it("decides on a closing line that arrives without its newline", async () => {
    // Dropping it turned a finished multi-minute install into an error.
    const outcome = await readInstallStream(streamOf('{"status":"x"}\n{"success":true}'), () => {});
    expect(outcome).toEqual({ ok: true });
  });

  it("survives a payload split across chunk boundaries", async () => {
    const outcome = await readInstallStream(
      streamOf('{"status":"a long line of progress"}\n{"success":true}\n', { chunkSize: 3 }),
      () => {},
    );
    expect(outcome).toEqual({ ok: true });
  });

  it("skips a torn write rather than calling the install failed", async () => {
    const outcome = await readInstallStream(streamOf('not json\n{"success":true}\n'), () => {});
    expect(outcome).toEqual({ ok: true });
  });

  it("answers the error line", async () => {
    const outcome = await readInstallStream(streamOf('{"status":"x"}\n{"error":"no room"}\n'), () => {});
    expect(outcome).toEqual({ ok: false, error: "no room" });
  });

  it("treats a stream that ends with no verdict as a failure", async () => {
    // The server went away mid-install. Reporting that as done would leave a
    // row claiming installed over a box that is not.
    const outcome = await readInstallStream(streamOf('{"status":"halfway"}\n'), () => {});
    expect(outcome.ok).toBe(false);
  });

  it("fails rather than throws when there is no body at all", async () => {
    const res = { body: null } as unknown as Response;
    await expect(readInstallStream(res, vi.fn())).resolves.toEqual({ ok: false });
  });
});

describe("progressPercent", () => {
  it("has nothing to draw without a total", () => {
    expect(progressPercent(null)).toBeNull();
    expect(progressPercent({ status: "working" })).toBeNull();
    expect(progressPercent({ completed: 5, total: 0 })).toBeNull();
  });

  it("stays inside the bar", () => {
    expect(progressPercent({ completed: 400, total: 200 })).toBe(100);
    expect(progressPercent({ total: 200 })).toBe(0);
  });
});

describe("readInstallStream: an install waiting its turn (TASK-2128)", () => {
  it("passes on that it is queued, what it waits for, and when it starts", async () => {
    const seen: InstallProgress[] = [];
    const lines = [
      { taskId: "t2", kind: "whisper-engine-install", status: "Queued — starts after Kokoro", queued: true, behind: { kind: "voice-kokoro-install", label: "Kokoro" } },
      { status: "Installing speech on this box (faster-whisper)…", queued: false },
      { status: "  Building CTranslate2 with CUDA for sm_87..." },
      { success: true, status: "Speech on this box is installed." },
    ];
    const outcome = await readInstallStream(streamOf(lines.map((l) => `${JSON.stringify(l)}\n`).join("")), (p) => seen.push(p));
    expect(outcome).toEqual({ ok: true });
    expect(seen[0]).toEqual({
      status: "Queued — starts after Kokoro",
      completed: undefined,
      total: undefined,
      queued: true,
      behind: { kind: "voice-kokoro-install", label: "Kokoro" },
    });
    expect(seen[1]).toMatchObject({ queued: false });
    expect(seen[2]).not.toHaveProperty("queued");
  });

  it("drops a `behind` it cannot read rather than passing half of it on", async () => {
    const seen: InstallProgress[] = [];
    await readInstallStream(streamOf(`${JSON.stringify({ status: "Queued", queued: true, behind: { kind: 3 } })}\n{"success":true}\n`), (p) => seen.push(p));
    expect(seen[0]).toMatchObject({ queued: true });
    expect(seen[0]).not.toHaveProperty("behind");
  });
});
