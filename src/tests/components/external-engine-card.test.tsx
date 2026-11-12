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
  test?: () => Response | Promise<Response>;
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

/** The form filled in for BASE — plain HTTP to another machine with a key — and, unless told not to, the owner's yes to sending it. */
async function fillForm({ confirmHttp = true } = {}) {
  // By role and label, as the owner finds them: a broken label association
  // fails here as surely as a broken value.
  fireEvent.click(await screen.findByRole("button", { name: "Set up" }));
  fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: BASE } });
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: KEY } });
  fireEvent.change(screen.getByLabelText("Model id"), { target: { value: MODEL } });
  fireEvent.change(screen.getByLabelText("Context window (tokens)"), { target: { value: "131072" } });
  if (confirmHttp) fireEvent.click(screen.getByRole("checkbox", { name: "Send the key over this unencrypted connection" }));
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

  it("says a saved key is kept only for its own address", async () => {
    stub({ get: () => CONFIGURED });
    renderCard();
    fireEvent.click(await screen.findByTestId("local-ai-external-edit"));
    const keyInput = screen.getByTestId("local-ai-external-api-key") as HTMLInputElement;
    expect(keyInput.placeholder).toBe("A key is saved — leave empty to keep it");
    // Another origin never gets the saved key, so the field must not promise it.
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://engine.example/v1" } });
    expect(keyInput.placeholder).toBe("Leave empty if the engine needs none");
    // The same origin with another path keeps it.
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "http://192.0.2.10:8000/api/v1" } });
    expect(keyInput.placeholder).toBe("A key is saved — leave empty to keep it");
  });

  it("shows a save that could not switch the chat as a warning, not a success", async () => {
    const warning = "The engine is saved, but the chat could not be switched to it. Pick it in the chat header.";
    stub({ save: () => json({ success: true, ...CONFIGURED, warning }) });
    renderCard();
    await fillForm();
    fireEvent.click(screen.getByTestId("local-ai-external-save"));
    expect(await screen.findByText(warning)).toBeTruthy();
    expect(screen.getByTestId("local-ai-external-result").className).toContain("amber");
    expect(screen.getByTestId("local-ai-external-result").className).not.toContain("emerald");
  });

  it("offers Retry when the engine's settings cannot be read", async () => {
    let fail = true;
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      calls.push({ url: input.toString(), method: "GET", body: null });
      return fail ? json({ error: "boom" }, 500) : json(NOT_CONFIGURED);
    }));
    renderCard();
    expect(await screen.findByText("The external engine's settings could not be read.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Set up" })).toBeTruthy();
    expect(screen.getByText("No external engine is set up.")).toBeTruthy();
    expect(screen.queryByText("The external engine's settings could not be read.")).toBeNull();
  });

  it("says the check failed rather than checking forever when the probe read fails", async () => {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = input.toString();
      calls.push({ url, method: "GET", body: null });
      return url.includes("probe=1") ? json({ error: "boom" }, 500) : json(CONFIGURED);
    }));
    renderCard();
    expect(await screen.findByText("Local AI answers with Qwen3-32B.")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("local-ai-external-status").textContent).toBe("The engine could not be checked just now."));
  });

  it("keeps the last good view but says a failed read-back after a save failed, and offers Retry", async () => {
    let fail = false;
    calls = [];
    const OK = { ...CONFIGURED, baseUrl: "https://engine.example.com/v1", status: { reachable: true, modelListed: true, latencyMs: 12 } };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: null });
      if (method === "POST") { fail = true; return json({ success: true, ...OK }); }
      return fail ? json({ error: "boom" }, 500) : json(OK);
    }));
    renderCard();
    await waitFor(() => expect(screen.getByTestId("local-ai-external-status").textContent).toContain("12"));
    expect(screen.queryByTestId("local-ai-external-retry")).toBeNull();
    // Saved; the read back after the save fails: the old status must not stand.
    fireEvent.click(screen.getByTestId("local-ai-external-edit"));
    fireEvent.click(screen.getByTestId("local-ai-external-save"));
    await waitFor(() => expect(screen.getByTestId("local-ai-external-status").textContent).toBe("The engine could not be checked just now."));
    expect(screen.getByText("Local AI answers with Qwen3-32B.")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByTestId("local-ai-external-retry"));
    await waitFor(() => expect(screen.getByTestId("local-ai-external-status").textContent).toContain("12"));
    expect(screen.queryByTestId("local-ai-external-retry")).toBeNull();
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

  it("greys the reasoning switch on Hermes and says Hermes sends the chat's level itself (TASK-2497)", async () => {
    stub({ get: () => ({ ...CONFIGURED, reasoning: true, activeHarness: "hermes", unsupported: ["maxTokens", "imageInput", "reasoning"] }) });
    renderCard();
    fireEvent.click(await screen.findByTestId("local-ai-external-edit"));
    const box = screen.getByTestId("local-ai-external-reasoning") as HTMLInputElement;
    expect(box.disabled).toBe(true);
    // The record's value is shown as it is, and a save on Hermes sends it back unchanged.
    expect(box.checked).toBe(true);
    expect(screen.getByText("Not used on Hermes: Hermes sends the chat's reasoning level to the engine itself on every turn.")).toBeTruthy();
    // Hermes' summary does not claim OpenClaw's ladder.
    expect(screen.queryByTestId("local-ai-external-reasoning-on")).toBeNull();
  });

  it("sends no key over plain HTTP to another machine before the owner says yes", async () => {
    stub({});
    renderCard();
    await fillForm({ confirmHttp: false });
    expect(screen.getByTestId("local-ai-external-http-warning").textContent).toContain("unencrypted");
    const test = screen.getByTestId("local-ai-external-test") as HTMLButtonElement;
    const save = screen.getByTestId("local-ai-external-save") as HTMLButtonElement;
    expect(test.disabled).toBe(true);
    expect(save.disabled).toBe(true);
    fireEvent.click(test);
    fireEvent.submit(screen.getByTestId("local-ai-external-form"));
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);

    fireEvent.click(screen.getByTestId("local-ai-external-http-confirm"));
    expect(test.disabled).toBe(false);
    fireEvent.click(test);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/test"))).toBe(true));

    // A new address asks again.
    fireEvent.change(screen.getByTestId("local-ai-external-base-url"), { target: { value: "http://198.51.100.7:8000/v1" } });
    expect((screen.getByTestId("local-ai-external-http-confirm") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("local-ai-external-test") as HTMLButtonElement).disabled).toBe(true);
    // HTTPS needs no yes at all.
    fireEvent.change(screen.getByTestId("local-ai-external-base-url"), { target: { value: "https://engine.example.com/v1" } });
    expect(screen.queryByTestId("local-ai-external-http-warning")).toBeNull();
    expect((screen.getByTestId("local-ai-external-test") as HTMLButtonElement).disabled).toBe(false);
  });

  it("never carries a yes to plain HTTP over a Cancel into a reopened form", async () => {
    stub({ get: () => CONFIGURED });
    renderCard();
    fireEvent.click(await screen.findByTestId("local-ai-external-edit"));
    // The saved engine is plain HTTP to another machine with a key on file.
    fireEvent.click(screen.getByTestId("local-ai-external-http-confirm"));
    expect((screen.getByTestId("local-ai-external-test") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByTestId("local-ai-external-edit"));
    expect((screen.getByTestId("local-ai-external-http-confirm") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("local-ai-external-test") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("local-ai-external-save") as HTMLButtonElement).disabled).toBe(true);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
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
    // Loopback is the whole address, in any spelling the URL parser folds to it,
    // never a public name that merely starts with "127.".
    expect(sendsKeyInClear(form("http://127.1:8000/v1"), false)).toBe(false);
    expect(sendsKeyInClear(form("http://2130706433:8000/v1"), false)).toBe(false);
    expect(sendsKeyInClear(form("http://127.engine.example/v1"), false)).toBe(true);
    expect(sendsKeyInClear(form("http://127.0.0.1.example.com/v1"), false)).toBe(true);
  });

  it("will not save while Local-only mode is on", async () => {
    stub({ get: () => ({ ...NOT_CONFIGURED, localOnlyMode: true }) });
    renderCard();
    fireEvent.click(await screen.findByTestId("local-ai-external-setup"));
    expect((screen.getByTestId("local-ai-external-save") as HTMLButtonElement).disabled).toBe(true);
  });

  describe("the reasoning switch (TASK-2497)", () => {
    it("is off for a new engine and saves as off unless the owner turns it on", async () => {
      stub({});
      renderCard();
      await fillForm();
      const box = screen.getByRole("checkbox", { name: "The model reasons (thinking levels)" }) as HTMLInputElement;
      expect(box.checked).toBe(false);
      expect(box.disabled).toBe(false);
      fireEvent.click(screen.getByTestId("local-ai-external-save"));
      await screen.findByText("Saved. The chat now uses Qwen3-32B.");
      const save = calls.find((c) => c.url === "/setup-api/local-ai/external" && c.method === "POST")!;
      expect(save.body).toMatchObject({ reasoning: false });
    });

    it("saves it on, and the summary and a re-opened form say so", async () => {
      let configured = false;
      stub({
        get: () => (configured ? { ...CONFIGURED, reasoning: true } : NOT_CONFIGURED),
        save: () => { configured = true; return json({ success: true, ...CONFIGURED, reasoning: true }); },
      });
      renderCard();
      await fillForm();
      fireEvent.click(screen.getByRole("checkbox", { name: "The model reasons (thinking levels)" }));
      fireEvent.click(screen.getByTestId("local-ai-external-save"));
      expect(await screen.findByText("Reasoning: on. The chat offers Off, Low, Medium and High.")).toBeTruthy();
      const save = calls.find((c) => c.url === "/setup-api/local-ai/external" && c.method === "POST")!;
      expect(save.body).toMatchObject({ reasoning: true });
      fireEvent.click(screen.getByTestId("local-ai-external-edit"));
      expect((screen.getByTestId("local-ai-external-reasoning") as HTMLInputElement).checked).toBe(true);
    });

    it("Test asks the engine whether it reasons only while the switch is off, and offers to turn it on", async () => {
      stub({ test: () => json({ ok: true, models: [MODEL], latencyMs: 12, reasoningDetected: true }) });
      renderCard();
      await fillForm();
      fireEvent.click(screen.getByTestId("local-ai-external-test"));
      expect(await screen.findByText("The engine returned reasoning for a test request. Turn on reasoning to use the chat's thinking levels.")).toBeTruthy();
      expect(calls.find((c) => c.url.endsWith("/test"))!.body).toMatchObject({ detectReasoning: true, reasoning: false });
      // The suggestion never flips the switch by itself; its button does.
      const box = screen.getByTestId("local-ai-external-reasoning") as HTMLInputElement;
      expect(box.checked).toBe(false);
      fireEvent.click(screen.getByTestId("local-ai-external-reasoning-enable"));
      expect(box.checked).toBe(true);
      expect(screen.queryByTestId("local-ai-external-reasoning-suggest")).toBeNull();
      // With it on, Test no longer asks.
      calls = [];
      fireEvent.click(screen.getByTestId("local-ai-external-test"));
      await waitFor(() => expect(calls.some((c) => c.url.endsWith("/test"))).toBe(true));
      expect(calls.find((c) => c.url.endsWith("/test"))!.body).not.toHaveProperty("detectReasoning");
    });

    it("drops the suggestion once the model or address is no longer the one Test asked", async () => {
      stub({ test: () => json({ ok: true, models: [MODEL], latencyMs: 12, reasoningDetected: true }) });
      renderCard();
      await fillForm();
      fireEvent.click(screen.getByTestId("local-ai-external-test"));
      await screen.findByTestId("local-ai-external-reasoning-suggest");
      fireEvent.change(screen.getByLabelText("Model id"), { target: { value: "other-model" } });
      expect(screen.queryByTestId("local-ai-external-reasoning-suggest")).toBeNull();
      // Back on the tested model, the answer is about it again.
      fireEvent.change(screen.getByLabelText("Model id"), { target: { value: MODEL } });
      expect(screen.getByTestId("local-ai-external-reasoning-suggest")).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "http://192.0.2.99:8000/v1" } });
      expect(screen.queryByTestId("local-ai-external-reasoning-suggest")).toBeNull();
    });

    it("an answer that arrives after the model was changed suggests nothing for the new one", async () => {
      let answer!: (r: Response) => void;
      stub({ test: () => new Promise<Response>((resolve) => { answer = resolve; }) });
      renderCard();
      await fillForm();
      fireEvent.click(screen.getByTestId("local-ai-external-test"));
      await waitFor(() => expect(calls.some((c) => c.url.endsWith("/test"))).toBe(true));
      fireEvent.change(screen.getByLabelText("Model id"), { target: { value: "other-model" } });
      answer(json({ ok: true, models: [MODEL, "other-model"], latencyMs: 12, reasoningDetected: true }));
      await screen.findByText(`The engine answers and lists ${MODEL} (12 ms).`);
      expect(screen.queryByTestId("local-ai-external-reasoning-suggest")).toBeNull();
    });

    it("suggests nothing when the engine does not reason", async () => {
      stub({ test: () => json({ ok: true, models: [MODEL], latencyMs: 12, reasoningDetected: false }) });
      renderCard();
      await fillForm();
      fireEvent.click(screen.getByTestId("local-ai-external-test"));
      await screen.findByText(`The engine answers and lists ${MODEL} (12 ms).`);
      expect(screen.queryByTestId("local-ai-external-reasoning-suggest")).toBeNull();
    });
  });
});
