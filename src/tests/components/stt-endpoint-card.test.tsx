import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import SttEndpointCard from "@/components/local-ai/SttEndpointCard";

/**
 * Settings → Local AI → Speech to text → Your speech server (TASK-2501 PR-D):
 * test, save (which makes it the engine), use and remove, through
 * /setup-api/stt/endpoint and /setup-api/stt; the key is typed once and never
 * shown back; the local-only AI lock is said in words.
 */

vi.setConfig({ testTimeout: 30_000 });

const BASE = "http://192.168.1.20:8000/v1";
type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const NOT_CONFIGURED = { primary: "local", localOnly: false, engines: { endpoint: { configured: false } } };
const SAVED = { primary: "endpoint", localOnly: false, engines: { endpoint: { configured: true, baseUrl: BASE, model: "whisper-1", apiKeySet: true } } };

function stub(answers: { status?: () => unknown; save?: () => Response; remove?: () => Response; use?: () => Response }) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/setup-api/stt/endpoint" && method === "POST") return answers.save?.() ?? json({ ok: true, latencyMs: 7, configured: true });
    if (url === "/setup-api/stt/endpoint" && method === "DELETE") return answers.remove?.() ?? json({ ok: true, configured: false });
    if (url === "/setup-api/stt" && method === "POST") return answers.use?.() ?? json({ ok: true });
    if (url === "/setup-api/stt") return json(answers.status?.() ?? NOT_CONFIGURED);
    return json({ error: "unexpected" }, 404);
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("SttEndpointCard", () => {
  it("tests a server without saving it", async () => {
    stub({});
    render(<I18nProvider><SttEndpointCard /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Add a server" }));
    fireEvent.change(screen.getByLabelText("Server address"), { target: { value: BASE } });
    fireEvent.change(screen.getByLabelText("API key (optional)"), { target: { value: "lan-key" } });
    fireEvent.click(screen.getByTestId("local-ai-stt-endpoint-test"));
    expect(await screen.findByText("The server answered in 7 ms.")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ baseUrl: BASE, model: "", apiKey: "lan-key", test: true });
  });

  it("saves and says where dictation now goes, then reports the server in use", async () => {
    let saved = false;
    stub({ status: () => (saved ? SAVED : NOT_CONFIGURED), save: () => { saved = true; return json({ ok: true }); } });
    const onChanged = vi.fn();
    render(<I18nProvider><SttEndpointCard onChanged={onChanged} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Add a server" }));
    fireEvent.change(screen.getByLabelText("Server address"), { target: { value: BASE } });
    fireEvent.click(screen.getByTestId("local-ai-stt-endpoint-save"));
    expect(await screen.findByText("Saved. Dictation and channel voice notes now go to this server.")).toBeTruthy();
    expect(await screen.findByText(`Dictation and channel voice notes are transcribed by ${BASE} (whisper-1).`)).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
    // The key is never shown back.
    expect(document.body.textContent).not.toContain("lan-key");
  });

  it("names a refused address in the owner's words", async () => {
    stub({ save: () => json({ error: "x", code: "address_refused" }, 400) });
    render(<I18nProvider><SttEndpointCard /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Add a server" }));
    fireEvent.change(screen.getByLabelText("Server address"), { target: { value: "http://8.8.8.8/v1" } });
    fireEvent.click(screen.getByTestId("local-ai-stt-endpoint-save"));
    expect(await screen.findByText("The speech server must be on this box or on your local network, not on the internet.")).toBeTruthy();
  });

  it("offers Use for a saved server not in use, and a two-tap Remove", async () => {
    stub({ status: () => ({ ...SAVED, primary: "local" }) });
    render(<I18nProvider><SttEndpointCard /></I18nProvider>);
    expect(await screen.findByText(`Saved: ${BASE} (whisper-1). Not in use.`)).toBeTruthy();
    fireEvent.click(screen.getByTestId("local-ai-stt-endpoint-use"));
    await waitFor(() => expect(calls.some((c) => c.url === "/setup-api/stt" && c.method === "POST" && c.body?.primary === "endpoint")).toBe(true));
    fireEvent.click(screen.getByTestId("local-ai-stt-endpoint-remove"));
    fireEvent.click(await screen.findByTestId("local-ai-stt-endpoint-remove-confirm"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("says the local-only AI lock in words", async () => {
    stub({ status: () => ({ ...NOT_CONFIGURED, localOnly: true }) });
    render(<I18nProvider><SttEndpointCard /></I18nProvider>);
    expect((await screen.findByTestId("local-ai-stt-endpoint-local-only")).textContent).toMatch(/never in the cloud/);
  });
});
