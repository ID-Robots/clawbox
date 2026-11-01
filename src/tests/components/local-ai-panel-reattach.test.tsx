/**
 * Settings → Local AI re-attaching to an install that outlived the window.
 *
 * The Gemma, Whisper and Kokoro installs run as background tasks of the
 * server (src/lib/background-tasks.ts). Pinned: a panel mounted while one runs
 * follows it on its own row — spinner, live line, the "you can close
 * Settings" hint, the verdict — through the task's follow stream, never by
 * starting the install again; and an install started here names its task, so
 * the desktop's corner card is told at once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import LocalAiPanel from "@/components/LocalAiPanel";
import { BACKGROUND_TASK_EVENT } from "@/lib/background-task-client";

function model(over: Record<string, unknown>) {
  return {
    id: "x", name: "X", kind: "llm", runtime: "llama.cpp", installed: true, enabled: null,
    running: "idle", diskBytes: null, memoryBytes: null, control: "none", detail: "Installed.",
    ...over,
  };
}

const MODELS = [
  model({ id: "llamacpp", name: "Gemma 4", kind: "llm", running: "idle", managedBy: "localAi", detail: "Ready." }),
  model({ id: "kokoro", name: "Kokoro", kind: "tts", runtime: "systemd user service", installed: false, enabled: null, running: "not-installed", control: "user-unit", detail: "Not installed." }),
  model({ id: "whisper", name: "Whisper", kind: "stt", runtime: "systemd user service", installed: false, enabled: null, running: "not-installed", control: "user-unit", detail: "Not installed." }),
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** An NDJSON body whose lines arrive as the test releases them. */
function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return {
    response: new Response(body, { headers: { "content-type": "application/x-ndjson" } }),
    send: (payload: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`)),
    close: () => controller.close(),
  };
}

function runningTask(kind: string, id = "task-1") {
  return {
    id, kind, group: kind, title: "Installing", meta: null, state: "running", steps: [], status: "Building…",
    completed: null, total: null, startedAt: 1, updatedAt: 1, stepStartedAt: 1, finishedAt: null, error: null,
    result: null, log: [], logCount: 0, runner: "r", dismissed: false, percent: null, etaSeconds: null,
  };
}

function stubFetch(opts: { tasks?: unknown[]; follow?: () => Response; post?: (url: string) => Response; models?: unknown[] }) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "POST") return opts.post?.(url) ?? json({ ok: true });
    if (url.startsWith("/setup-api/background-jobs/tasks/follow")) return opts.follow?.() ?? json({ error: "x" }, 404);
    if (url.startsWith("/setup-api/background-jobs/tasks")) return json({ tasks: opts.tasks ?? [] });
    if (url.startsWith("/setup-api/local-models")) return json({ models: opts.models ?? MODELS, unavailable: [] });
    if (url.startsWith("/setup-api/providers/status")) return json({ providers: [] });
    if (url.startsWith("/setup-api/tts")) return json({ choice: "auto", engines: [] });
    if (url.startsWith("/setup-api/stt")) return json({ primary: "cloud", engines: { cloud: { configured: true }, local: { installed: false } }, chain: ["cloud"] });
    if (url.startsWith("/setup-api/local-ai/exclusive")) return json({ enabled: false });
    return json({ error: "unexpected" }, 404);
  }));
  return calls;
}

function renderPanel() {
  return render(<I18nProvider><LocalAiPanel active edition="openclaw" /></I18nProvider>);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LocalAiPanel re-attaching to a background install", () => {
  it("follows a Whisper install that was running before the window opened, on its own row", async () => {
    const stream = controlledStream();
    const calls = stubFetch({ tasks: [runningTask("whisper-engine-install")], follow: () => stream.response });
    renderPanel();

    stream.send({ taskId: "task-1", kind: "whisper-engine-install", status: "Building CTranslate2…" });
    expect(await screen.findByTestId("local-model-progress-whisper")).toHaveTextContent("Building CTranslate2…");
    expect(screen.getByTestId("local-model-background-whisper")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/setup-api/background-jobs/tasks/follow?id=task-1")).toBe(true);
    // Followed, never started again.
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    stream.send({ success: true, status: "Speech on this box is installed.", taskId: "task-1" });
    stream.close();
    await waitFor(() => expect(screen.queryByTestId("local-model-progress-whisper")).toBeNull());
    expect(screen.queryByTestId("local-model-background-whisper")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("follows the memory model's first download on its row, and leaves an installed one's to the card", async () => {
    const embeddings = (installed: boolean) => model({
      id: "embeddings", name: "Memory search", kind: "embedding", runtime: "llama.cpp", installed,
      running: installed ? "on-demand" : "not-installed", control: "system-unit", detail: installed ? "Ready." : "Not installed.",
    });
    const stream = controlledStream();
    const calls = stubFetch({ models: [...MODELS, embeddings(false)], tasks: [runningTask("embed-model-download")], follow: () => stream.response });
    renderPanel();

    stream.send({ taskId: "task-1", kind: "embed-model-download", status: "Fetching the memory-search model…" });
    expect(await screen.findByTestId("local-model-progress-embeddings")).toHaveTextContent("Fetching the memory-search model…");
    expect(calls.some((c) => c.url === "/setup-api/background-jobs/tasks/follow?id=task-1")).toBe(true);
    stream.send({ success: true, taskId: "task-1" });
    stream.close();
    await waitFor(() => expect(screen.queryByTestId("local-model-progress-embeddings")).toBeNull());
  });

  it("does not follow an installed memory model's download on the row: its card does", async () => {
    const installed = model({
      id: "embeddings", name: "Memory search", kind: "embedding", runtime: "llama.cpp", installed: true,
      running: "on-demand", control: "system-unit", detail: "Ready.",
    });
    const calls = stubFetch({ models: [...MODELS, installed], tasks: [runningTask("embed-model-download")] });
    renderPanel();
    await screen.findByText("Memory search");
    await waitFor(() => expect(calls.some((c) => c.url === "/setup-api/background-jobs/tasks")).toBe(true));
    // One follower — the card under the row — never the row as well.
    await waitFor(() => expect(calls.filter((c) => c.url === "/setup-api/background-jobs/tasks/follow?id=task-1")).toHaveLength(1));
    expect(screen.queryByTestId("local-model-progress-embeddings")).toBeNull();
    expect(screen.queryByTestId("local-model-background-embeddings")).toBeNull();
  });

  it("shows the verdict of a re-attached install that failed", async () => {
    const stream = controlledStream();
    stubFetch({ tasks: [runningTask("voice-kokoro-install", "task-k")], follow: () => stream.response });
    renderPanel();
    stream.send({ taskId: "task-k", kind: "voice-kokoro-install", status: "Installing…" });
    await screen.findByTestId("local-model-progress-kokoro");
    stream.send({ error: "Kokoro GPU TTS NOT installed: no CUDA", taskId: "task-k" });
    stream.close();
    expect(await screen.findByText("Kokoro GPU TTS NOT installed: no CUDA")).toBeInTheDocument();
  });

  it("ignores tasks that ended and kinds no row owns", async () => {
    const ended = { ...runningTask("whisper-engine-install"), state: "succeeded" };
    const calls = stubFetch({ tasks: [ended, runningTask("something-else", "task-2")] });
    renderPanel();
    await screen.findByText("Whisper");
    await waitFor(() => expect(calls.some((c) => c.url.startsWith("/setup-api/background-jobs/tasks"))).toBe(true));
    expect(calls.some((c) => c.url.includes("/follow"))).toBe(false);
    expect(screen.queryByTestId("local-model-progress-whisper")).toBeNull();
  });

  it("tells the desktop's corner card about an install it starts", async () => {
    const stream = controlledStream();
    stubFetch({ post: (url) => (url === "/setup-api/tts/install" ? stream.response : json({ ok: true })) });
    const told = vi.fn();
    window.addEventListener(BACKGROUND_TASK_EVENT, told);
    try {
      renderPanel();
      await screen.findByText("Kokoro");
      fireEvent.click(await screen.findByTestId("local-model-action-kokoro-install"));
      stream.send({ taskId: "task-new", kind: "voice-kokoro-install", status: "Installing the voice…" });
      await waitFor(() => expect(told).toHaveBeenCalled());
      expect((told.mock.calls[0][0] as CustomEvent).detail).toEqual({ taskId: "task-new" });
      expect(await screen.findByTestId("local-model-background-kokoro")).toBeInTheDocument();
      stream.send({ success: true, taskId: "task-new" });
      stream.close();
      await waitFor(() => expect(screen.queryByTestId("local-model-background-kokoro")).toBeNull());
    } finally {
      window.removeEventListener(BACKGROUND_TASK_EVENT, told);
    }
  });
});
