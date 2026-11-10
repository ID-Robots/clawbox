import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import ExternalEngineCard, { sendsKeyInClear } from "@/components/local-ai/ExternalEngineCard";
import { PROVIDERS_CHANGED_EVENT } from "@/lib/ui-events";

/**
 * Settings → Local AI → External engine (TASK-2376): set up, test, save and
 * remove, through the one route; the key is typed once and never shown back.
 */

// The first render loads a locale chunk (a ~300 KB module): a cold transform
// of it alone can pass vitest's 5 s default on a loaded runner.
vi.setConfig({ testTimeout: 30_000 });

const KEY = "sk-test-external-engine-placeholder-0123456789";
const BASE = "http://192.0.2.10:8000/v1";
const MODEL = "Qwen/Qwen3-32B";

type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const NOT_CONFIGURED = { configured: false, activeHarness: "openclaw", localOnlyMode: false, hermesMinContextWindow: 64000, unsupported: [] };
const CONFIGURED = {
  configured: true, providerId: "clawext", modelRef: `clawext/${MODEL}`, displayName: "Qwen3-32B", baseUrl: BASE,
  modelId: MODEL, contextWindow: 131072, maxTokens: 8192, imageInput: false, apiKeySet: true, activeHarness: "openclaw",
  localOnlyMode: false, hermesMinContextWindow: 64000, unsupported: [],
};

function stub(answers: {
  get?: () => unknown;
  test?: () => Response;
  save?: () => Response;
  remove?: () => Response;
}) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/setup-api/local-ai/external/test") return answers.test?.() ?? json({ ok: true, models: [MODEL], latencyMs: 12 });
    if (url.startsWith("/setup-api/local-ai/external")) {
      if (method === "POST") return answers.save?.() ?? json({ success: true, ...CONFIGURED });
      if (method === "DELETE") return answers.remove?.() ?? json({ success: true, removed: true });
      return json(answers.get?.() ?? NOT_CONFIGURED);
    }
    return json({ error: "unexpected" }, 404);
  }));
}

function renderCard(onChanged = vi.fn()) {
  render(<I18nProvider><ExternalEngineCard onChanged={onChanged} /></I18nProvider>);
  return onChanged;
}

