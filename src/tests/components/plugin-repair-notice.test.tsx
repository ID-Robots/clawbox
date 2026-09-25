import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import PluginRepairNotice, { type PluginRepairInfo } from "@/components/PluginRepairNotice";

// "Needs repair", with the reason and a Retry (TASK-606).
//
// The notice is drawn FROM the marker row, so the only question it can get
// wrong is when to tell the panel the row has gone. Removing it while the row
// is still on the box takes the badge away and puts it straight back — and for
// the case that matters, a repair whose gateway restart did not happen, the
// badge is still the true thing on screen: the plugin is correct on disk and
// not running.

const REPAIR: PluginRepairInfo = {
  pluginId: "codex",
  stage: "install",
  reason: "The device may be offline.",
};

/** Let the click's fetch chain settle before the answer is believed. */
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});

describe("PluginRepairNotice", () => {
  it("tells the panel to re-read once the device says the record is gone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ ok: true, pluginId: "codex", restarted: true, markerCleared: true }),
      { status: 200 },
    )));
    const onRepaired = vi.fn();
    render(<PluginRepairNotice repair={REPAIR} onRepaired={onRepaired} />);
    fireEvent.click(screen.getByRole("button"));
    await settle();
    expect(onRepaired).toHaveBeenCalledTimes(1);
  });

  it("keeps itself when the repair worked but the record is still there", async () => {
    // The gateway did not come back, so the plugin is correct on disk and not
    // running. `ok: true` is right — the repair happened — and the notice is
    // still the honest thing to leave on screen, with its Retry.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ ok: true, pluginId: "codex", restarted: false, markerCleared: false }),
      { status: 200 },
    )));
    const onRepaired = vi.fn();
    render(<PluginRepairNotice repair={REPAIR} onRepaired={onRepaired} />);
    fireEvent.click(screen.getByRole("button"));
    await settle();
    expect(onRepaired).not.toHaveBeenCalled();
    expect(screen.getByTestId("plugin-repair-codex")).toBeTruthy();
    // Not an error state either: nothing failed, so the Retry is offered again
    // rather than a red line about a repair that did work.
    expect(screen.getByRole("button")).toBeTruthy();
  });

  it("does not clear itself over a repair the device refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ ok: false, code: "repair_failed" }), { status: 502 },
    )));
    const onRepaired = vi.fn();
    render(<PluginRepairNotice repair={REPAIR} onRepaired={onRepaired} />);
    fireEvent.click(screen.getByRole("button"));
    await settle();
    expect(onRepaired).not.toHaveBeenCalled();
    expect(screen.getByTestId("plugin-repair-codex")).toBeTruthy();
  });

  // TASK-1088: a repair the DEVICE is running — the updater's after-update
  // retry, or a Retry pressed in another tab.
  it("says the device is repairing it, and offers no second Retry over the first", () => {
    render(<PluginRepairNotice repair={{ ...REPAIR, repairing: true }} />);
    // Still "Needs repair": nothing is repaired until it is proved.
    expect(screen.getByTestId("plugin-repair-codex").textContent).toContain("settings.providers.needsRepair");
    expect(screen.getByTestId("plugin-repair-repairing-codex")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("re-reads the panel while the device repairs it, and never claims it repaired", async () => {
    vi.useFakeTimers();
    try {
      const onRepaired = vi.fn();
      const onRecheck = vi.fn();
      const { unmount } = render(
        <PluginRepairNotice repair={{ ...REPAIR, repairing: true }} onRepaired={onRepaired} onRecheck={onRecheck} />,
      );
      await act(async () => { vi.advanceTimersByTime(15_000); });
      expect(onRecheck).toHaveBeenCalledTimes(1);
      expect(onRepaired).not.toHaveBeenCalled();
      unmount();
      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(onRecheck).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads after a Retry that did not work, so the row shows the cause the device filed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ ok: false, code: "refused_at_start" }), { status: 502 },
    )));
    const onRepaired = vi.fn();
    const onRecheck = vi.fn();
    render(<PluginRepairNotice repair={REPAIR} onRepaired={onRepaired} onRecheck={onRecheck} />);
    fireEvent.click(screen.getByRole("button"));
    await settle();
    expect(onRecheck).toHaveBeenCalledTimes(1);
    expect(onRepaired).not.toHaveBeenCalled();
    expect(screen.getByText("settings.providers.repairFailed")).toBeTruthy();
  });

  it("does not call a press that met a repair already running a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ ok: false, code: "repair_in_progress" }), { status: 409 },
    )));
    const onRecheck = vi.fn();
    render(<PluginRepairNotice repair={REPAIR} onRecheck={onRecheck} />);
    fireEvent.click(screen.getByRole("button"));
    await settle();
    expect(onRecheck).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("settings.providers.repairFailed")).toBeNull();
  });
});
