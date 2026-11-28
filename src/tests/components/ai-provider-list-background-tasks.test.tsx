/**
 * The provider list opened while the BOX is changing a provider (TASK-2148):
 * a sign-in or a sign-out started in a Settings window that was closed
 * half-way, or in another tab, or on another device. The change is a
 * background task of the box (src/lib/provider-auth-tasks.ts); the list reads
 * it from /setup-api/background-jobs/tasks and draws the truth — in progress,
 * with the same spinner — instead of the state before the change, and
 * updates by itself when the box finishes, with no page refresh.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import AiProviderList from "@/components/AiProviderList";
import { notifyBackgroundTaskStarted } from "@/lib/background-task-client";
import { PROVIDERS_CHANGED_EVENT } from "@/lib/ui-events";
import { providerTask } from "@/tests/helpers/provider-task";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
vi.mock("@/components/AIProviderIcon", () => ({ default: () => <span data-testid="icon" /> }));

type Row = { id: string; label: string; state: string; isDefault: boolean; section: string; enabled: boolean };

const ROWS: Row[] = [
  { id: "clawai", label: "ClawBox AI", state: "connected", isDefault: true, section: "ai", enabled: true },
  { id: "openai", label: "OpenAI GPT", state: "connected", isDefault: false, section: "ai", enabled: true },
  { id: "xai", label: "xAI Grok", state: "connected", isDefault: false, section: "ai", enabled: true },
];

/** The box: its rows, and the provider task it is running (the test moves it along). */
function stubBox(initial: { rows: Row[]; task: ReturnType<typeof providerTask> | null }) {
  const box = { ...initial, posts: [] as string[] };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("/setup-api/preferences")) return json({});
    if (url.startsWith("/setup-api/providers/status")) {
      return json({ harness: "openclaw", providers: box.rows, defaultProvider: "clawai", unrunnable: [], degraded: false });
    }
    if (url.startsWith("/setup-api/background-jobs/tasks")) {
      const id = new URL(url, "http://box").searchParams.get("id");
      if (id) return box.task?.id === id ? json({ task: box.task }) : json({ error: "No such task." }, 404);
      return json({ tasks: box.task ? [box.task] : [] });
    }
    if (url === "/setup-api/providers/sign-out" && init?.method === "POST") {
      box.posts.push(url);
      return json({ error: "unexpected" }, 500);
    }
    return json({ error: "unexpected" }, 404);
  }));
  return box;
}

