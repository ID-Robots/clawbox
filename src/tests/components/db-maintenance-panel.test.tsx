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
      const enabled = body.enabled ?? true;
      return new Response(JSON.stringify({ ok: true, schedule: { enabled, time: body.time ?? "04:30" }, nextRunAt: enabled ? STATUS.nextRunAt : null }), { status: 200 });
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

  it("drops the 'started' notice once the run is over and its result is shown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<DbMaintenancePanel />);
      fireEvent.click(await screen.findByTestId("db-maintenance-run"));
      await screen.findByTestId("db-maintenance-running");
      expect(screen.getByTestId("db-maintenance-notice").textContent).toMatch(/Maintenance started/);
      // The next poll finds the run finished.
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ...STATUS, lastRun: { ...STATUS.lastRun, trigger: "manual", outcome: "nothing_to_do" } }), { status: 200 }));
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      await waitFor(() => expect(screen.queryByTestId("db-maintenance-running")).toBeNull());
      expect(screen.getByTestId("db-maintenance-last").textContent).toContain("nothing needed compacting");
      expect(screen.queryByTestId("db-maintenance-notice")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("switches the nightly check off through the route", async () => {
    render(<DbMaintenancePanel />);
    const toggle = await screen.findByTestId("db-maintenance-schedule-switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/gateway/db-maintenance", expect.objectContaining({ body: JSON.stringify({ action: "schedule", enabled: false }) }));
    expect(screen.queryByTestId("db-maintenance-next")).toBeNull();
  });

  describe("on a box whose owner never turned it on (the default)", () => {
    const OFF = { ...STATUS, schedule: { enabled: false, time: "04:30" }, nextRunAt: null };

    beforeEach(() => {
      const base = fetchMock.getMockImplementation();
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
        init?.method === "POST" ? base!(url, init) : new Response(JSON.stringify(OFF), { status: 200 }));
    });

    it("shows the switch off, no next check and the time held, and says it is off until turned on", async () => {
      render(<DbMaintenancePanel />);
      const toggle = await screen.findByTestId("db-maintenance-schedule-switch");
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(screen.queryByTestId("db-maintenance-next")).toBeNull();
      expect((screen.getByTestId("db-maintenance-time") as HTMLInputElement).disabled).toBe(true);
      expect(screen.getByTestId("settings-db-maintenance").textContent).toContain("Off until you turn it on.");
      expect((screen.getByTestId("db-maintenance-run") as HTMLButtonElement).disabled).toBe(false);
    });

    it("never shows a next check while off, whatever time the body carries", async () => {
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ...OFF, nextRunAt: STATUS.nextRunAt }), { status: 200 }));
      render(<DbMaintenancePanel />);
      await screen.findByTestId("db-maintenance-schedule-switch");
      expect(screen.queryByTestId("db-maintenance-next")).toBeNull();
    });

    it("turns the nightly check on through the route, and only then shows the next check", async () => {
      render(<DbMaintenancePanel />);
      const toggle = await screen.findByTestId("db-maintenance-schedule-switch");
      fireEvent.click(toggle);
      await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
      expect(fetchMock).toHaveBeenCalledWith("/setup-api/gateway/db-maintenance", expect.objectContaining({ body: JSON.stringify({ action: "schedule", enabled: true }) }));
      await screen.findByTestId("db-maintenance-next");
    });

    it("still runs maintenance on Run now", async () => {
      render(<DbMaintenancePanel />);
      fireEvent.click(await screen.findByTestId("db-maintenance-run"));
      await screen.findByTestId("db-maintenance-running");
      expect(fetchMock).toHaveBeenCalledWith("/setup-api/gateway/db-maintenance", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "run" }) }));
      expect(screen.getByTestId("db-maintenance-notice").textContent).toMatch(/Maintenance started/);
    });
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
      new Response(JSON.stringify({ ok: true, available: false, databases: [], schedule: { enabled: false, time: "04:30" }, nextRunAt: null }), { status: 200 }),
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
