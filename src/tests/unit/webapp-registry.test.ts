import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config-store", () => ({
  getAll: vi.fn(),
  setMany: vi.fn(),
}));

import { getAll, setMany } from "@/lib/config-store";
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
});