const renderList = () => render(<I18nProvider><AiProviderList /></I18nProvider>);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AiProviderList — a provider change the box is running", () => {
  it("opened during a sign-out: the row is in hand with its spinner, nothing is posted, and it lets go when the box is done", async () => {
    const box = stubBox({
      rows: ROWS,
      task: providerTask("t-out", { provider: "openai", label: "OpenAI GPT", state: "running", step: "restart" }),
    });
    renderList();
    // The true state, read from the box: in progress, not "connected".
    const row = await screen.findByTestId("ai-provider-openai");
    await waitFor(() => expect(row).toHaveAttribute("data-sign-out", "pending"));
    expect(screen.getByTestId("ai-provider-sign-out-spinner-openai")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("ai-provider-sign-out-openai")).toHaveTextContent("Signing out…"));
    // The task's own restart step is the row's "restarting".
    expect(await screen.findByTestId("ai-provider-sign-out-restarting-openai")).toBeInTheDocument();
    // One change at a time: every other control waits.
    expect(screen.getByTestId("ai-provider-sign-out-xai")).toBeDisabled();
    expect(screen.getByTestId("ai-provider-switch-xai")).toBeDisabled();
    expect(screen.getByTestId("ai-provider-make-default-xai")).toBeDisabled();

    // The box finishes while Settings is open: no refresh, the list follows.
    box.rows = ROWS.filter((r) => r.id !== "openai");
    box.task = providerTask("t-out", { provider: "openai", label: "OpenAI GPT", state: "succeeded" });
    await waitFor(() => expect(screen.getByTestId("ai-provider-signed-out")).toHaveTextContent("Signed out of OpenAI GPT."));
    expect(screen.queryByTestId("ai-provider-openai")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("ai-provider-sign-out-xai")).toBeEnabled());
    expect(box.posts).toEqual([]);
  });

  it("opened during a sign-out that then fails: the row comes back with the box's reason", async () => {
    const box = stubBox({
      rows: ROWS,
      task: providerTask("t-out", { provider: "xai", label: "xAI Grok", state: "running", step: "remove" }),
    });
    renderList();
    await waitFor(() => expect(screen.getByTestId("ai-provider-xai")).toHaveAttribute("data-sign-out", "pending"));
    box.task = providerTask("t-out", { provider: "xai", label: "xAI Grok", state: "failed", error: "The xAI Grok sign-in could not be removed." });
    expect(await screen.findByTestId("ai-provider-sign-out-error-xai")).toHaveTextContent("could not be removed");
    await waitFor(() => expect(screen.getByTestId("ai-provider-xai")).not.toHaveAttribute("data-sign-out"));
    expect(screen.getByTestId("ai-provider-sign-out-xai")).toHaveAccessibleName("Sign out of xAI Grok");
  });

  it("opened during a sign-in: the provider being connected is drawn with the same spinner, and becomes its row when the box is done", async () => {
    const box = stubBox({
      rows: ROWS,
      task: providerTask("t-in", { provider: "anthropic", label: "Anthropic Claude", action: "sign-in", state: "running", step: "save" }),
    });
    const changed = vi.fn();
    window.addEventListener(PROVIDERS_CHANGED_EVENT, changed);
    try {
      renderList();
      const connecting = await screen.findByTestId("ai-provider-connecting-anthropic");
      expect(connecting).toHaveTextContent("Anthropic Claude");
      await waitFor(() => expect(connecting).toHaveTextContent("Connecting…"));
      expect(screen.getByTestId("ai-provider-connecting-spinner-anthropic")).toHaveTextContent("progress_activity");
      expect(screen.getByTestId("ai-provider-sign-out-openai")).toBeDisabled();

      box.rows = [...ROWS, { id: "anthropic", label: "Anthropic Claude", state: "connected", isDefault: false, section: "ai", enabled: true }];
      box.task = providerTask("t-in", { provider: "anthropic", label: "Anthropic Claude", action: "sign-in", state: "succeeded" });
      // The box's ending is told to every provider surface, which re-read it.
      await waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5_000 });
      expect(await screen.findByTestId("ai-provider-anthropic")).toHaveTextContent("Connected");
      expect(screen.queryByTestId("ai-provider-connecting-anthropic")).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId("ai-provider-sign-out-openai")).toBeEnabled());
    } finally {
      window.removeEventListener(PROVIDERS_CHANGED_EVENT, changed);
    }
  });

  it("draws a listed provider being connected again in place, with the spinner instead of its state", async () => {
    stubBox({
      rows: ROWS,
      task: providerTask("t-in", { provider: "xai", label: "xAI Grok", action: "sign-in", state: "running", step: "restart" }),
    });
    renderList();
    const label = await screen.findByTestId("ai-provider-connecting-label-xai");
    expect(screen.getByTestId("ai-provider-xai")).toContainElement(label);
    await waitFor(() => expect(label).toHaveTextContent("Connecting…"));
    expect(screen.queryByTestId("ai-provider-connecting-xai")).not.toBeInTheDocument();
  });

  it("re-reads the box when a change ran and ended between two of its reads — a quick sign-out in another tab", async () => {
    const box = stubBox({ rows: ROWS, task: null });
    const changed = vi.fn();
    window.addEventListener(PROVIDERS_CHANGED_EVENT, changed);
    try {
      renderList();
      await screen.findByTestId("ai-provider-openai");
      // Another tab signed xAI out; this list never saw it running.
      box.rows = ROWS.filter((r) => r.id !== "xai");
      box.task = providerTask("t-out", { provider: "xai", label: "xAI Grok", state: "succeeded" });
      act(() => notifyBackgroundTaskStarted("t-out"));
      await waitFor(() => expect(changed).toHaveBeenCalled());
      await waitFor(() => expect(screen.queryByTestId("ai-provider-xai")).not.toBeInTheDocument());
    } finally {
      window.removeEventListener(PROVIDERS_CHANGED_EVENT, changed);
    }
  });

  it("picks up a change started elsewhere while it is open, as soon as a surface says so", async () => {
    const box = stubBox({ rows: ROWS, task: null });
    renderList();
    await screen.findByTestId("ai-provider-openai");
    await waitFor(() => expect(screen.getByTestId("ai-provider-sign-out-openai")).toBeEnabled());
    box.task = providerTask("t-out", { provider: "openai", label: "OpenAI GPT", state: "running", step: "remove" });
    act(() => notifyBackgroundTaskStarted("t-out"));
    await waitFor(() => expect(screen.getByTestId("ai-provider-openai")).toHaveAttribute("data-sign-out", "pending"));
  });
});
