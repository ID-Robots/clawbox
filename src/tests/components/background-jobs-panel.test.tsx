import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

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

  it("draws nothing at all — and throws nothing — when the box does not answer", async () => {
    // Settings → System mounts this: a throw here takes the whole window with
    // it, which is what three e2e specs caught.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const { container } = render(<BackgroundJobsPanel />);
    await waitFor(() => expect(container.querySelector("[data-testid='settings-background-jobs']")).toBeNull());
  });
});
