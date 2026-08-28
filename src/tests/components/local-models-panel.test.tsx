import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import LocalModelsPanel from "@/components/LocalModelsPanel";
import { I18nProvider } from "@/lib/i18n";

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

/**
 * Queue the answers the panel's own endpoint gives, oldest first; the last one
 * is sticky and answers every later poll.
 *
 * Routed by URL rather than by call order because the panel renders under
 * I18nProvider, which fetches the saved language on mount. A positional queue
 * would hand that request the first inventory and hand the panel the language
 * reply. The returned array records only the panel's calls, so a test can
 * still count polls.
 */
function mockFetch(payloads: unknown[], statuses: boolean[] = []) {
  const calls: [string, RequestInit | undefined][] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/setup-api/preferences")) {
      return { ok: true, json: async () => ({}) };
    }
    const i = Math.min(calls.length, payloads.length - 1);
    calls.push([String(url), init]);
    return { ok: statuses[i] ?? true, json: async () => payloads[i] };
  }));
  return calls;
}

/**
 * Render the panel with the copy it actually ships with, and wait until both
 * the inventory and the catalogue have landed — the footer is the last line of
 * the loaded panel, so the assertions after this are about real sentences.
 */
async function renderPanel() {
  render(<I18nProvider><LocalModelsPanel active /></I18nProvider>);
  await screen.findByText("Turning a model off stops it now and keeps it off after a reboot.");
}

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Local Models panel", () => {
  it("shows a running engine with its footprint", async () => {
    mockFetch([{ models: [model()], unavailable: [] }]);
    await renderPanel();
    const row = screen.getByTestId("local-model-ollama");
    expect(within(row).getByText("Running")).toBeTruthy();
    expect(within(row).getByText(/Disk 609 MB/)).toBeTruthy();
    expect(within(row).getByText(/Memory in use 1.0 GB/)).toBeTruthy();
    expect(within(row).getByRole("switch", { name: /Ollama enabled/i })).toBeTruthy();
  });

  it("offers no switch for an engine that is not installed", async () => {
    mockFetch([{
      models: [model({ id: "kokoro", name: "Kokoro", kind: "tts", installed: false, enabled: null, running: "not-installed", control: "none", detail: "Not installed on this box. Speech uses the cloud voice." })],
      unavailable: [],
    }]);
    await renderPanel();
    const row = screen.getByTestId("local-model-kokoro");
    expect(within(row).getByText("Not installed")).toBeTruthy();
    expect(within(row).queryByRole("switch")).toBeNull();
  });

  it("does not call an on-demand engine stopped", async () => {
    mockFetch([{
      models: [model({ id: "piper", name: "Piper", kind: "tts", enabled: null, running: "on-demand", control: "none", diskBytes: null, memoryBytes: null, detail: "Speaks on demand." })],
      unavailable: [],
    }]);
    await renderPanel();
    const row = screen.getByTestId("local-model-piper");
    expect(within(row).getByText("On demand")).toBeTruthy();
    expect(within(row).queryByText("Stopped")).toBeNull();
  });

  it("adopts the state the toggle came back with", async () => {
    const calls = mockFetch([
      { models: [model({ enabled: true, running: "running" })], unavailable: [] },
      { ok: true, models: [model({ enabled: false, running: "idle", detail: "Installed and stopped." })], unavailable: [] },
    ]);
    await renderPanel();
    const sw = screen.getByRole("switch", { name: /Ollama enabled/i });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: /Ollama enabled/i }).getAttribute("aria-checked")).toBe("false");
    });
    const post = calls.find(c => c[1]?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ id: "ollama", enabled: false });
  });

  it("reports a refusal instead of pretending the switch worked", async () => {
    mockFetch([
      { models: [model()], unavailable: [] },
      { error: "This box does not allow the web interface to change that service." },
      { models: [model()], unavailable: [] },
    ], [true, false, true]);
    await renderPanel();
    const sw = screen.getByRole("switch", { name: /Ollama enabled/i });
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

  it("refuses an entry that is missing fields the render reads", async () => {
    // A well-formed envelope is not a well-formed entry. This one has a valid
    // `unavailable` array and an entry with an id, so a guard that stops at the
    // envelope accepts it — and then `KIND_ICON[undefined]` and
    // `RUN_TONE[undefined]` render an unlabelled, untoned row that looks like
    // a real reading of the box.
    await expectSecondPollIgnored({ models: [{ id: "ollama", running: "running" }], unavailable: [] });
  });

  it("refuses an entry whose state is not one the copy knows", async () => {
    await expectSecondPollIgnored({
      models: [{ ...model(), running: "warming-up" }],
      unavailable: [],
    });
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
  const calls = mockFetch([{ models: [model()], unavailable: [] }, bad]);

  // Fake timers BEFORE the render, because the poll's setInterval is created
  // during it - installed afterwards they would not own that timer and
  // advancing them would do nothing. shouldAdvanceTime keeps Testing Library's
  // own async plumbing working.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await renderPanel();
  const row = screen.getByTestId("local-model-ollama");
  expect(within(row).getByText("Running")).toBeTruthy();

  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(calls.length).toBeGreaterThan(1);

  // Still the engine from the good payload, and the panel is still standing.
  const after = screen.getByTestId("local-model-ollama");
  expect(within(after).getByText("Running")).toBeTruthy();
}
