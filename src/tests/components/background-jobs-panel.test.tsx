import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import BackgroundJobsPanel from "@/components/BackgroundJobsPanel";

// The panel that says what the box does without being asked (TASK-609).
//
// It is mounted inside Settings → System, so anything it throws takes the whole
// Settings window with it — which is what three e2e specs caught when they
// stopped being able to open it at all.

const STATUS = {
  harness: "openclaw",
  degraded: false,
  jobs: [
    { id: "checkIns", enabled: true, supported: true, key: "agents.defaults.heartbeat.every" },
    { id: "memoryReview", enabled: false, supported: true, key: "plugins.entries.memory-core.config.dreaming.enabled" },
    { id: "skillLearning", enabled: true, supported: true, key: "skills.workshop.autonomous.mode" },
  ],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(STATUS), { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BackgroundJobsPanel", () => {
  it("draws a switch per job and names the harness key under each", async () => {
    render(<BackgroundJobsPanel />);
    await waitFor(() => expect(screen.getByTestId("settings-background-jobs")).toBeTruthy());
    for (const id of ["checkIns", "memoryReview", "skillLearning"]) {
      expect(screen.getByTestId(`bg-job-switch-${id}`)).toBeTruthy();
    }
    expect(screen.getByText("agents.defaults.heartbeat.every")).toBeTruthy();
  });

  it("says Hermes has no check-ins rather than drawing a dead switch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...STATUS,
      harness: "hermes",
      jobs: [{ id: "checkIns", enabled: false, supported: false, key: null }, ...STATUS.jobs.slice(1)],
    }), { status: 200 })));
    render(<BackgroundJobsPanel />);
    await waitFor(() => expect(screen.getByTestId("bg-job-unsupported-checkIns")).toBeTruthy());
    expect(screen.queryByTestId("bg-job-switch-checkIns")).toBeNull();
  });

  it("draws nothing, and throws nothing, for a body with no jobs in it", async () => {
    // The e2e mock answers `{}` for any unknown /setup-api path, and an older
    // server answers 404. `status.jobs.find(...)` on that threw and took the
    // whole Settings WINDOW down with it — three specs stopped being able to
    // open Settings at all.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const { container } = render(<BackgroundJobsPanel />);
    await waitFor(() => expect(container.querySelector("[data-testid='settings-background-jobs']")).toBeNull());
  });

  it("draws nothing at all — and throws nothing — when the box does not answer", async () => {
    // Settings → System mounts this: a throw here takes the whole window with
    // it, which is what three e2e specs caught.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const { container } = render(<BackgroundJobsPanel />);
    await waitFor(() => expect(container.querySelector("[data-testid='settings-background-jobs']")).toBeNull());
  });
  it("draws nothing for a jobs array whose elements are not rows", async () => {
    // `Array.isArray` says yes to `[null]`. The row lookup then reads `.id` off
    // it and throws — inside Settings, which is the whole window again. The
    // array-ness was checked and the ELEMENT shape was not.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ harness: "openclaw", degraded: false, jobs: [null] }), { status: 200 })));
    const { container } = render(<BackgroundJobsPanel />);
    await waitFor(() => expect(container.querySelector("[data-testid='settings-background-jobs']")).toBeNull());
  });

  it("locks EVERY switch while one write is in flight, not just the one clicked", async () => {
    // The POST writes the key, reads it back and restarts the gateway — seconds
    // on an Orin. A second switch left live during that races: each response
    // replaces the whole status, so the older answer can land last and leave a
    // switch showing a state the box is not in.
    let release!: (r: Response) => void;
    const inFlight = new Promise<Response>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST" ? inFlight : new Response(JSON.stringify(STATUS), { status: 200 })));
    render(<BackgroundJobsPanel />);
    const first = await screen.findByTestId("bg-job-switch-checkIns");
    fireEvent.click(first);
    await waitFor(() => expect(first.getAttribute("aria-busy")).toBe("true"));
    expect((screen.getByTestId("bg-job-switch-memoryReview") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("bg-job-switch-skillLearning") as HTMLButtonElement).disabled).toBe(true);
    release(new Response(JSON.stringify({ ok: true, restarted: true, ...STATUS }), { status: 200 }));
    await waitFor(() =>
      expect((screen.getByTestId("bg-job-switch-memoryReview") as HTMLButtonElement).disabled).toBe(false));
  });

  it("says the write failed, and leaves the switch where the box has it", async () => {
    // The POST-failure branch. The neighbouring case fails the initial GET, so
    // the panel returns null and never reaches a toggle at all.
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ ok: false, code: "write_failed" }), { status: 502 })
        : new Response(JSON.stringify(STATUS), { status: 200 })));
    render(<BackgroundJobsPanel />);
    fireEvent.click(await screen.findByTestId("bg-job-switch-checkIns"));
    await waitFor(() => expect(screen.getByTestId("bg-job-failed-checkIns")).toBeTruthy());
    expect(screen.getByTestId("bg-job-switch-checkIns").getAttribute("aria-checked")).toBe("true");
  });
});
