import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import AIModelsStep from "@/components/AIModelsStep";
import { BACKGROUND_TASK_EVENT } from "@/lib/background-task-client";
import { waitForGatewayAfterRestart } from "@/lib/wait-for-gateway";
import { providerTask } from "@/tests/helpers/provider-task";

/**
 * TASK-2148. Connecting a provider in Settings is the BOX's work: the panel
 * asks the configure route for its save as a background task (`background:
 * true`), follows that task to its ending — the restart already waited out on
 * the box — and, opened while the box is still connecting a provider (Settings
 * closed half-way, another tab, another device), takes the same task up again
 * instead of offering to connect a provider that is being connected.
 */

vi.mock("@/lib/wait-for-gateway", () => ({
  GATEWAY_BACK_WAIT_MS: 180_000,
  waitForGatewayAfterRestart: vi.fn(async () => true),
}));

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string) => ({
      "ai.credentialsVerified": "Credentials verified",
      "ai.updatingConfig": "Updating AI configuration",
      "ai.restartingGateway": "Restarting gateway service",
      "ai.warmingUp": "Warming up models",
      "ai.almostReady": "Almost ready",
      "ai.configured": "AI model configured!",
      "ai.showMore": "Show more providers...",
      "settings.connect": "Connect",
      connecting: "Connecting...",
    } as Record<string, string>)[key] ?? key,
  }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useOllamaModels", () => ({
  useOllamaModels: () => ({
    ollamaRunning: true,
    ollamaModels: [],
    ollamaSearch: "",
    ollamaSearchResults: [],
    ollamaSearching: false,
    ollamaPulling: false,
    ollamaPullProgress: null,
    ollamaSaving: false,
    checkOllamaStatus: vi.fn(),
    handleOllamaSearchChange: vi.fn(),
    pullOllamaModel: vi.fn(),
    saveOllamaConfig: vi.fn(),
    deleteOllamaModel: vi.fn(),
    formatOllamaBytes: vi.fn((bytes: number) => `${bytes}`),
    clearSearch: vi.fn(),
  }),
}));

vi.mock("@/hooks/useLlamaCppModels", () => ({
  useLlamaCppModels: () => ({
    llamaCppRunning: false,
    llamaCppInstalled: true,
    llamaCppModels: [],
    llamaCppEndpoint: "http://127.0.0.1:8080/v1",
    llamaCppSaving: false,
    llamaCppProgress: null,
    checkLlamaCppStatus: vi.fn(),
    saveLlamaCppConfig: vi.fn(),
  }),
}));

type Task = ReturnType<typeof providerTask>;

interface Box {
  /** Every configure body posted. */
  posts: Record<string, unknown>[];
  /** The provider task the box is running (or ran); the test moves it along. */
  task: Task | null;
  /** What a configure POST answers: start the task (default), or this refusal. */
  refuse?: { status: number; body: Record<string, unknown> };
}

function stubBox(initial: Partial<Box> = {}): Box {
  const box: Box = { posts: [], task: null, ...initial };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/setup-api/ai-models/oauth/providers")) return json({ providers: [] });
    if (url.includes("/setup-api/ai-models/configure") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      box.posts.push(body);
      if (box.refuse) return json(box.refuse.body, box.refuse.status);
      if (body.background !== true) return json({ success: true });
      box.task = providerTask("t-1", {
        provider: "anthropic",
        label: "Anthropic Claude",
        action: "sign-in",
        state: "running",
        step: "save",
        status: "Saving the Anthropic Claude sign-in on the box…",
      });
      return json({ taskId: box.task.id, started: true, task: box.task }, 202);
    }
    if (url.startsWith("/setup-api/background-jobs/tasks")) {
      const id = new URL(url, "http://box").searchParams.get("id");
      if (id) return box.task?.id === id ? json({ task: box.task }) : json({ error: "No such task." }, 404);
      return json({ tasks: box.task ? [box.task] : [] });
    }
    return json({});
  }));
  return box;
}

function renderStep(embedded: boolean, onConfigured = vi.fn(), onNext = vi.fn()) {
  return render(
    <AIModelsStep
      embedded={embedded}
      providerIds={["clawai", "openai", "anthropic", "google", "openrouter"]}
      defaultProviderId="clawai"
      onConfigured={onConfigured}
      onNext={onNext}
    />,
  );
}

async function saveAnthropicKey(utils: ReturnType<typeof renderStep>) {
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers"));
  const more = utils.queryByRole("button", { name: /Show more providers/i });
  if (more) fireEvent.click(more);
  fireEvent.click(utils.getByRole("radio", { name: /Anthropic Claude/i }));
  const keyInput = utils.container.querySelector("input[type=password], input[type=text]");
  expect(keyInput).not.toBeNull();
  fireEvent.change(keyInput as HTMLInputElement, { target: { value: "sk-ant-test" } });
  const connect = utils.getAllByRole("button").find((button) =>
    /^(Connect|Connect to Anthropic Claude)$/.test(button.textContent?.trim() ?? ""));
  expect(connect).toBeDefined();
  fireEvent.click(connect as HTMLElement);
}

