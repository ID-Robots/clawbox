import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config-store", () => ({
  // DATA_DIR is pulled in through webapp-icon, which the registry now calls to
  // draw a picture for every app that reaches the desktop.
  DATA_DIR: "/tmp/clawbox-webapp-registry-test",
  getAll: vi.fn(),
  setMany: vi.fn(),
}));

// The icon is fire-and-forget and takes 5-15 s against ClawBox AI; this suite is
// about the preference write. Stubbed so nothing reaches the network, and so a
// pending generation cannot outlive the test that started it.
vi.mock("@/lib/webapp-icon", () => ({
  ensureWebappIcon: vi.fn(async () => "skipped" as const),
}));

import { getAll, setMany } from "@/lib/config-store";
import { ensureWebappIcon } from "@/lib/webapp-icon";
import { registerWebappInPreferences } from "@/lib/webapp-registry";

const mockGetAll = vi.mocked(getAll);
const mockSetMany = vi.mocked(setMany);

describe("registerWebappInPreferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetMany.mockResolvedValue(undefined);
  });

  it("adds the app to installed_apps + installed_meta and unhides it", async () => {
    mockGetAll.mockResolvedValue({
      "pref:installed_apps": ["existing"],
      "pref:installed_meta": { existing: { name: "E" } },
      "pref:hidden_installed": ["todo"], // currently hidden
    });

    await registerWebappInPreferences("todo", "Todo App", {
      color: "#abc",
      webappUrl: "/setup-api/webapps?app=todo",
    });

    expect(mockSetMany).toHaveBeenCalledTimes(1);
    const arg = mockSetMany.mock.calls[0][0] as Record<string, unknown>;
    expect(arg["pref:installed_apps"]).toEqual(["existing", "todo"]);
    expect(arg["pref:installed_meta"]).toMatchObject({
      todo: { name: "Todo App", color: "#abc", iconUrl: "", webappUrl: "/setup-api/webapps?app=todo" },
    });
    // un-hidden so a re-created app reappears
    expect(arg["pref:hidden_installed"]).toEqual([]);
  });

  it("is idempotent — does not duplicate an already-installed app", async () => {
    mockGetAll.mockResolvedValue({ "pref:installed_apps": ["todo"] });

    await registerWebappInPreferences("todo", "Todo App");

    const arg = mockSetMany.mock.calls[0][0] as Record<string, unknown>;
    expect(arg["pref:installed_apps"]).toEqual(["todo"]);
  });

  it("defaults color and webappUrl when omitted, on empty prefs", async () => {
    mockGetAll.mockResolvedValue({});

    await registerWebappInPreferences("calc", "Calculator");

    const arg = mockSetMany.mock.calls[0][0] as Record<string, unknown>;
    expect(arg["pref:installed_apps"]).toEqual(["calc"]);
    expect(arg["pref:installed_meta"]).toMatchObject({
      calc: { name: "Calculator", color: "#f97316", webappUrl: "/setup-api/webapps?app=calc" },
    });
  });

  it("draws an icon for an app that did not bring one", async () => {
    // Not only the apps built from HTML on this box: a project the coding agent
    // scaffolds and serves on a local port registers through here, and used to
    // land on the desktop as a bare coloured tile.
    mockGetAll.mockResolvedValue({});

    await registerWebappInPreferences("timer", "Timer", {
      color: "#dc2626",
      description: "A 25/5 pomodoro timer",
      webappUrl: "http://127.0.0.1:4173",
    });

    expect(vi.mocked(ensureWebappIcon)).toHaveBeenCalledWith("timer", {
      name: "Timer",
      color: "#dc2626",
      description: "A 25/5 pomodoro timer",
    });
  });

  it("leaves an app that brought its own icon alone", async () => {
    mockGetAll.mockResolvedValue({});

    await registerWebappInPreferences("timer", "Timer", { iconUrl: "https://example.test/i.png" });

    expect(vi.mocked(ensureWebappIcon)).not.toHaveBeenCalled();
  });

  it("registers before the picture exists, and never fails over one", async () => {
    // Generation takes 5-15 s against ClawBox AI. The registration must not
    // wait for it, and a refusal must not take the registration down with it.
    mockGetAll.mockResolvedValue({});
    vi.mocked(ensureWebappIcon).mockRejectedValueOnce(new Error("proxy refused"));

    await expect(registerWebappInPreferences("timer", "Timer")).resolves.toBeUndefined();
    expect(mockSetMany).toHaveBeenCalled();
  });
  it("does not let two registrations read the same base and drop one", async () => {
    // The read below and the write under it are a read-modify-write over the
    // WHOLE preference snapshot, and the store's own atomic write protects the
    // FILE, not the update. Two that interleave — a build finishing while a
    // project's "Add to desktop" lands — each read the same base and the
    // second write drops the first: measured before the lock, `aaa` and `bbb`
    // registered together left installed_meta holding only `bbb`.
    //
    // Pinned as the ORDER rather than the surviving keys, because a mock store
    // that merges hides the loss the real preference write does not.
    const order: string[] = [];
    mockGetAll.mockImplementation(async () => {
      order.push("read");
      // A real read is not instantaneous; this is the window the second
      // registration used to slip into.
      await new Promise((r) => setTimeout(r, 5));
      return {};
    });
    mockSetMany.mockImplementation(async () => { order.push("write"); });

    await Promise.all([
      registerWebappInPreferences("aaa", "A"),
      registerWebappInPreferences("bbb", "B"),
    ]);

    // read,write,read,write — never read,read,write,write.
    expect(order).toEqual(["read", "write", "read", "write"]);
  });

});
