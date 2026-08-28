/**
 * Settings → Local AI (src/components/LocalAiPanel.tsx): one grouped list of
 * everything on the box, with the actions behind a "more" menu.
 *
 * Pinned: rows are grouped by what they are for; a row's role (primary /
 * fallback) comes from the surface that decides it, not from the inventory;
 * and each menu action posts to the route that owns the change — the panel
 * never writes routing state of its own.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import LocalAiPanel from "@/components/LocalAiPanel";
import { OPEN_APP_EVENT } from "@/lib/ui-events";

function model(over: Record<string, unknown>) {
  return {
    id: "x", name: "X", kind: "llm", runtime: "llama.cpp", installed: true, enabled: null,
    running: "idle", diskBytes: null, memoryBytes: null, control: "none", detail: "Installed.",
    ...over,
  };
}

const MODELS = [
  model({ id: "llamacpp", name: "Gemma 4", kind: "llm", running: "idle", managedBy: "localAi", detail: "Ready. Sleeps until needed." }),
  model({ id: "ollama", name: "Ollama", kind: "llm", runtime: "System service", enabled: false, control: "system-unit", detail: "Installed and stopped." }),
  model({ id: "kokoro", name: "Kokoro", kind: "tts", runtime: "systemd user service", enabled: true, running: "running", control: "user-unit", detail: "Running as the GPU voice." }),
  model({ id: "whisper", name: "Whisper", kind: "stt", runtime: "systemd user service", enabled: false, control: "user-unit", detail: "Installed and stopped." }),
  model({ id: "embedding", name: "Memory embeddings", kind: "embedding", runtime: "ollama", running: "running", managedBy: "clawkeep", detail: "Embedding your memory on the box." }),
];

let posts: { url: string; body: unknown }[] = [];

function stubFetch(over: { llmDefault?: boolean; ttsChoice?: string; sttPrimary?: string } = {}) {
  posts = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ ok: true });
    }
    if (url.startsWith("/setup-api/local-models")) return json({ models: MODELS, unavailable: [] });
    if (url.startsWith("/setup-api/providers/status")) {
      return json({ harness: "openclaw", degraded: false, defaultProvider: over.llmDefault ? "llamacpp" : "clawai", providers: [
        { id: "clawai", label: "ClawBox AI", state: "connected", isDefault: !over.llmDefault, section: "ai", enabled: true },
        { id: "llamacpp", label: "Gemma 4", state: "connected", isDefault: !!over.llmDefault, section: "localAi", enabled: true },
      ] });
    }
    if (url.startsWith("/setup-api/tts")) {
      return json({ choice: over.ttsChoice ?? "auto", engines: [{ id: "local", configured: true }, { id: "cloud", configured: true }] });
    }
    if (url.startsWith("/setup-api/stt")) {
      return json({ primary: over.sttPrimary ?? "cloud", engines: { cloud: { configured: true, label: "c" }, local: { installed: true, label: "l" } }, chain: ["cloud", "local"] });
    }
    if (url.startsWith("/setup-api/local-ai/exclusive")) return json({ enabled: false });
    return json({ error: "unexpected" }, 404);
  }));
}

function renderPanel() {
  return render(<I18nProvider><LocalAiPanel active edition="openclaw" /></I18nProvider>);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LocalAiPanel", () => {
  it("groups the box's engines by what they are for", async () => {
    stubFetch();
    renderPanel();
    const llm = await screen.findByTestId("local-ai-group-llm");
    expect(within(llm).getByTestId("local-model-llamacpp")).toBeInTheDocument();
    expect(within(llm).getByTestId("local-model-ollama")).toBeInTheDocument();
    expect(within(screen.getByTestId("local-ai-group-tts")).getByTestId("local-model-kokoro")).toBeInTheDocument();
    expect(within(screen.getByTestId("local-ai-group-stt")).getByTestId("local-model-whisper")).toBeInTheDocument();
    expect(within(screen.getByTestId("local-ai-group-embedding")).getByTestId("local-model-embedding")).toBeInTheDocument();
  });

  it("reads each row's role from the surface that decides it", async () => {
    stubFetch({ llmDefault: false, ttsChoice: "local", sttPrimary: "cloud" });
    renderPanel();
    await screen.findByTestId("local-ai-group-llm");
    await waitFor(() => {
      expect(screen.getByTestId("local-model-role-llamacpp")).toHaveTextContent(/fallback/i);
      expect(screen.getByTestId("local-model-role-kokoro")).toHaveTextContent(/primary/i);
      expect(screen.getByTestId("local-model-role-whisper")).toHaveTextContent(/fallback/i);
    });
  });

  it("offers the right actions in the menu and posts them to the route that owns the change", async () => {
    stubFetch({ llmDefault: false, ttsChoice: "auto", sttPrimary: "cloud" });
    renderPanel();
    await screen.findByTestId("local-ai-group-llm");
    await waitFor(() => expect(screen.getByTestId("local-model-role-llamacpp")).toBeInTheDocument());

    // Gemma is the fallback: making it primary goes through the install route with activate.
    fireEvent.click(screen.getByTestId("local-model-menu-llamacpp"));
    fireEvent.click(await screen.findByTestId("local-model-action-llamacpp-primary"));
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/llamacpp/install", body: { scope: "local", activate: true } }));

    // A stopped Whisper can be enabled (its unit) and made the primary transcriber.
    fireEvent.click(screen.getByTestId("local-model-menu-whisper"));
    expect(await screen.findByTestId("local-model-action-whisper-enable")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("local-model-action-whisper-primary"));
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/stt", body: { primary: "local" } }));

    // Kokoro is the fallback voice: the menu offers to make it primary, through the tts route.
    fireEvent.click(screen.getByTestId("local-model-menu-kokoro"));
    fireEvent.click(await screen.findByTestId("local-model-action-kokoro-primary"));
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/tts", body: { action: "select", choice: "local" } }));
  });

  it("turns Local AI off through its own route, and sends the memory index to Memory Shard", async () => {
    stubFetch({ llmDefault: true });
    renderPanel();
    await screen.findByTestId("local-ai-group-llm");
    await waitFor(() => expect(screen.getByTestId("local-model-role-llamacpp")).toHaveTextContent(/primary/i));
    fireEvent.click(screen.getByTestId("local-model-menu-llamacpp"));
    fireEvent.click(await screen.findByTestId("local-model-action-llamacpp-turn-off"));
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/local-ai", body: { action: "disable" } }));
    // The embedding row has no menu of its own — its one button opens the app
    // that owns the index. That is Memory Shard, not ClawKeep: ClawKeep only
    // keeps a card pointing there, which would be a second hop.
    expect(screen.queryByTestId("local-model-menu-embedding")).not.toBeInTheDocument();
    const opened: string[] = [];
    const onOpen = (e: Event) => opened.push((e as CustomEvent<{ appId: string }>).detail.appId);
    window.addEventListener(OPEN_APP_EVENT, onOpen);
    try {
      fireEvent.click(screen.getByTestId("local-model-manage-embedding"));
    } finally {
      window.removeEventListener(OPEN_APP_EVENT, onOpen);
    }
    expect(opened).toEqual(["memory-shard"]);
  });
});
