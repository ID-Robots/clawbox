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
import { APP_REOPEN_ACK, APP_REOPEN_MESSAGE, APP_REOPEN_REPEAT_MS } from "@/lib/app-window";

const navigateAppFrame = vi.hoisted(() => vi.fn());
vi.mock("@/lib/app-window", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/app-window")>()), navigateAppFrame }));

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
  vi.useRealTimers();
  navigateAppFrame.mockReset();
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

  describe("a server app's window reopening the page it navigated to (src/lib/app-window.ts)", () => {
    const origin = () => window.location.origin;

    /** The frame, its guest window, and what the frame was told back. */
    function mount(src: string, appId = "notes") {
      stubBox({ migrated: true, plan: null });
      const view = render(<WebappFrame appId={appId} src={src} title="App" />);
      const frame = screen.getByTitle("App") as HTMLIFrameElement;
      const guest = frame.contentWindow!;
      const told: unknown[] = [];
      vi.spyOn(guest, "postMessage").mockImplementation(((msg: unknown) => { told.push(msg); }) as typeof guest.postMessage);
      return { view, frame, guest, told };
    }

    function ask(source: Window | null, href: unknown) {
      window.dispatchEvent(new MessageEvent("message", { data: { [APP_REOPEN_MESSAGE]: { href } }, source }));
    }

    it("opens the app's own page in its frame with the desktop's navigation, and tells the page", () => {
      const { frame, guest, told } = mount(`${origin()}/apps/notes/`);
      ask(guest, `${origin()}/apps/notes/notes/2?tab=a`);
      expect(navigateAppFrame).toHaveBeenCalledTimes(1);
      expect(navigateAppFrame).toHaveBeenCalledWith(frame, `${origin()}/apps/notes/notes/2?tab=a`);
      expect(told).toEqual([{ [APP_REOPEN_ACK]: true }]);
    });

    it("does the same for a window opened at the desktop address that sends it on to /apps/<id>/", () => {
      const { frame, guest } = mount("/setup-api/webapps?app=audiobook-player", "audiobook-player");
      expect(frame.getAttribute("sandbox")).toBe(WEBAPP_IFRAME_SANDBOX);
      ask(guest, `${origin()}/apps/audiobook-player/books`);
      expect(navigateAppFrame).toHaveBeenCalledWith(frame, `${origin()}/apps/audiobook-player/books`);
    });

    it("never opens the box's API, the desktop, another app or another origin for it", () => {
      const { guest, told } = mount(`${origin()}/apps/notes/`);
      for (const href of [
        `${origin()}/setup-api/system/version`,
        `${origin()}/`,
        `${origin()}/apps/other/`,
        `${origin()}/apps/notes/../../setup-api/x`,
        `${origin()}/apps/notes/..%2f..%2fsetup-api`,
        "https://evil.example/apps/notes/",
        "javascript:alert(1)",
        42,
      ]) {
        ask(guest, href);
      }
      expect(navigateAppFrame).not.toHaveBeenCalled();
      expect(told).toEqual([]);
    });

    it("listens to its own frame only", () => {
      const { guest } = mount(`${origin()}/apps/notes/`);
      const stranger = document.createElement("iframe");
      document.body.appendChild(stranger);
      ask(stranger.contentWindow, `${origin()}/apps/notes/x`);
      ask(window, `${origin()}/apps/notes/x`);
      ask(null, `${origin()}/apps/notes/x`);
      window.dispatchEvent(new MessageEvent("message", { data: { somethingElse: true }, source: guest }));
      expect(navigateAppFrame).not.toHaveBeenCalled();
      stranger.remove();
    });

    it("does not reopen the address it just opened — the desktop's cookie did not get it in either", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { guest, told } = mount(`${origin()}/apps/notes/`);
      const href = `${origin()}/apps/notes/notes/2`;
      ask(guest, href);
      ask(guest, href);
      expect(navigateAppFrame).toHaveBeenCalledTimes(1);
      expect(told).toHaveLength(1);
      // Another page is a click, not a loop.
      ask(guest, `${origin()}/apps/notes/notes/3`);
      expect(navigateAppFrame).toHaveBeenCalledTimes(2);
      // …and the same one again later is a click too.
      vi.setSystemTime(Date.now() + APP_REOPEN_REPEAT_MS + 1);
      ask(guest, `${origin()}/apps/notes/notes/3`);
      expect(navigateAppFrame).toHaveBeenCalledTimes(3);
    });

    it("stops listening when the window closes", () => {
      const { view, guest } = mount(`${origin()}/apps/notes/`);
      view.unmount();
      ask(guest, `${origin()}/apps/notes/x`);
      expect(navigateAppFrame).not.toHaveBeenCalled();
    });
  });
});
