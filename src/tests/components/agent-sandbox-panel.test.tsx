import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import AgentSandboxPanel, { formatBudgetBytes } from "@/components/AgentSandboxPanel";

/**
 * The owner's switch for the agent tool sandbox (Settings → Harness). Off by
 * default; on runs every session but the main chat in rootless Podman.
 * Mounted inside Settings, so a body without the fields hides the card.
 */

// The English catalogue with its `{name}` placeholders filled, so the card's
// sentences and caps are read as the owner reads them. (The real provider
// loads its catalogue through a dynamic import and a preference fetch.)
vi.mock("@/lib/i18n", async () => {
  const { translations } = await import("@/lib/translations");
  const en = translations.en as Record<string, string>;
  return {
    useT: () => ({
      t: (key: string, params?: Record<string, string | number>) =>
        (en[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) => (params && name in params ? String(params[name]) : m)),
    }),
  };
});

const BUDGET = { memoryBytes: 512 * 1024 ** 2, diskBytes: 2 * 1024 ** 3 };
const OFF = { available: true, enabled: false, known: true, mode: "off", runtime: null, provisioning: null, budget: BUDGET };
const ON = { ...OFF, enabled: true, mode: "non-main", runtime: "ready", provisioning: false };
const INSTALLING = { ...ON, runtime: "missing", provisioning: true };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Let the mount effect's fetch chain settle before a "draws nothing" answer is believed. */
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => json(OFF)));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("formatBudgetBytes", () => {
  it("draws the caps as the owner reads them", () => {
    expect(formatBudgetBytes(BUDGET.memoryBytes)).toBe("512 MB");
    expect(formatBudgetBytes(BUDGET.diskBytes)).toBe("2 GB");
    expect(formatBudgetBytes(1536 * 1024 ** 2)).toBe("1536 MB");
  });
});

describe("AgentSandboxPanel", () => {
  it("draws the switch unchecked by default, with the 512 MB / 2 GB caps", async () => {
    render(<AgentSandboxPanel />);
    const sw = await screen.findByTestId("agent-sandbox-switch");
    expect(sw.getAttribute("role")).toBe("switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    const limits = screen.getByTestId("agent-sandbox-limits").textContent ?? "";
    expect(limits).toContain("512 MB");
    expect(limits).toContain("2 GB");
    expect(screen.queryByTestId("agent-sandbox-runtime")).toBeNull();
    expect(screen.queryByTestId("agent-sandbox-pending")).toBeNull();
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("/setup-api/settings/agent-sandbox");
  });

  it("draws nothing on a Hermes edition", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...OFF, available: false, mode: null })));
    render(<AgentSandboxPanel />);
    await settle();
    expect(screen.queryByTestId("agent-sandbox-panel")).toBeNull();
  });

  it("draws nothing for a body without the fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ enabled: true })));
    render(<AgentSandboxPanel />);
    await settle();
    expect(screen.queryByTestId("agent-sandbox-panel")).toBeNull();
  });

  it("posts on, says the assistant restarts while in flight, then says the runtime is being installed", async () => {
    let resolvePost: (r: Response) => void = () => {};
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise<Response>((resolve) => { resolvePost = resolve; });
      return json(OFF);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentSandboxPanel />);
    const sw = await screen.findByTestId("agent-sandbox-switch");
    fireEvent.click(sw);

    expect(await screen.findByTestId("agent-sandbox-applying")).toBeTruthy();
    expect(sw.hasAttribute("disabled")).toBe(true);
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({ enabled: true });

    await act(async () => { resolvePost(json(INSTALLING)); });
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    expect(screen.queryByTestId("agent-sandbox-applying")).toBeNull();
    expect(screen.getByTestId("agent-sandbox-runtime").textContent).toMatch(/Installing the sandbox/);
    expect(screen.queryByTestId("agent-sandbox-failed")).toBeNull();
  });

  it("says the runtime is missing, and how to retry, when nothing is installing it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...ON, runtime: "missing", provisioning: false })));
    render(<AgentSandboxPanel />);
    expect((await screen.findByTestId("agent-sandbox-runtime")).textContent).toMatch(/off and on again/);
  });

  it("re-reads while the runtime installs, and turns into on by itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answer: unknown = INSTALLING;
    vi.stubGlobal("fetch", vi.fn(async () => json(answer)));
    render(<AgentSandboxPanel />);
    expect(await screen.findByTestId("agent-sandbox-runtime")).toBeTruthy();
    answer = ON;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await waitFor(() => expect(screen.queryByTestId("agent-sandbox-runtime")).toBeNull());
    expect(screen.getByTestId("agent-sandbox-switch").getAttribute("aria-checked")).toBe("true");
  });

  it("notes a saved switch the gateway has not applied yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...ON, mode: "off" })));
    render(<AgentSandboxPanel />);
    expect(await screen.findByTestId("agent-sandbox-pending")).toBeTruthy();
  });

  it("says the store could not be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...OFF, known: false })));
    render(<AgentSandboxPanel />);
    expect(await screen.findByTestId("agent-sandbox-store-unknown")).toBeTruthy();
    expect(screen.queryByTestId("agent-sandbox-pending")).toBeNull();
  });

  it("shows a 502 in the route's own words and draws the state it saved", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL, init?: RequestInit) => (
      init?.method === "POST"
        ? json({ ...ON, error: "The switch is saved, but the assistant's gateway did not come back after the restart.", code: "apply_failed" }, 502)
        : json(OFF)
    )));
    render(<AgentSandboxPanel />);
    const sw = await screen.findByTestId("agent-sandbox-switch");
    fireEvent.click(sw);
    const failed = await screen.findByTestId("agent-sandbox-failed");
    expect(failed.textContent).toMatch(/did not come back/);
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the state it had on a refusal without a body, and on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("offline");
      return json(OFF);
    }));
    render(<AgentSandboxPanel />);
    const sw = await screen.findByTestId("agent-sandbox-switch");
    fireEvent.click(sw);
    expect(await screen.findByTestId("agent-sandbox-failed")).toBeTruthy();
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.hasAttribute("disabled")).toBe(false);
  });
});
