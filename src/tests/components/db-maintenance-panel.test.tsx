import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import DbMaintenancePanel from "@/components/DbMaintenancePanel";

// Settings → System → Agent databases. Mounted inside Settings, so a body it
// cannot read must hide the card, never throw.

// The English catalogue itself, so what is asserted is the copy the owner reads.
vi.mock("@/lib/i18n", async () => {
  const { translations } = await import("@/lib/translations");
  const t = (key: string, params?: Record<string, string | number>) =>
    (translations.en[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) => (params && name in params ? String(params[name]) : m));
  return { useT: () => ({ t, locale: "en" }) };
});

const GB = 1024 ** 3;

const STATUS = {
  ok: true,
  available: true,
  supported: true,
  core: "2026.10.6",
  totalBytes: 8 * GB,
  diskFreeBytes: 20 * GB,
  databases: [
    { key: "agent:main", label: "agent main", kind: "agent", agentId: "main", bytes: 8 * GB - 1024, freeRatio: 0.37, error: null, needs: "37% free pages", blocked: null },
    { key: "state", label: "the shared state database", kind: "state", agentId: null, bytes: 1024, freeRatio: 0, error: null, needs: null, blocked: null },
  ],
  running: null,
  lastRun: { trigger: "scheduled", outcome: "compacted", finishedAt: "2026-10-26T03:35:00Z", beforeBytes: 13 * GB, afterBytes: 8 * GB, gatewayRestarted: true },
  schedule: { enabled: true, time: "04:30" },
  nextRunAt: Date.UTC(2026, 9, 27, 3, 30),
};

let fetchMock: ReturnType<typeof vi.fn>;

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.action === "run") return new Response(JSON.stringify({ ok: true, started: true, survivesRestart: true }), { status: 202 });
      return new Response(JSON.stringify({ ok: true, schedule: { enabled: body.enabled ?? true, time: body.time ?? "04:30" }, nextRunAt: null }), { status: 200 });
    }
    return new Response(JSON.stringify(STATUS), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DbMaintenancePanel", () => {
  it("shows the databases' sizes, which one needs compacting, and what the last run reclaimed", async () => {
    render(<DbMaintenancePanel />);
    await screen.findByTestId("settings-db-maintenance");
    expect(screen.getByTestId("db-maintenance-total").textContent).toBe("8.0 GB in 2 databases");
    expect(screen.getByTestId("db-maintenance-db-agent:main").textContent).toContain("Agent main");
    expect(screen.getByTestId("db-maintenance-db-agent:main").textContent).toContain("37% unused");
    expect(screen.getByTestId("db-maintenance-needs-agent:main").textContent).toBe("Needs compacting");
    expect(screen.queryByTestId("db-maintenance-needs-state")).toBeNull();
    expect(screen.getByTestId("db-maintenance-last").textContent).toContain("13.0 GB → 8.0 GB, 5.0 GB reclaimed");
    expect(screen.getByTestId("db-maintenance-next")).toBeTruthy();
  });

  it("starts a run on Run now and follows it", async () => {
    render(<DbMaintenancePanel />);
    fireEvent.click(await screen.findByTestId("db-maintenance-run"));
    await screen.findByTestId("db-maintenance-running");
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/gateway/db-maintenance", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "run" }) }));
    expect(screen.getByTestId("db-maintenance-notice").textContent).toMatch(/Maintenance started/);
    expect((screen.getByTestId("db-maintenance-run") as HTMLButtonElement).disabled).toBe(true);
  });

  it("switches the nightly check off through the route", async () => {
    render(<DbMaintenancePanel />);
    const toggle = await screen.findByTestId("db-maintenance-schedule-switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/gateway/db-maintenance", expect.objectContaining({ body: JSON.stringify({ action: "schedule", enabled: false }) }));
  });

  it("says when the assistant did not come back after a run", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ...STATUS, lastRun: { ...STATUS.lastRun, outcome: "failed", gatewayRestarted: false } }), { status: 200 }));
    render(<DbMaintenancePanel />);
    await screen.findByTestId("db-maintenance-gateway-down");
    expect(screen.getByTestId("db-maintenance-last").textContent).toContain("failed — the databases were left as they were");
  });

  it("draws nothing for a non-owner (403), on Hermes, or for a body it cannot read", async () => {
    for (const reply of [
      new Response(JSON.stringify({ ok: false, code: "owner_only" }), { status: 403 }),
      new Response(JSON.stringify({ ok: true, available: false, databases: [], schedule: { enabled: true, time: "04:30" } }), { status: 200 }),
      new Response(JSON.stringify({ databases: [null] }), { status: 200 }),
    ]) {
      fetchMock.mockImplementationOnce(async () => reply);
      const { container, unmount } = render(<DbMaintenancePanel />);
      await settle();
      expect(container.querySelector("[data-testid='settings-db-maintenance']")).toBeNull();
      unmount();
    }
  });
});