async function fillForm() {
  fireEvent.click(await screen.findByTestId("local-ai-external-setup"));
  fireEvent.change(screen.getByTestId("local-ai-external-base-url"), { target: { value: BASE } });
  fireEvent.change(screen.getByTestId("local-ai-external-api-key"), { target: { value: KEY } });
  fireEvent.change(screen.getByTestId("local-ai-external-model"), { target: { value: MODEL } });
  fireEvent.change(screen.getByTestId("local-ai-external-context"), { target: { value: "131072" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ExternalEngineCard", () => {
  it("tests an endpoint without saving anything", async () => {
    stub({});
    renderCard();
    await fillForm();
    fireEvent.click(screen.getByTestId("local-ai-external-test"));
    expect(await screen.findByText(`The engine answers and lists ${MODEL} (12 ms).`)).toBeTruthy();
    const test = calls.find((c) => c.url.endsWith("/test"))!;
    expect(test.body).toMatchObject({ baseUrl: BASE, apiKey: KEY, modelId: MODEL, contextWindow: "131072" });
    expect(calls.some((c) => c.url === "/setup-api/local-ai/external" && c.method === "POST")).toBe(false);
  });

  it("offers the models the engine does list when the id is not one of them", async () => {
    stub({ test: () => json({ ok: false, code: "model_not_listed", models: ["qwen3-32b-awq", "other"], error: "x" }) });
    renderCard();
    await fillForm();
    fireEvent.click(screen.getByTestId("local-ai-external-test"));
    expect(await screen.findByText("The engine does not list this model id.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "qwen3-32b-awq" }));
    expect((screen.getByTestId("local-ai-external-model") as HTMLInputElement).value).toBe("qwen3-32b-awq");
  });

  it("names a refused key in the owner's words, not the server's", async () => {
    stub({ save: () => json({ error: "The engine refused the API key (HTTP 401).", code: "unauthorized" }, 422) });
    renderCard();
    await fillForm();
    fireEvent.click(screen.getByTestId("local-ai-external-save"));
    expect(await screen.findByText("The engine refused the API key. Check it — or, if the engine needs no key, tick “Remove the saved key” (or leave the field empty when none is saved).")).toBeTruthy();
  });

  it("saves, tells the rest of the desktop, and never shows the key back", async () => {
    let configured = false;
    stub({ get: () => (configured ? { ...CONFIGURED, status: { reachable: true, modelListed: true, latencyMs: 9 } } : NOT_CONFIGURED), save: () => { configured = true; return json({ success: true, ...CONFIGURED }); } });
    const changed = vi.fn();
    window.addEventListener(PROVIDERS_CHANGED_EVENT, changed);
    try {
      const onChanged = renderCard();
      await fillForm();
      fireEvent.click(screen.getByTestId("local-ai-external-save"));
      expect(await screen.findByText("Saved. The chat now uses Qwen3-32B.")).toBeTruthy();
      expect(await screen.findByText("Local AI answers with Qwen3-32B.")).toBeTruthy();
      expect(await screen.findByText("The engine answers and lists the model (9 ms).")).toBeTruthy();
      const save = calls.find((c) => c.url === "/setup-api/local-ai/external" && c.method === "POST")!;
      expect(save.body).toMatchObject({ baseUrl: BASE, apiKey: KEY, modelId: MODEL, imageInput: false });
      expect(onChanged).toHaveBeenCalled();
      expect(changed).toHaveBeenCalled();
      expect(document.body.innerHTML).not.toContain(KEY);
      // Editing again starts with an EMPTY key field that says one is kept.
      fireEvent.click(screen.getByTestId("local-ai-external-edit"));
      const keyInput = screen.getByTestId("local-ai-external-api-key") as HTMLInputElement;
      expect(keyInput.value).toBe("");
      expect(keyInput.placeholder).toBe("A key is saved — leave empty to keep it");
    } finally {
      window.removeEventListener(PROVIDERS_CHANGED_EVENT, changed);
    }
  });

  it("removes only on the second tap", async () => {
    let configured = true;
    stub({ get: () => (configured ? CONFIGURED : NOT_CONFIGURED), remove: () => { configured = false; return json({ success: true, removed: true }); } });
    renderCard();
    fireEvent.click(await screen.findByTestId("local-ai-external-remove"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByTestId("local-ai-external-remove-confirm"));
    expect(await screen.findByText("Removed. Local AI is back to what it was before.")).toBeTruthy();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId("local-ai-external-setup")).toBeTruthy());
  });

  it("on Hermes says what Hermes decides itself and greys those fields", async () => {
    stub({ get: () => ({ ...NOT_CONFIGURED, activeHarness: "hermes", unsupported: ["maxTokens", "imageInput"] }) });
    renderCard();
    fireEvent.click(await screen.findByTestId("local-ai-external-setup"));
    expect(screen.getByTestId("local-ai-external-hermes-note").textContent).toContain("at least 64,000 tokens");
    expect((screen.getByTestId("local-ai-external-max-tokens") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("local-ai-external-image") as HTMLInputElement).disabled).toBe(true);
  });

  it("warns before a key would travel unencrypted to another machine", async () => {
    stub({});
    renderCard();
    await fillForm();
    expect(screen.getByTestId("local-ai-external-http-warning").textContent).toContain("unencrypted");
    fireEvent.change(screen.getByTestId("local-ai-external-base-url"), { target: { value: "https://engine.example.com/v1" } });
    expect(screen.queryByTestId("local-ai-external-http-warning")).toBeNull();
  });

  it("knows when HTTP carries a key off the box", () => {
    const form = (baseUrl: string, apiKey = KEY, clearApiKey = false) => ({ baseUrl, apiKey, clearApiKey });
    expect(sendsKeyInClear(form("http://192.0.2.10:8000/v1"), false)).toBe(true);
    expect(sendsKeyInClear(form("http://192.0.2.10:8000/v1", ""), true)).toBe(true);
    expect(sendsKeyInClear(form("http://192.0.2.10:8000/v1", "", true), true)).toBe(false);
    expect(sendsKeyInClear(form("http://192.0.2.10:8000/v1", ""), false)).toBe(false);
    expect(sendsKeyInClear(form("https://192.0.2.10/v1"), false)).toBe(false);
    expect(sendsKeyInClear(form("http://127.0.0.1:8000/v1"), false)).toBe(false);
    expect(sendsKeyInClear(form("http://localhost:8000/v1"), false)).toBe(false);
    expect(sendsKeyInClear(form("http://[::1]:8000/v1"), false)).toBe(false);
    expect(sendsKeyInClear(form("not a url"), false)).toBe(false);
  });

  it("will not save while Local-only mode is on", async () => {
    stub({ get: () => ({ ...NOT_CONFIGURED, localOnlyMode: true }) });
    renderCard();
    fireEvent.click(await screen.findByTestId("local-ai-external-setup"));
    expect((screen.getByTestId("local-ai-external-save") as HTMLButtonElement).disabled).toBe(true);
  });
});
