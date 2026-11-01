/**
 * Settings → Local AI's cards under the rows: the Whisper size picker and the
 * embedder's repair.
 *
 * What is pinned is the three things the owner's decision of 2026-09-14 turned
 * into a click: the cost of a download shown BEFORE the button, what the card
 * says while the box works and how it ended, and that a removal frees the disk
 * and updates the row without a reload. The Ollama card and the GGUF library
 * are gone (the owner's ruling of 2026-09-15), and so are their suites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import EmbeddingModelCard from "@/components/local-ai/EmbeddingModelCard";
import WhisperSizesCard from "@/components/local-ai/WhisperSizesCard";

const GB = 1024 * 1024 * 1024;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** An install route's answer: NDJSON, one line at a time, ending in a verdict. */
function ndjson(lines: unknown[]) {
  const text = lines.map((l) => `${JSON.stringify(l)}\n`).join("");
  return new Response(new TextEncoder().encode(text), {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

const WHISPER = {
  installed: true,
  running: true,
  active: "base",
  sizes: [
    { id: "tiny", bytes: 78 * 1024 * 1024, cached: false, diskBytes: null },
    { id: "base", bytes: 150 * 1024 * 1024, cached: true, diskBytes: 150 * 1024 * 1024 },
    { id: "small", bytes: 500 * 1024 * 1024, cached: false, diskBytes: null },
    { id: "medium", bytes: 1600 * 1024 * 1024, cached: false, diskBytes: null },
  ],
  freeBytes: 20 * GB,
  reserveBytes: 512 * 1024 * 1024,
};

let calls: { url: string; method: string; body?: unknown }[] = [];

function stub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return handler(url, init);
  }));
}

beforeEach(() => { calls = []; });
afterEach(() => vi.unstubAllGlobals());

describe("WhisperSizesCard", () => {
  it("shows what an absent size costs against the free disk, before any click", async () => {
    stub(() => json(WHISPER));
    render(<I18nProvider><WhisperSizesCard /></I18nProvider>);

    const row = await screen.findByTestId("local-ai-whisper-small");
    await waitFor(() => expect(row.textContent).toContain("500 MB"));
    expect(row.textContent).toContain("20.0 GB");
    // The size in use is named, and offers no "use this one".
    expect(await screen.findByTestId("local-ai-whisper-active-base")).toBeTruthy();
    expect(screen.queryByTestId("local-ai-whisper-use-base")).toBeNull();
  });

  it("draws a bar from the bytes the route reports, then says it is installed", async () => {
    stub((url, init) => {
      if (init?.method === "POST") {
        return ndjson([
          { status: "Fetching the small speech model…", completed: 0, total: 1000 },
          { completed: 250, total: 1000 },
          { success: true, size: "small", restarted: true },
        ]);
      }
      return json(WHISPER);
    });
    render(<I18nProvider><WhisperSizesCard /></I18nProvider>);

    fireEvent.click(await screen.findByTestId("local-ai-whisper-use-small"));

    await waitFor(() => expect(screen.getByTestId("local-ai-whisper-outcome").textContent).toContain("Installed"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ size: "small" });
  });

  it("says how much room is missing when the box refuses on disk", async () => {
    stub((url, init) => {
      if (init?.method === "POST") {
        return json(
          { error: "no room", code: "disk_full", requiredBytes: 1600 * 1024 * 1024, freeBytes: 600 * 1024 * 1024, reserveBytes: 512 * 1024 * 1024 },
          507,
        );
      }
      return json(WHISPER);
    });
    render(<I18nProvider><WhisperSizesCard /></I18nProvider>);

    fireEvent.click(await screen.findByTestId("local-ai-whisper-use-medium"));

    await waitFor(() => expect(screen.getByTestId("local-ai-whisper-outcome").textContent).toContain("1.6 GB"));
    const said = screen.getByTestId("local-ai-whisper-outcome").textContent ?? "";
    // The figures are the point: "not enough space" alone sends somebody to
    // look at the wrong disk.
    expect(said).toContain("1.6 GB");
    expect(said).toContain("600 MB");
  });

  it("removes a size that is not in use and says what came back", async () => {
    const after = { ...WHISPER, sizes: WHISPER.sizes.map((s) => (s.id === "tiny" ? { ...s, cached: false } : s)) };
    stub((url, init) => {
      if (init?.method === "DELETE") return json({ ok: true, freedBytes: 78 * 1024 * 1024, ...after });
      return json({ ...WHISPER, sizes: WHISPER.sizes.map((s) => (s.id === "tiny" ? { ...s, cached: true, diskBytes: 78 * 1024 * 1024 } : s)) });
    });
    render(<I18nProvider><WhisperSizesCard /></I18nProvider>);

    fireEvent.click(await screen.findByTestId("local-ai-whisper-remove-tiny"));

    await waitFor(() => expect(screen.getByTestId("local-ai-whisper-note").textContent).toContain("78.0 MB"));
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes("size=tiny"))).toBe(true);
  });

  it("offers no removal for the size the box is using", async () => {
    stub(() => json(WHISPER));
    render(<I18nProvider><WhisperSizesCard /></I18nProvider>);
    await screen.findByTestId("local-ai-whisper-base");
    expect(screen.queryByTestId("local-ai-whisper-remove-base")).toBeNull();
  });

  it("says plainly when speech itself is not installed", async () => {
    stub(() => json({ ...WHISPER, installed: false }));
    render(<I18nProvider><WhisperSizesCard /></I18nProvider>);
    const absent = await screen.findByTestId("local-ai-whisper-absent");
    await waitFor(() => expect(absent.textContent).toContain("not installed"));
  });
});

