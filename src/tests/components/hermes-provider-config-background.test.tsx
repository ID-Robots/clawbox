import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import HermesProviderConfig from "@/components/HermesProviderConfig";
import { PROVIDERS_CHANGED_EVENT } from "@/lib/ui-events";
import { providerTask } from "@/tests/helpers/provider-task";

/**
 * TASK-2148 on the Hermes edition's provider panel: in Settings a save is a
 * background task of the box — posted with `background: true`, followed to
 * its ending — and a panel opened while the box is connecting a provider takes
 * that task up again instead of offering a second connect over it.
 */

vi.mock("@/lib/i18n", async () => {
  const { providerEn } = await import("@/lib/edition-translations/en-provider");
  const { translations } = await import("@/lib/translations");
  return {
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    useT: () => ({
      t: (key: string, params?: Record<string, string | number>) =>
        Object.entries(params ?? {}).reduce(
          (out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
          providerEn[key] ?? translations.en[key] ?? key,
        ),
      locale: "en",
      setLocale: vi.fn(),
    }),
  };
});

vi.mock("next/image", () => ({
  default: ({ alt = "" }: { alt?: string }) => <span role="img" aria-label={alt} />,
}));

vi.mock("@/hooks/useHermesModelOptions", () => ({
  useHermesModelOptions: () => ({
    scope: {
      provider: "openrouter",
      authenticated: true,
      models: [{ id: "vendor/model-a", description: "" }],
      defaultModel: "vendor/model-a",
      current: "vendor/model-a",
      savedElsewhere: null,
      source: "dashboard",
      stale: false,
      fetchedAt: Date.now(),
    },
    loading: false,
    refresh: vi.fn(),
  }),
  notifyHermesModelState: vi.fn(),
}));

type Task = ReturnType<typeof providerTask>;

function stubBox(initial: { task?: Task | null } = {}) {
  const box = { posts: [] as Record<string, unknown>[], task: initial.task ?? null };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "/setup-api/hermes/clawai") return json({ hasToken: false, tier: "flash", tierStored: null, active: false, model: "" });
    if (url === "/setup-api/hermes/oauth") return json({ providers: [] });
    if (url === "/setup-api/hermes/models" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      box.posts.push(body);
      box.task = providerTask("h-1", { provider: "openrouter", label: "OpenRouter", action: "sign-in", state: "running", step: "save" });
      return json({ taskId: "h-1", started: true, task: box.task }, 202);
    }
    if (url === "/setup-api/hermes/models") {
      return json({
        provider: "openrouter",
        current: "vendor/model-a",
        providers: [{ id: "openrouter", authenticated: true, credentialPresent: true }],
      });
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

function finished(state: "succeeded" | "failed", fields: { error?: string; result?: Record<string, unknown> } = {}): Task {
  return {
    ...providerTask("h-1", { provider: "openrouter", label: "OpenRouter", action: "sign-in", state, error: fields.error }),
    result: fields.result ?? (state === "succeeded" ? { ok: true, verified: true } : null),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HermesProviderConfig in Settings — the box connects the provider", () => {
  it("saves as one background task and finishes on the box's own ending", async () => {
    const box = stubBox();
    const changed = vi.fn();
    window.addEventListener(PROVIDERS_CHANGED_EVENT, changed);
    try {
      render(<HermesProviderConfig embedded testId="hermes-ai" />);
      fireEvent.click(await screen.findByRole("button", { name: /Save model & provider/i }));
      await waitFor(() => expect(box.posts).toHaveLength(1));
      expect(box.posts[0]).toEqual({ provider: "openrouter", model: "vendor/model-a", background: true });
      expect(await screen.findByText("Setting up OpenRouter")).toBeInTheDocument();
      expect(changed).not.toHaveBeenCalled();

      box.task = finished("succeeded");
      await waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 8_000 });
      expect(box.posts).toHaveLength(1);
    } finally {
      window.removeEventListener(PROVIDERS_CHANGED_EVENT, changed);
    }
  }, 15_000);

  it("says the box's reason when the task fails", async () => {
    const box = stubBox();
    render(<HermesProviderConfig embedded testId="hermes-ai" />);
    fireEvent.click(await screen.findByRole("button", { name: /Save model & provider/i }));
    await waitFor(() => expect(box.task?.state).toBe("running"));
    box.task = finished("failed", { error: "Hermes refused that key.", result: { error: "Hermes refused that key.", httpStatus: 400 } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Hermes refused that key."), { timeout: 5_000 });
  }, 15_000);

  it("opened while the box is connecting a provider: the overlay is back on that task, and nothing is posted", async () => {
    const box = stubBox({ task: providerTask("h-1", { provider: "openrouter", label: "OpenRouter", action: "sign-in", state: "running", step: "restart" }) });
    const changed = vi.fn();
    window.addEventListener(PROVIDERS_CHANGED_EVENT, changed);
    try {
      render(<HermesProviderConfig embedded testId="hermes-ai" />);
      expect(await screen.findByText("Setting up OpenRouter")).toBeInTheDocument();
      expect(box.posts).toEqual([]);
      // Work the box runs and cannot stop: no "Start over" over it, and no
      // in-request watchdog to call it lost (the same flag holds both back).
      const { providerEn } = await import("@/lib/edition-translations/en-provider");
      expect(screen.queryByRole("button", { name: providerEn["hermesProvider.oauth.startOver"] })).not.toBeInTheDocument();
      box.task = finished("succeeded");
      await waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 8_000 });
      expect(box.posts).toEqual([]);
    } finally {
      window.removeEventListener(PROVIDERS_CHANGED_EVENT, changed);
    }
  }, 15_000);
});
