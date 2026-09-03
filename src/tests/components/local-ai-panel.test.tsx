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
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
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

function stubFetch(over: { llmDefault?: boolean; ttsChoice?: string; sttPrimary?: string; post?: PostAnswer; models?: unknown[] } = {}) {
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
    if (url.startsWith("/setup-api/local-models")) return json({ models: over.models ?? MODELS, unavailable: [] });
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

  /**
   * TASK-608. "Use as fallback" on the on-device row posts
   * /setup-api/providers/default, which on OpenClaw restarts the gateway. When
   * the gateway has not bound again inside the route's readiness budget the
   * change IS written and the route answers `ok` with a `warning`.
   *
   * This panel's only feedback channel was the red error box, so that answer
   * used to paint a failure over a change that went through — and the owner's
   * next move is to repeat it, paying another restart.
   */
  it("shows a gateway that is still coming back as a notice, not as a failed change", async () => {
    stubFetch({
      llmDefault: true,
      post: (url) => (url === "/setup-api/providers/default"
        ? new Response(JSON.stringify({
            ok: true,
            provider: "clawai",
            model: "deepseek/deepseek-v4-flash",
            warning: "Saved, but the gateway did not come back — the new model applies once it is serving again.",
          }), { status: 200, headers: { "content-type": "application/json" } })
        : undefined),
    });
    renderPanel();
    await screen.findByTestId("local-ai-group-llm");
    await waitFor(() => expect(screen.getByTestId("local-model-role-llamacpp")).toHaveTextContent(/primary/i));
    fireEvent.click(screen.getByTestId("local-model-menu-llamacpp"));
    fireEvent.click(await screen.findByTestId("local-model-action-llamacpp-fallback"));

    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/providers/default", body: { provider: "clawai" } }));
    const notice = await screen.findByTestId("local-ai-notice");
    expect(notice).toHaveTextContent("the gateway did not come back");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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

  it("reads the Gemma install route as the stream it is, showing its progress and surfacing its error", async () => {
    // The route answers 200 and streams NDJSON; a failure is an `error` LINE,
    // never a status code. Read with res.json() the stream fails to parse and
    // the failure vanished with it.
    const body = [
      JSON.stringify({ status: "Starting preinstalled Gemma 4..." }),
      JSON.stringify({ error: "llama.cpp exited before becoming ready." }),
      "",
    ].join("\n");
    let release: () => void = () => {};
    stubFetch({
      llmDefault: false,
      post: (url) => {
        if (url !== "/setup-api/llamacpp/install") return undefined;
        return new Promise<Response>((resolve) => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(body.slice(0, body.indexOf("\n") + 1)));
              release = () => {
                controller.enqueue(encoder.encode(body.slice(body.indexOf("\n") + 1)));
                controller.close();
              };
            },
          });
          resolve(new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } }));
        });
      },
    });
    renderPanel();
    await screen.findByTestId("local-ai-group-llm");
    await waitFor(() => expect(screen.getByTestId("local-model-role-llamacpp")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("local-model-menu-llamacpp"));
    fireEvent.click(await screen.findByTestId("local-model-action-llamacpp-primary"));
    // The last status line shows on the row while the install runs.
    expect(await screen.findByTestId("local-model-progress-llamacpp")).toHaveTextContent("Starting preinstalled Gemma 4...");
    release();
    expect(await screen.findByRole("alert")).toHaveTextContent("llama.cpp exited before becoming ready.");
    expect(screen.queryByTestId("local-model-progress-llamacpp")).not.toBeInTheDocument();
  });

  it("keeps each row's own spinner while two actions are in flight, and holds the poll until both settle", async () => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const releases: Record<string, () => void> = {};
    stubFetch({
      post: (url) => {
        if (url !== "/setup-api/local-models" && url !== "/setup-api/tts") return undefined;
        return new Promise<Response>((resolve) => {
          releases[url] = () => resolve(json({ ok: true }));
        });
      },
    });
    renderPanel();
    await screen.findByTestId("local-ai-group-llm");
    const ollama = screen.getByTestId("local-model-ollama");
    const kokoro = screen.getByTestId("local-model-kokoro");
    fireEvent.click(screen.getByTestId("local-model-menu-ollama"));
    fireEvent.click(await screen.findByTestId("local-model-action-ollama-enable"));
    fireEvent.click(screen.getByTestId("local-model-menu-kokoro"));
    fireEvent.click(await screen.findByTestId("local-model-action-kokoro-primary"));
    await waitFor(() => {
      expect(within(ollama).getByText("progress_activity")).toBeInTheDocument();
      expect(within(kokoro).getByText("progress_activity")).toBeInTheDocument();
    });
    expect(ollama).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("local-model-menu-ollama")).toHaveAttribute("aria-disabled", "true");
    const inventoryReads = () => (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((c) => String(c[0]).startsWith("/setup-api/local-models") && (c[1] as RequestInit | undefined)?.method !== "POST").length;
    const readsBefore = inventoryReads();
    // The first to settle must not clear the other row, nor let the poll in.
    releases["/setup-api/tts"]();
    await waitFor(() => expect(within(kokoro).queryByText("progress_activity")).not.toBeInTheDocument());
    expect(within(ollama).getByText("progress_activity")).toBeInTheDocument();
    expect(inventoryReads()).toBe(readsBefore);
    releases["/setup-api/local-models"]();
    await waitFor(() => expect(within(ollama).queryByText("progress_activity")).not.toBeInTheDocument());
    await waitFor(() => expect(inventoryReads()).toBeGreaterThan(readsBefore));
  });

  it("says so under the skeleton when the first inventory read fails, and recovers on the next", async () => {
    stubFetch();
    const stubbed = fetch as unknown as ReturnType<typeof vi.fn>;
    const answer = stubbed.getMockImplementation() as (input: string | URL, init?: RequestInit) => Promise<Response>;
    let fail = true;
    stubbed.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      if (fail && input.toString().startsWith("/setup-api/local-models")) {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
      }
      return answer(input, init);
    });
    // Capture the poll's tick instead of waiting out the real 5 s interval:
    // the recovery is driven by calling it, so the test costs milliseconds
    // and cannot flake on a loaded runner. restoreMocks puts the real
    // setInterval back after the test.
    const ticks: Array<() => void> = [];
    vi.spyOn(window, "setInterval").mockImplementation(((handler: TimerHandler) => {
      ticks.push(handler as () => void);
      return 0;
    }) as typeof window.setInterval);
    renderPanel();
    const skeleton = screen.getByTestId("local-ai-loading");
    // waitFor rather than a one-shot assertion: the catalogue loads async, so
    // the first paint of the alert can still carry the raw key.
    await waitFor(() => expect(within(skeleton).getByRole("alert")).toHaveTextContent("Could not read what is running on this box."));
    // The poll keeps trying; the message goes with the skeleton once it lands.
    fail = false;
    expect(ticks.length).toBeGreaterThan(0);
    await act(async () => { for (const tick of ticks) tick(); });
    await waitFor(() => expect(screen.queryByTestId("local-ai-load-failed")).not.toBeInTheDocument());
    expect(screen.getByTestId("local-ai-panel")).toBeInTheDocument();
  });

  it("names engines in the 'could not read' banner the way their rows do", async () => {
    stubFetch();
    const stubbed = fetch as unknown as ReturnType<typeof vi.fn>;
    const answer = stubbed.getMockImplementation() as (input: string | URL, init?: RequestInit) => Promise<Response>;
    stubbed.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      if (input.toString().startsWith("/setup-api/local-models") && init?.method !== "POST") {
        return new Response(JSON.stringify({ models: MODELS.filter((m) => m.kind === "llm"), unavailable: ["kokoro", "whisper", "embeddings"] }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return answer(input, init);
    });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("local-ai-unavailable")).toHaveTextContent("Could not read the state of: Kokoro, Whisper, Memory search."));
  });

  it("is a menu to the keyboard too: focus lands on the first item, the arrows move it, Escape hands it back", async () => {
    stubFetch({ llmDefault: false });
    renderPanel();
    await screen.findByTestId("local-ai-group-llm");
    await waitFor(() => expect(screen.getByTestId("local-model-role-llamacpp")).toBeInTheDocument());
    const trigger = screen.getByTestId("local-model-menu-llamacpp");
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.length).toBeGreaterThan(1);
    await waitFor(() => expect(items[0]).toHaveFocus());
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    await waitFor(() => expect(items[1]).toHaveFocus());
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    await waitFor(() => expect(items[0]).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("offers to wake an enabled engine that is asleep, ahead of disabling it, and says so in the footer", async () => {
    stubFetch();
    const stubbed = fetch as unknown as ReturnType<typeof vi.fn>;
    const answer = stubbed.getMockImplementation() as (input: string | URL, init?: RequestInit) => Promise<Response>;
    // Ollama's idle standby: the unit is enabled, so the only verb the menu
    // used to offer was Disable, while the row itself said "turn it on".
    const asleep = MODELS.map((m) => m.id !== "ollama" ? m : {
      ...m, enabled: true, running: "on-demand", detailCode: "ollamaStandby",
      detail: "Asleep to save memory. Wakes when a model is asked for, or turn it on now from the menu.",
    });
    stubbed.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      if (input.toString().startsWith("/setup-api/local-models") && init?.method !== "POST") {
        return new Response(JSON.stringify({ models: asleep, unavailable: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return answer(input, init);
    });
    renderPanel();
    await screen.findByTestId("local-ai-group-llm");
    const row = screen.getByTestId("local-model-ollama");
    await waitFor(() => expect(within(row).getByText(/turn it on now from the menu/)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("local-model-menu-ollama"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.getAttribute("data-testid"))).toEqual([
      "local-model-action-ollama-turn-on",
      "local-model-action-ollama-disable",
    ]);
    fireEvent.click(screen.getByTestId("local-model-action-ollama-turn-on"));
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/local-models", body: { id: "ollama", enabled: true } }));
    // "Disable", the menu's verb — standby also turns the engine off, and that comes back.
    await waitFor(() => expect(screen.getByText("Anything you disable stays off after a restart.")).toBeInTheDocument());
  });

  it("renders each row's lines from their codes in the owner's language, and keeps the server's English for a code it does not know", async () => {
    stubFetch();
    const stubbed = fetch as unknown as ReturnType<typeof vi.fn>;
    const answer = stubbed.getMockImplementation() as (input: string | URL, init?: RequestInit) => Promise<Response>;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const coded = [
      model({ id: "ollama", name: "Ollama", kind: "llm", runtimeCode: "runsExtraModels", enabled: true, running: "running", control: "system-unit", detailCode: "ollamaServing", params: { names: "Qwen 3" }, detail: "Serving Qwen 3." }),
      model({ id: "kokoro", name: "Kokoro", kind: "tts", runtimeCode: "voiceOnBox", enabled: true, running: "running", control: "user-unit", detailCode: "kokoroSpeaking", detail: "Speaking from this box." }),
      model({ id: "whisper", name: "Whisper", kind: "stt", enabled: true, running: "running", control: "user-unit", detailCode: "somethingNewer", detail: "Only the server knows this one." }),
      model({ id: "embeddings", name: "Memory search", nameCode: "memorySearch", kind: "embedding", runtimeCode: "modelVia", params: { model: "Qwen 3", via: "Ollama" }, runtime: "Qwen 3 via Ollama", running: "running", managedBy: "clawkeep", detailCode: "embeddingsLocal", detail: "Searching your memory on this box." }),
    ];
    stubbed.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/preferences")) return json({ ui_language: "de" });
      if (url.startsWith("/setup-api/local-models") && init?.method !== "POST") return json({ models: coded, unavailable: [] });
      return answer(input, init);
    });
    renderPanel();
    await screen.findByTestId("local-ai-group-llm");
    await waitFor(() => {
      expect(within(screen.getByTestId("local-model-ollama")).getByText("Stellt Qwen 3 bereit.")).toBeInTheDocument();
      expect(within(screen.getByTestId("local-model-kokoro")).getByText("Stimme auf dieser Box")).toBeInTheDocument();
      expect(within(screen.getByTestId("local-model-embeddings")).getByText("Speichersuche")).toBeInTheDocument();
      expect(within(screen.getByTestId("local-model-embeddings")).getByText("Qwen 3 über Ollama")).toBeInTheDocument();
    });
    // A code this build has no key for must never reach the row as a raw key.
    expect(within(screen.getByTestId("local-model-whisper")).getByText("Only the server knows this one.")).toBeInTheDocument();
    expect(screen.queryByText(/localModels\./)).not.toBeInTheDocument();
  });

  it("navigates to Memory Shard from the standalone page, where no desktop listens for the open-app event", async () => {
    stubFetch({ llmDefault: true });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, pathname: "/app/settings", assign });
    renderPanel();
    await screen.findByTestId("local-ai-group-embedding");
    const opened: string[] = [];
    const onOpen = (e: Event) => opened.push((e as CustomEvent<{ appId: string }>).detail.appId);
    window.addEventListener(OPEN_APP_EVENT, onOpen);
    try {
      fireEvent.click(screen.getByTestId("local-model-manage-embedding"));
    } finally {
      window.removeEventListener(OPEN_APP_EVENT, onOpen);
    }
    expect(assign).toHaveBeenCalledWith("/app/memory-shard");
    expect(opened).toEqual([]);
  });
  it("offers to install an absent Kokoro through the voice install route", async () => {
    const absent = MODELS.map((m) => (m.id === "kokoro" ? { ...m, installed: false, enabled: null, running: "not-installed", control: "none", detail: "Not installed." } : m));
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/x-ndjson" } });
    stubFetch({ models: absent, post: (url) => (url === "/setup-api/tts/install" ? json({ success: true, status: "The voice on this box is installed." }) : undefined) });
    renderPanel();
    await screen.findByTestId("local-model-kokoro");
    fireEvent.click(screen.getByTestId("local-model-menu-kokoro"));
    fireEvent.click(await screen.findByTestId("local-model-action-kokoro-install"));
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/tts/install", body: {} }));
  });

  it("says, in amber, when a voice pick settled on the default instead", async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    stubFetch({ post: (url) => (url === "/setup-api/tts" ? json({ choice: "auto", fallback: { requested: "local", reason: "not_wired" } }) : undefined) });
    renderPanel();
    await screen.findByTestId("local-model-kokoro");
    fireEvent.click(screen.getByTestId("local-model-menu-kokoro"));
    fireEvent.click(await screen.findByTestId("local-model-action-kokoro-primary"));
    const notice = await screen.findByTestId("local-ai-notice");
    expect(notice).toHaveTextContent(/default voice/i);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

});