describe("EmbeddingModelCard", () => {
  const PRESENT = { installed: true, binaryAvailable: true, modelAvailable: true, modelBytes: 640 * 1024 * 1024, model: "qwen3-embedding-0.6b", engine: "llama.cpp" };

  it("says the model is here and offers a re-download rather than a first one", async () => {
    stub(() => json(PRESENT));
    render(<I18nProvider><EmbeddingModelCard /></I18nProvider>);

    const state = await screen.findByTestId("local-ai-embed-state");
    await waitFor(() => expect(state.textContent).toContain("qwen3-embedding-0.6b"));
    expect(state.textContent).toContain("640 MB");
    expect(screen.getByTestId("local-ai-embed-download").textContent).toContain("again");
  });

  it("asks for the step again with force when the model is already here", async () => {
    stub((url, init) => (init?.method === "POST" ? ndjson([{ success: true }]) : json(PRESENT)));
    render(<I18nProvider><EmbeddingModelCard /></I18nProvider>);

    fireEvent.click(await screen.findByTestId("local-ai-embed-download"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ force: true });
  });

  it("does not offer force on a box that has no model yet", async () => {
    stub((url, init) => (init?.method === "POST" ? ndjson([{ success: true }]) : json({ ...PRESENT, installed: false, modelAvailable: false, modelBytes: null })));
    render(<I18nProvider><EmbeddingModelCard /></I18nProvider>);

    fireEvent.click(await screen.findByTestId("local-ai-embed-download"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ force: false });
  });

  it("offers no removal of its own: taking the model off is the row's Uninstall", async () => {
    stub(() => json(PRESENT));
    render(<I18nProvider><EmbeddingModelCard /></I18nProvider>);
    await screen.findByTestId("local-ai-embed-download");
    expect(screen.queryByTestId("local-ai-embed-remove")).toBeNull();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

/**
 * Both downloads are background tasks of the box now: a Settings reopened
 * while one runs follows it again on its own row — steps, bar, time left, log
 * and, for the size download, Cancel — rather than drawing an idle button
 * over work that is still going.
 */
describe("re-attaching to a download that is already running", () => {
  /** A follow stream the test ends when it wants to. */
  function heldStream(first: unknown) {
    let end!: (last: unknown) => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(first)}\n`));
        end = (last) => {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify(last)}\n`));
          controller.close();
        };
      },
    });
    return { response: new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } }), end: (last: unknown) => end(last) };
  }

  function taskView(over: Record<string, unknown>) {
    return {
      id: "t9", group: "g", title: "Downloading", meta: null, state: "running",
      steps: [{ id: "fetch", label: "Download the small model", state: "running", weight: 9 }, { id: "switch", label: "Switch speech to it", state: "pending", weight: 1 }],
      status: "Fetching the small speech model…", completed: 100 * 1024 * 1024, total: 500 * 1024 * 1024,
      startedAt: 1, updatedAt: 2, stepStartedAt: 1, finishedAt: null, error: null, result: null,
      log: ["Fetching the small speech model…"], logCount: 1, runner: "r", dismissed: false,
      cancellable: false, cancelRequested: false, unit: null, adoptedAt: null, percent: 18, etaSeconds: 240,
      ...over,
    };
  }

  it("follows a size download on its row, offers Cancel, and says Cancelled when it stops", async () => {
    const task = taskView({ kind: "whisper-size-download", meta: { size: "small" }, cancellable: true });
    const follow = heldStream({ taskId: "t9", kind: "whisper-size-download", status: "Fetching the small speech model…" });
    stub((url, init) => {
      if (url === "/setup-api/background-jobs/tasks") {
        return init?.method === "POST" ? json({ ok: true, task: { ...task, cancelRequested: true } }) : json({ tasks: [task] });
      }
      if (url === "/setup-api/background-jobs/tasks/follow?id=t9") return follow.response;
      if (url === "/setup-api/background-jobs/tasks?id=t9") return json({ task });
      return json(WHISPER);
    });
    render(<I18nProvider><WhisperSizesCard /></I18nProvider>);

    const inline = await screen.findByTestId("local-ai-whisper-task-small");
    expect(inline).toHaveTextContent("Fetching the small speech model…");
    expect(screen.getByTestId("local-ai-whisper-task-small-steps")).toHaveTextContent("Download the small model");
    // Every size is held while one downloads.
    expect(screen.getByTestId("local-ai-whisper-use-medium")).toBeDisabled();

    fireEvent.click(screen.getByTestId("local-ai-whisper-task-small-cancel"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && (c.body as { action?: string })?.action === "cancel")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ id: "t9", action: "cancel" });

    follow.end({ status: "Cancelled.", error: "Cancelled.", code: "cancelled", cancelled: true, taskId: "t9" });
    const outcome = await screen.findByTestId("local-ai-whisper-outcome");
    await waitFor(() => expect(outcome).toHaveTextContent("Cancelled."));
    expect(outcome.getAttribute("role")).toBe("status");
    expect(screen.queryByTestId("local-ai-whisper-task-small")).toBeNull();
  });

  it("follows the memory-model download in its card, and reads its verdict when it lands", async () => {
    const task = taskView({ kind: "embed-model-download", steps: [], status: "Fetching the memory-search model…", total: 639_000_000, completed: 300_000_000, percent: 47 });
    const follow = heldStream({ taskId: "t9", kind: "embed-model-download", status: "Fetching the memory-search model…" });
    let present = false;
    stub((url) => {
      if (url === "/setup-api/embed/status") {
        return json({ installed: present, binaryAvailable: true, modelAvailable: present, modelBytes: present ? 639_000_000 : null, model: "qwen3-embedding-0.6b", engine: "llama.cpp" });
      }
      if (url === "/setup-api/background-jobs/tasks") return json({ tasks: [task] });
      if (url === "/setup-api/background-jobs/tasks/follow?id=t9") return follow.response;
      if (url === "/setup-api/background-jobs/tasks?id=t9") return json({ task });
      return json({});
    });
    render(<I18nProvider><EmbeddingModelCard /></I18nProvider>);

    const inline = await screen.findByTestId("local-ai-embed-task");
    expect(screen.getByTestId("local-ai-embed-task-percent")).toHaveTextContent("47%");
    expect(screen.getByTestId("local-ai-embed-download")).toBeDisabled();
    // A root step cannot be stopped half-way: no Cancel is offered.
    expect(screen.queryByTestId("local-ai-embed-task-cancel")).toBeNull();
    expect(inline).toBeInTheDocument();

    present = true;
    follow.end({ status: "The memory-search model is on this box.", success: true, taskId: "t9" });
    await waitFor(() => expect(screen.queryByTestId("local-ai-embed-task")).toBeNull());
    expect(await screen.findByTestId("local-ai-embed-outcome")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("local-ai-embed-download")).not.toBeDisabled());
  });

  it("does not follow anything when nothing of its kind is running", async () => {
    stub((url) => {
      if (url === "/setup-api/background-jobs/tasks") return json({ tasks: [taskView({ kind: "voice-kokoro-install" })] });
      return json(WHISPER);
    });
    render(<I18nProvider><WhisperSizesCard /></I18nProvider>);
    await screen.findByTestId("local-ai-whisper-small");
    await waitFor(() => expect(calls.some((c) => c.url === "/setup-api/background-jobs/tasks")).toBe(true));
    expect(calls.some((c) => c.url.includes("/follow"))).toBe(false);
    expect(screen.getByTestId("local-ai-whisper-use-small")).not.toBeDisabled();
  });
});
