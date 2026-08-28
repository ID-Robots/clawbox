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

type PostAnswer = (url: string) => Promise<Response> | Response | undefined;

function stubFetch(over: { llmDefault?: boolean; ttsChoice?: string; sttPrimary?: string; post?: PostAnswer } = {}) {
  posts = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      // A test may script the box's answer (a refusal, a slow reply); the
      // default is a plain success.
      return (await over.post?.(url)) ?? json({ ok: true });
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

  it("clears a refused local-only flip's error once the next flip goes through", async () => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    let refuse = true;
    stubFetch({
      llmDefault: false,
      post: (url) => {
        if (url !== "/setup-api/local-ai/exclusive") return undefined;
        if (!refuse) return undefined;
        refuse = false;
        return json({ error: "The local model is not ready yet." }, 409);
      },
    });
    renderPanel();
    const sw = await screen.findByTestId("local-ai-local-only");
    await waitFor(() => expect(sw).toBeEnabled());
    fireEvent.click(sw);
    expect(await screen.findByRole("alert")).toHaveTextContent("The local model is not ready yet.");
    await waitFor(() => expect(sw).toBeEnabled());
    // The second flip succeeds — the stale refusal must not stay on screen
    // above a switch that now says the opposite.
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("holds still for owners who asked for reduced motion: the skeleton and the busy icon animate motion-safe only", async () => {
    // Assigned from inside the fetch stub, so TS cannot see it change: a no-op
    // start rather than `null`, which it would narrow to and refuse to call.
    let release: () => void = () => {};
    stubFetch({
      post: (url) => {
        if (url !== "/setup-api/stt") return undefined;
        return new Promise<Response>((resolve) => {
          release = () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
        });
      },
    });
    renderPanel();
    // Before the inventory answers: the placeholder cards.
    const skeleton = screen.getByTestId("local-ai-loading");
    for (const card of Array.from(skeleton.children)) {
      expect(card).toHaveClass("motion-safe:animate-pulse");
      expect(card).not.toHaveClass("animate-pulse");
    }
    await screen.findByTestId("local-ai-group-stt");
    // While an action is in flight: the row's spinner.
    fireEvent.click(screen.getByTestId("local-model-menu-whisper"));
    fireEvent.click(await screen.findByTestId("local-model-action-whisper-primary"));
    const row = screen.getByTestId("local-model-whisper");
    await waitFor(() => expect(within(row).getByText("progress_activity")).toBeInTheDocument());
    const spinner = within(row).getByText("progress_activity");
    expect(spinner).toHaveClass("motion-safe:animate-spin");
    expect(spinner).not.toHaveClass("animate-spin");
    release();
    await waitFor(() => expect(within(row).queryByText("progress_activity")).not.toBeInTheDocument());
  });
});
