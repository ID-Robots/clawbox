import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as renderBare, screen, waitFor } from "@testing-library/react";

import JobAlertsPanel from "@/components/JobAlertsPanel";
import { I18nProvider } from "@/lib/i18n";

// The scheduled-job alerts' card in Settings → Harness. It is mounted inside
// Settings, so a body it cannot draw must hide the card rather than throw.

const NOW = Date.parse("2026-11-05T12:00:00Z");

const STATUS = {
  enabled: true,
  off: null,
  runtime: "openclaw",
  reachable: true,
  checkedAt: NOW,
  watched: 4,
  problems: [
    { id: "j1", name: "Nightly backup", problem: "failing", count: 3, since: NOW - 3_600_000, error: "command exited with code 1" },
    { id: "j2", name: "Inbox digest", problem: "overdue", count: 0, since: NOW - 600_000, error: null },
  ],
};

const render = (ui: React.ReactElement) => renderBare(<I18nProvider>{ui}</I18nProvider>);

/** The card's route answers `body`; anything else (the provider's language read) answers `{}`. */
function route(body: unknown, post?: () => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith("/setup-api/job-alerts")) return new Response("{}", { status: 200 });
    if (init?.method === "POST" && post) return post();
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function postBodies(fetchMock: ReturnType<typeof route>): unknown[] {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)));
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  route(STATUS);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JobAlertsPanel", () => {
  it("draws the switch on and lists each job in trouble with what went wrong", async () => {
    render(<JobAlertsPanel />);
    // The English table arrives after the first render: wait for the words, not the card.
    await waitFor(() => expect(screen.getByTestId("job-alerts-problem-j1").textContent).toContain("Failed 3 times in a row"));
    expect(screen.getByTestId("job-alerts-switch").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("job-alerts-problem-j1").textContent).toContain("Nightly backup");
    expect(screen.getByTestId("job-alerts-problem-j1").textContent).toContain("command exited with code 1");
    expect(screen.getByTestId("job-alerts-problem-j2").textContent).toContain("Did not run when it was due");
  });

  it("says all is well when nothing is wrong", async () => {
    route({ ...STATUS, problems: [] });
    render(<JobAlertsPanel />);
    await waitFor(() => expect(screen.getByTestId("job-alerts-status").textContent).toContain("Watching 4 scheduled jobs"));
  });

  it("says one job in the singular", async () => {
    route({ ...STATUS, watched: 1, problems: [] });
    render(<JobAlertsPanel />);
    await waitFor(() => expect(screen.getByTestId("job-alerts-status").textContent).toContain("Watching 1 scheduled job — it ran as expected."));
  });

  it("switches off through the route and draws the box's answer", async () => {
    const fetchMock = route(STATUS, () => new Response(JSON.stringify({ ok: true, ...STATUS, enabled: false, off: "pref" }), { status: 200 }));
    render(<JobAlertsPanel />);
    await waitFor(() => expect(screen.getByTestId("job-alerts-switch")).toBeTruthy());
    fireEvent.click(screen.getByTestId("job-alerts-switch"));
    await waitFor(() => expect(screen.getByTestId("job-alerts-switch").getAttribute("aria-checked")).toBe("false"));
    expect(postBodies(fetchMock)).toEqual([{ enabled: false }]);
    expect(screen.getByTestId("job-alerts-status").textContent).toContain("Alerts are off");
    expect(screen.queryByTestId("job-alerts-problem-j1")).toBeNull();
  });

  it("keeps the switch where it was and says so when the write fails", async () => {
    route(STATUS, () => new Response(JSON.stringify({ ok: false, code: "write_failed" }), { status: 502 }));
    render(<JobAlertsPanel />);
    await waitFor(() => expect(screen.getByTestId("job-alerts-switch")).toBeTruthy());
    fireEvent.click(screen.getByTestId("job-alerts-switch"));
    await waitFor(() => expect(screen.getByTestId("job-alerts-failed")).toBeTruthy());
    expect(screen.getByTestId("job-alerts-switch").getAttribute("aria-checked")).toBe("true");
  });

  it("an operator's off is drawn off and inert", async () => {
    route({ ...STATUS, enabled: false, off: "env" });
    render(<JobAlertsPanel />);
    await waitFor(() => expect(screen.getByTestId("job-alerts-switch")).toBeTruthy());
    expect((screen.getByTestId("job-alerts-switch") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("job-alerts-status").textContent).toContain("CLAWBOX_JOB_ALERTS");
  });

  it.each([[{}], [{ ...STATUS, problems: [null] }], [{ ...STATUS, problems: [{ ...STATUS.problems[0], problem: "weird" }] }]])(
    "hides itself for a body it cannot draw (%#)",
    async (body) => {
      route(body);
      const { container } = render(<JobAlertsPanel />);
      await settle();
      expect(container.querySelector("[data-testid='settings-job-alerts']")).toBeNull();
    },
  );
});
