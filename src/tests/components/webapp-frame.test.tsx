// @vitest-environment jsdom
/**
 * WebappFrame — the one frame the desktop and /app/[id] draw a webapp in
 * (TASK-1150). It keeps the sandbox contract, and on a browser that may still
 * hold a pre-v4.0 app's localStorage it loads the app only once that storage
 * has been handed to the box: an app loaded first would find it empty and
 * could save its empty first screen over the data on its way in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import WebappFrame from "@/components/WebappFrame";
import { BROWSER_IMPORT_MARK_PREFIX } from "@/lib/webapp-legacy-browser-import";
import { WEBAPP_IFRAME_SANDBOX } from "@/lib/webapp-sandbox";

type Call = { url: string; method: string; body: unknown };

function stubBox(plan: unknown, opts: { postOk?: boolean } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(input), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET") return { ok: true, status: 200, json: async () => plan };
      return { ok: opts.postOk ?? true, status: opts.postOk === false ? 500 : 200, json: async () => ({ copied: [], kept: [], refused: [] }) };
    }),
  );
  return calls;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("WebappFrame", () => {
  it("keeps the sandbox contract and loads at once on a browser with nothing old in it", () => {
    localStorage.setItem("clawbox-chat-size", "{}");
    localStorage.setItem("openclaw.control.settings.v1", "{}");
    const calls = stubBox({ migrated: true, plan: null });
    render(<WebappFrame appId="notes" src="http://localhost/setup-api/webapps?app=notes" title="Notes" />);
    const frame = screen.getByTitle("Notes");
    expect(frame.getAttribute("sandbox")).toBe(WEBAPP_IFRAME_SANDBOX);
    expect(frame.getAttribute("data-webapp-id")).toBe("notes");
    expect(frame.getAttribute("src")).toBe("http://localhost/setup-api/webapps?app=notes");
    expect(calls).toHaveLength(0);
  });

  it("hands this browser's old storage over first, only what the app's code named", async () => {
    localStorage.setItem("pomodoro-settings", '{"work":25}');
    localStorage.setItem("session-1", "1");
    localStorage.setItem("unrelated", "x");
    localStorage.setItem("openclaw.control.settings.v1", '{"token":"secret"}');
    localStorage.setItem("clawbox-gateway-device-identity-v1", "{}");
    const calls = stubBox({ migrated: true, plan: { tokens: ["pomodoro-settings", "session-", "openclaw.control.settings.v1"], imported: [] } });
    render(<WebappFrame appId="pomodoro" src="/setup-api/webapps?app=pomodoro" title="Pomodoro" />);
    const frame = screen.getByTitle("Pomodoro");
    // Not loaded while the storage is on its way.
    expect(frame.getAttribute("src")).toBeNull();
    await waitFor(() => expect(frame.getAttribute("src")).toBe("/setup-api/webapps?app=pomodoro"));

    expect(calls[0]).toMatchObject({ url: "/setup-api/webapps/storage?app=pomodoro", method: "GET" });
    expect(calls[1]).toMatchObject({
      url: "/setup-api/webapps/storage",
      method: "POST",
      body: { app: "pomodoro", op: "importBrowser", entries: { "pomodoro-settings": '{"work":25}', "session-1": "1" } },
    });
    // The browser's own copy is untouched, and it is asked once.
    expect(localStorage.getItem("pomodoro-settings")).toBe('{"work":25}');
    expect(localStorage.getItem(BROWSER_IMPORT_MARK_PREFIX + "pomodoro")).not.toBeNull();
  });

  it("does not ask again once this browser has been asked", () => {
    localStorage.setItem("pomodoro-settings", "{}");
    localStorage.setItem(BROWSER_IMPORT_MARK_PREFIX + "pomodoro", "2026-09-24T00:00:00.000Z");
    const calls = stubBox({ migrated: true, plan: null });
    render(<WebappFrame appId="pomodoro" src="/setup-api/webapps?app=pomodoro" title="Pomodoro" />);
    expect(screen.getByTitle("Pomodoro").getAttribute("src")).toBe("/setup-api/webapps?app=pomodoro");
    expect(calls).toHaveLength(0);
  });

  it("marks an app with nothing to bring, without sending anything", async () => {
    localStorage.setItem("something-else", "x");
    const calls = stubBox({ migrated: true, plan: null });
    render(<WebappFrame appId="weather" src="/setup-api/webapps?app=weather" title="Weather" />);
    await waitFor(() => expect(screen.getByTitle("Weather").getAttribute("src")).toBe("/setup-api/webapps?app=weather"));
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(localStorage.getItem(BROWSER_IMPORT_MARK_PREFIX + "weather")).not.toBeNull();
  });

  it("loads the app anyway, and asks again next time, when the box cannot take it yet", async () => {
    localStorage.setItem("pomodoro-settings", "{}");
    stubBox({ migrated: false, plan: null });
    render(<WebappFrame appId="pomodoro" src="/setup-api/webapps?app=pomodoro" title="Pomodoro" />);
    await waitFor(() => expect(screen.getByTitle("Pomodoro").getAttribute("src")).toBe("/setup-api/webapps?app=pomodoro"));
    expect(localStorage.getItem(BROWSER_IMPORT_MARK_PREFIX + "pomodoro")).toBeNull();
  });

  it("frames a proxied project server without the attribute and without waiting", () => {
    localStorage.setItem("pomodoro-settings", "{}");
    const calls = stubBox({ migrated: true, plan: null });
    render(<WebappFrame appId="game" src={`${window.location.origin}/apps/game/`} title="Game" />);
    const frame = screen.getByTitle("Game");
    expect(frame.getAttribute("sandbox")).toBeNull();
    expect(frame.getAttribute("src")).toBe(`${window.location.origin}/apps/game/`);
    expect(calls).toHaveLength(0);
  });
});