function succeeded(result: Record<string, unknown>): Task {
  return { ...providerTask("t-1", { provider: "anthropic", label: "Anthropic Claude", action: "sign-in", state: "succeeded" }), result };
}

describe("AIModelsStep in Settings — the box connects the provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks for the save as a background task, follows it, and finishes on the box's own ending", async () => {
    const box = stubBox();
    const onConfigured = vi.fn();
    const started = vi.fn();
    window.addEventListener(BACKGROUND_TASK_EVENT, started);
    try {
      const utils = renderStep(true, onConfigured);
      await saveAnthropicKey(utils);

      await waitFor(() => expect(box.posts).toHaveLength(1));
      expect(box.posts[0]).toMatchObject({ provider: "anthropic", apiKey: "sk-ant-test", background: true });
      // The corner card is told at once, and the overlay says what the box is doing.
      await waitFor(() => expect(started).toHaveBeenCalled());
      expect(await utils.findByText("Saving the Anthropic Claude sign-in on the box…")).toBeInTheDocument();
      expect(onConfigured).not.toHaveBeenCalled();

      box.task = succeeded({ success: true, gatewayRestarting: false, status: "Connected to Anthropic Claude.", verified: true });
      await waitFor(() => expect(onConfigured).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      // The restart was the box's to wait out, not the window's.
      expect(waitForGatewayAfterRestart).not.toHaveBeenCalled();
      expect(box.posts).toHaveLength(1);
    } finally {
      window.removeEventListener(BACKGROUND_TASK_EVENT, started);
    }
  });

  it("shows the box's own sentence when the task fails", async () => {
    const box = stubBox();
    const onConfigured = vi.fn();
    const utils = renderStep(true, onConfigured);
    await saveAnthropicKey(utils);
    await waitFor(() => expect(box.task?.state).toBe("running"));
    box.task = { ...providerTask("t-1", { provider: "anthropic", label: "Anthropic Claude", action: "sign-in", state: "failed", error: "The Anthropic key was refused." }), result: { error: "The Anthropic key was refused." } };
    expect(await utils.findByText("The Anthropic key was refused.", {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(onConfigured).not.toHaveBeenCalled();
  });

  it("says why when the box is busy with another provider change, and follows nothing", async () => {
    const box = stubBox({
      refuse: {
        status: 409,
        body: { error: "OpenAI GPT is being signed out right now. Try again when it has finished.", code: "provider_change_running", taskId: "other" },
      },
    });
    const utils = renderStep(true);
    await saveAnthropicKey(utils);
    expect(await utils.findByText("OpenAI GPT is being signed out right now. Try again when it has finished.")).toBeInTheDocument();
    const reads = vi.mocked(fetch).mock.calls.map(([input]) => String(input)).filter((url) => url.includes("tasks?id="));
    expect(reads).toEqual([]);
    expect(box.posts).toHaveLength(1);
  });

  it("opened while the box is connecting a provider: the overlay is back on that task, nothing is posted, and it finishes when the box does", async () => {
    const box = stubBox({
      task: providerTask("t-1", {
        provider: "anthropic",
        label: "Anthropic Claude",
        action: "sign-in",
        state: "running",
        step: "restart",
        status: "Restarting the assistant to use the new sign-in…",
      }),
    });
    const onConfigured = vi.fn();
    const utils = renderStep(true, onConfigured);

    expect(await utils.findByText("Restarting the assistant to use the new sign-in…")).toBeInTheDocument();
    expect(utils.getByText("ai.settingUp")).toBeInTheDocument();
    expect(box.posts).toEqual([]);

    box.task = succeeded({ success: true, gatewayRestarting: false, status: "Connected to Anthropic Claude.", verified: true });
    await waitFor(() => expect(onConfigured).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    // Taken up once, however often the box is asked again afterwards.
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    expect(onConfigured).toHaveBeenCalledTimes(1);
    expect(box.posts).toEqual([]);
  });

  it("the setup wizard keeps the request-long save", async () => {
    const box = stubBox();
    const onNext = vi.fn();
    const utils = renderStep(false, vi.fn(), onNext);
    await saveAnthropicKey(utils);
    await waitFor(() => expect(box.posts).toHaveLength(1));
    expect(box.posts[0]).not.toHaveProperty("background");
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input)).filter((url) => url.startsWith("/setup-api/background-jobs"))).toEqual([]);
  });
});
