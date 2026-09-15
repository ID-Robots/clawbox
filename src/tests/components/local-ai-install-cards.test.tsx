/**
 * Settings → Local AI's install cards.
 *
 * What is pinned is the three things the owner's decision of 2026-09-14 turned
 * into a click: the cost of a download shown BEFORE the button, what the card
 * says while the box works and how it ended, and that a removal frees the disk
 * and updates the row without a reload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import EmbeddingModelCard from "@/components/local-ai/EmbeddingModelCard";
import OllamaModelsCard from "@/components/local-ai/OllamaModelsCard";
import GgufLibraryCard from "@/components/local-ai/GgufLibraryCard";
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
    expect(screen.queryByTestId("local-ai-embed-remove")).toBeNull();
  });

  it("removes the model and says how much came back", async () => {
    stub((url, init) => (init?.method === "DELETE" ? json({ ok: true, freedBytes: 640 * 1024 * 1024, installed: false }) : json(PRESENT)));
    render(<I18nProvider><EmbeddingModelCard /></I18nProvider>);

    fireEvent.click(await screen.findByTestId("local-ai-embed-remove"));
    await waitFor(() => expect(screen.getByTestId("local-ai-embed-note").textContent).toContain("640 MB"));
  });
});

describe("GgufLibraryCard", () => {
  const LIBRARY = {
    files: [
      { name: "gemma-4-E2B_q4_0-it.gguf", bytes: 3 * GB, inUse: true },
      { name: "other.gguf", bytes: 2 * GB, inUse: false },
    ],
    defaultFile: "gemma-4-E2B_q4_0-it.gguf",
    downloaderReady: true,
    freeBytes: 20 * GB,
    reserveBytes: 512 * 1024 * 1024,
  };

  function type(repo: string, file: string) {
    fireEvent.change(screen.getByTestId("local-ai-gguf-repo"), { target: { value: repo } });
    fireEvent.change(screen.getByTestId("local-ai-gguf-file"), { target: { value: file } });
  }

  it("refuses a malformed reference on this side, before any request", async () => {
    stub(() => json(LIBRARY));
    render(<I18nProvider><GgufLibraryCard /></I18nProvider>);
    await screen.findByTestId("local-ai-gguf-card");

    type("not-a-repo", "README.md");
    expect(screen.getByTestId("local-ai-gguf-invalid")).toBeTruthy();
    expect((screen.getByTestId("local-ai-gguf-check") as HTMLButtonElement).disabled).toBe(true);
    expect(calls.filter((c) => c.url.includes("repo="))).toHaveLength(0);
  });

  it("shows the size and the free disk before Download is offered", async () => {
    stub((url) => (url.includes("repo=")
      ? json({ bytes: 4 * GB, probe: "ok", alreadyHere: false, freeBytes: 20 * GB, fits: true })
      : json(LIBRARY)));
    render(<I18nProvider><GgufLibraryCard /></I18nProvider>);
    await screen.findByTestId("local-ai-gguf-card");

    type("owner/name", "model.gguf");
    expect(screen.queryByTestId("local-ai-gguf-download")).toBeNull();
    fireEvent.click(screen.getByTestId("local-ai-gguf-check"));

    await waitFor(() => expect(screen.getByTestId("local-ai-gguf-probe").textContent).toContain("4.0 GB"));
    expect(screen.getByTestId("local-ai-gguf-download")).toBeTruthy();
  });

  it("says how much room is missing, and does not offer Download", async () => {
    stub((url) => (url.includes("repo=")
      ? json({ bytes: 40 * GB, probe: "ok", alreadyHere: false, freeBytes: 20 * GB, fits: false })
      : json(LIBRARY)));
    render(<I18nProvider><GgufLibraryCard /></I18nProvider>);
    await screen.findByTestId("local-ai-gguf-card");

    type("owner/name", "huge.gguf");
    fireEvent.click(screen.getByTestId("local-ai-gguf-check"));

    await waitFor(() => expect(screen.getByTestId("local-ai-gguf-probe").textContent).toContain("40.0 GB"));
    expect((screen.getByTestId("local-ai-gguf-download") as HTMLButtonElement).disabled).toBe(true);
  });

  it("draws the bar from the download's own bytes", async () => {
    stub((url, init) => {
      if (init?.method === "POST") {
        return ndjson([{ status: "Downloading model.gguf…", completed: 0, total: 100 }, { completed: 60, total: 100 }, { success: true }]);
      }
      if (url.includes("repo=")) return json({ bytes: 4 * GB, probe: "ok", alreadyHere: false, freeBytes: 20 * GB, fits: true });
      return json(LIBRARY);
    });
    render(<I18nProvider><GgufLibraryCard /></I18nProvider>);
    await screen.findByTestId("local-ai-gguf-card");

    type("owner/name", "model.gguf");
    fireEvent.click(screen.getByTestId("local-ai-gguf-check"));
    fireEvent.click(await screen.findByTestId("local-ai-gguf-download"));

    await waitFor(() => expect(screen.getByTestId("local-ai-gguf-outcome").textContent).toContain("Installed"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ repo: "owner/name", file: "model.gguf" });
  });

  it("removes a model that is not the one the box answers with", async () => {
    stub((url, init) => (init?.method === "DELETE"
      ? json({ ok: true, freedBytes: 2 * GB, files: [LIBRARY.files[0]], freeBytes: 22 * GB, reserveBytes: 0 })
      : json(LIBRARY)));
    render(<I18nProvider><GgufLibraryCard /></I18nProvider>);

    await screen.findByTestId("local-ai-gguf-file-other.gguf");
    // The one the box answers with offers no removal at all.
    expect(screen.queryByTestId("local-ai-gguf-remove-gemma-4-E2B_q4_0-it.gguf")).toBeNull();

    fireEvent.click(screen.getByTestId("local-ai-gguf-remove-other.gguf"));
    await waitFor(() => expect(screen.getByTestId("local-ai-gguf-note").textContent).toContain("2.0 GB"));
  });

  it("says when there is nothing on the box to download with", async () => {
    stub(() => json({ ...LIBRARY, downloaderReady: false }));
    render(<I18nProvider><GgufLibraryCard /></I18nProvider>);
    const said = await screen.findByTestId("local-ai-gguf-no-downloader");
    await waitFor(() => expect(said.textContent).toContain("downloader"));
  });
});

describe("OllamaModelsCard", () => {
  const RUNNING = {
    running: true,
    models: [{ name: "llama3.2:3b", size: 2 * GB, modified_at: "" }],
  };

  it("says the daemon is not running rather than offering a button that cannot work", async () => {
    stub(() => json({ running: false, models: [] }));
    render(<I18nProvider><OllamaModelsCard /></I18nProvider>);
    expect(await screen.findByTestId("local-ai-ollama-off")).toBeTruthy();
  });

  it("lists what is on the box with its size, and the presets when nothing is typed", async () => {
    stub(() => json(RUNNING));
    render(<I18nProvider><OllamaModelsCard /></I18nProvider>);

    const row = await screen.findByTestId("local-ai-ollama-llama3.2:3b");
    await waitFor(() => expect(row.textContent).toContain("2.0 GB"));
    expect(screen.getByTestId("local-ai-ollama-presets")).toBeTruthy();
  });

  it("makes a model the LOCAL chat model, not the owner's primary provider", async () => {
    stub((url, init) => {
      if (url.startsWith("/setup-api/ai-models/configure")) return json({ success: true });
      if (init?.method === "POST") return json({ success: true });
      return json(RUNNING);
    });
    render(<I18nProvider><OllamaModelsCard /></I18nProvider>);

    fireEvent.click(await screen.findByTestId("local-ai-ollama-use-llama3.2:3b"));
    await waitFor(() => expect(calls.some((c) => c.url === "/setup-api/ai-models/configure")).toBe(true));

    const configure = calls.find((c) => c.url === "/setup-api/ai-models/configure");
    expect(configure?.body).toMatchObject({ provider: "ollama", apiKey: "llama3.2:3b", scope: "local" });
  });

  it("draws a bar from the pull's own bytes and offers a way out of it", async () => {
    let releasePull: (() => void) | null = null;
    stub((url, init) => {
      if (url === "/setup-api/ollama/pull") {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            const encode = (o: unknown) => controller.enqueue(new TextEncoder().encode(`${JSON.stringify(o)}\n`));
            encode({ status: "pulling", completed: 30, total: 100 });
            releasePull = () => {
              encode({ status: "success" });
              controller.close();
            };
          },
        }), { status: 200, headers: { "content-type": "application/x-ndjson" } });
      }
      if (url.startsWith("/setup-api/ai-models/configure")) return json({ success: true });
      if (init?.method === "POST") return json({ success: true });
      return json({ running: true, models: [] });
    });
    render(<I18nProvider><OllamaModelsCard /></I18nProvider>);

    fireEvent.click(await screen.findByTestId("local-ai-ollama-preset-llama3.2:3b"));

    const bar = await screen.findByTestId("local-ai-ollama-progress-bar");
    expect(bar.getAttribute("aria-valuenow")).toBe("30");
    // A download is minutes long; leaving the page used to be the only way out.
    expect(screen.getByTestId("local-ai-ollama-cancel")).toBeTruthy();

    await waitFor(() => expect(releasePull).not.toBeNull());
    releasePull!();
    await waitFor(() => expect(screen.queryByTestId("local-ai-ollama-progress")).toBeNull());
  });

  it("removes a model through the route and re-reads the daemon", async () => {
    stub((url, init) => {
      if (url === "/setup-api/ollama/delete") return json({ success: true });
      if (init?.method === "POST") return json({ success: true });
      return json(RUNNING);
    });
    render(<I18nProvider><OllamaModelsCard /></I18nProvider>);

    fireEvent.click(await screen.findByTestId("local-ai-ollama-remove-llama3.2:3b"));
    await waitFor(() => expect(calls.some((c) => c.url === "/setup-api/ollama/delete")).toBe(true));
    expect(calls.find((c) => c.url === "/setup-api/ollama/delete")?.body).toEqual({ model: "llama3.2:3b" });
  });
});
