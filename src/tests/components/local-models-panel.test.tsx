import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import LocalModelsPanel from "@/components/LocalModelsPanel";

/**
 * TASK-435 — what the customer is actually told.
 *
 * The acceptance line is that a not-installed model reads as not-installed
 * "rather than as an option", so the assertions here are about the ABSENCE of
 * a control as much as the presence of a label.
 */

function model(over: Record<string, unknown> = {}) {
  return {
    id: "ollama", name: "Ollama", kind: "llm", runtime: "System service",
    installed: true, enabled: true, running: "running", diskBytes: 639_000_000,
    memoryBytes: 1_073_741_824, control: "system-unit", detail: "Serving 1 model: qwen3-embedding:0.6b.",
    ...over,
  };
}

function mockFetch(payloads: unknown[]) {
  const fn = vi.fn();
  for (const p of payloads) fn.mockResolvedValueOnce({ ok: true, json: async () => p });
  fn.mockResolvedValue({ ok: true, json: async () => payloads.at(-1) });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Local Models panel", () => {
  it("shows a running engine with its footprint", async () => {
    mockFetch([{ models: [model()], unavailable: [] }]);
    render(<LocalModelsPanel active />);
    const row = await screen.findByTestId("local-model-ollama");
    expect(within(row).getByText("Running")).toBeTruthy();
    expect(within(row).getByText(/Disk 609 MB/)).toBeTruthy();
    expect(within(row).getByText(/Memory in use 1.0 GB/)).toBeTruthy();
    expect(within(row).getByRole("switch", { name: /Ollama enabled/i })).toBeTruthy();
  });

  it("offers no switch for an engine that is not installed", async () => {
    mockFetch([{
      models: [model({ id: "kokoro", name: "Kokoro", kind: "tts", installed: false, enabled: null, running: "not-installed", control: "none", detail: "Not installed on this box. Speech falls back to Piper." })],
      unavailable: [],
    }]);
    render(<LocalModelsPanel active />);
    const row = await screen.findByTestId("local-model-kokoro");
    expect(within(row).getByText("Not installed")).toBeTruthy();
    expect(within(row).queryByRole("switch")).toBeNull();
  });

  it("does not call an on-demand engine stopped", async () => {
    mockFetch([{
      models: [model({ id: "piper", name: "Piper", kind: "tts", enabled: null, running: "on-demand", control: "none", diskBytes: null, memoryBytes: null, detail: "Speaks on demand." })],
      unavailable: [],
    }]);
    render(<LocalModelsPanel active />);
    const row = await screen.findByTestId("local-model-piper");
    expect(within(row).getByText("On demand")).toBeTruthy();
    expect(within(row).queryByText("Stopped")).toBeNull();
  });

  it("adopts the state the toggle came back with", async () => {
    const fetchMock = mockFetch([
      { models: [model({ enabled: true, running: "running" })], unavailable: [] },
      { ok: true, models: [model({ enabled: false, running: "idle", detail: "Installed and stopped." })], unavailable: [] },
    ]);
    render(<LocalModelsPanel active />);
    const sw = await screen.findByRole("switch", { name: /Ollama enabled/i });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: /Ollama enabled/i }).getAttribute("aria-checked")).toBe("false");
    });
    const post = fetchMock.mock.calls.find(c => (c[1] as { method?: string })?.method === "POST");
    expect(JSON.parse((post?.[1] as { body: string }).body)).toEqual({ id: "ollama", enabled: false });
  });

  it("reports a refusal instead of pretending the switch worked", async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [model()], unavailable: [] }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "This box does not allow the web interface to change that service." }) })
      .mockResolvedValue({ ok: true, json: async () => ({ models: [model()], unavailable: [] }) });
    vi.stubGlobal("fetch", fn);
    render(<LocalModelsPanel active />);
    const sw = await screen.findByRole("switch", { name: /Ollama enabled/i });
    fireEvent.click(sw);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/does not allow/i);
    expect(screen.getByRole("switch", { name: /Ollama enabled/i }).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps its last good reading when a later poll is not an inventory", async () => {
    // The ClawKeep lesson from TASK-398: the shared e2e mock answers any
    // unknown /setup-api/* path with `{}` and HTTP 200, and so does a proxy in
    // front of an older build. Adopting that as state read `.models` off
    // nothing on the next render and took the WHOLE window down, backups and
    // all. This drives a real second poll rather than trusting the first one.
    await expectSecondPollIgnored({});
  });

  it("refuses a payload that has models but no unavailable list", async () => {
    // Narrower than the case above and worth its own test: `{ models: [] }`
    // satisfies a guard that only checks `models`, is then stored, and the very
    // next render reads `.unavailable.length` off nothing. Guarding the field
    // you read first is not the same as guarding the shape you rely on.
    await expectSecondPollIgnored({ models: [] });
  });
});

/**
 * Render with a good inventory, let one more poll return `bad`, and assert the
 * panel is still showing the good reading afterwards.
 */
async function expectSecondPollIgnored(bad: unknown) {
  const fn = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [model()], unavailable: [] }) })
    .mockResolvedValue({ ok: true, json: async () => bad });
  vi.stubGlobal("fetch", fn);

  // Fake timers BEFORE the render, because the poll's setInterval is created
  // during it - installed afterwards they would not own that timer and
  // advancing them would do nothing. shouldAdvanceTime keeps Testing Library's
  // own async plumbing working.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<LocalModelsPanel active />);
  const row = await screen.findByTestId("local-model-ollama");
  expect(within(row).getByText("Running")).toBeTruthy();

  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(fn.mock.calls.length).toBeGreaterThan(1);

  // Still the engine from the good payload, and the panel is still standing.
  const after = screen.getByTestId("local-model-ollama");
  expect(within(after).getByText("Running")).toBeTruthy();
}
