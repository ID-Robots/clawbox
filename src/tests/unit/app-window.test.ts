// @vitest-environment jsdom
/**
 * src/lib/app-window.ts — what a server app's window may ask the desktop to
 * reopen with the owner's cookie (its own `/apps/<id>/…`, nothing else), and
 * the page that asks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_REOPEN_ACK,
  APP_REOPEN_MESSAGE,
  APP_REOPEN_PAGE_CSP,
  APP_REOPEN_WAIT_MS,
  appReopenHref,
  appReopenPage,
  appWindowIdOf,
} from "@/lib/app-window";

const ORIGIN = "http://box.local";

describe("appWindowIdOf", () => {
  it("names the app a frame belongs to by its address, else by the id it was opened with", () => {
    expect(appWindowIdOf("/apps/notes/", ORIGIN)).toBe("notes");
    expect(appWindowIdOf(`${ORIGIN}/apps/notes`, ORIGIN, "other")).toBe("notes");
    expect(appWindowIdOf("/setup-api/webapps?app=audiobook-player", ORIGIN)).toBe("audiobook-player");
    expect(appWindowIdOf("/setup-api/webapps/?app=x_1", ORIGIN)).toBe("x_1");
    expect(appWindowIdOf("about:blank", ORIGIN, "notes")).toBe("notes");
    expect(appWindowIdOf("/setup-api/webapps?app=notes", ORIGIN, "notes")).toBe("notes");
  });

  it("names nothing for another origin's /apps path or a bad id", () => {
    expect(appWindowIdOf("https://evil.example/apps/notes/", ORIGIN)).toBeNull();
    expect(appWindowIdOf("/apps/not%20an%20id/", ORIGIN)).toBeNull();
    expect(appWindowIdOf("/setup-api/webapps?app=../x", ORIGIN)).toBeNull();
    expect(appWindowIdOf("about:blank", ORIGIN)).toBeNull();
    expect(appWindowIdOf("about:blank", ORIGIN, "a/b")).toBeNull();
  });
});

describe("appReopenHref", () => {
  it("opens the app's own pages on this origin, query and hash kept", () => {
    expect(appReopenHref(`${ORIGIN}/apps/notes/`, "notes", ORIGIN)).toBe(`${ORIGIN}/apps/notes/`);
    expect(appReopenHref(`${ORIGIN}/apps/notes`, "notes", ORIGIN)).toBe(`${ORIGIN}/apps/notes`);
    expect(appReopenHref(`${ORIGIN}/apps/notes/notes/2?tab=a#top`, "notes", ORIGIN)).toBe(`${ORIGIN}/apps/notes/notes/2?tab=a#top`);
    expect(appReopenHref("/apps/notes/x", "notes", ORIGIN)).toBe(`${ORIGIN}/apps/notes/x`);
  });

  it("refuses the box's API, the desktop, another app and another origin", () => {
    for (const href of [
      `${ORIGIN}/setup-api/system/version`,
      `${ORIGIN}/`,
      `${ORIGIN}/login`,
      `${ORIGIN}/apps/other/`,
      `${ORIGIN}/apps/notes-evil/`,
      `${ORIGIN}/apps/notesx`,
      "https://evil.example/apps/notes/",
      "http://box.local:8080/apps/notes/",
      "javascript:alert(1)",
      "data:text/html,hi",
    ]) {
      expect(appReopenHref(href, "notes", ORIGIN), href).toBeNull();
    }
  });

  it("refuses a way out of the prefix: dot segments, encoded dots, slashes and backslashes, credentials", () => {
    for (const href of [
      `${ORIGIN}/apps/notes/../../setup-api/system/version`,
      `${ORIGIN}/apps/notes/%2e%2e/%2e%2e/setup-api/x`,
      `${ORIGIN}/apps/notes/..%2f..%2fsetup-api`,
      `${ORIGIN}/apps/notes/..%2F..%2Fsetup-api`,
      `${ORIGIN}/apps/notes/%5c..%5csetup-api`,
      `${ORIGIN}/apps/notes/.%2E/x`,
      "http://user:pw@box.local/apps/notes/",
    ]) {
      expect(appReopenHref(href, "notes", ORIGIN), href).toBeNull();
    }
  });

  it("refuses anything that is not a short string, and a bad app id", () => {
    for (const href of [undefined, null, 42, {}, "", `${ORIGIN}/apps/notes/${"a".repeat(5000)}`]) {
      expect(appReopenHref(href, "notes", ORIGIN)).toBeNull();
    }
    expect(appReopenHref(`${ORIGIN}/apps/a/b/`, "a/b", ORIGIN)).toBeNull();
  });
});

describe("appReopenPage", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.innerHTML = "<head></head><body></body>";
  });

  /** Run the page's script in this jsdom window, as if it were framed (`parent` a stand-in) or not. */
  function runPage(html: string, framed: boolean) {
    const posted: unknown[] = [];
    const replaced: string[] = [];
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const parent = frame.contentWindow!;
    vi.spyOn(parent, "postMessage").mockImplementation(((msg: unknown) => { posted.push(msg); }) as typeof parent.postMessage);
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
    const fakeLocation = { href: `${ORIGIN}/apps/notes/notes/2`, replace: (url: string) => replaced.push(url) };
    const fakeWindow: Window = new Proxy(window, {
      get(target, key) {
        if (key === "parent") return framed ? parent : fakeWindow;
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    new Function("window", "location", "setTimeout", "clearTimeout", script)(fakeWindow, fakeLocation, setTimeout, clearTimeout);
    return { posted, replaced, parent };
  }

  it("asks its parent to reopen it, stops waiting on the answer, and is a sandboxed page with one inline script", () => {
    vi.useFakeTimers();
    const html = appReopenPage("/login?redirect=%2Fapps%2Fnotes%2Fnotes%2F2");
    expect(APP_REOPEN_PAGE_CSP).toMatch(/^sandbox allow-scripts;/);
    expect(APP_REOPEN_PAGE_CSP).not.toContain("allow-same-origin");
    const { posted, replaced, parent } = runPage(html, true);
    expect(posted).toEqual([{ [APP_REOPEN_MESSAGE]: { href: `${ORIGIN}/apps/notes/notes/2` } }]);
    window.dispatchEvent(new MessageEvent("message", { data: { [APP_REOPEN_ACK]: true }, source: parent as unknown as Window }));
    vi.advanceTimersByTime(APP_REOPEN_WAIT_MS + 1000);
    expect(replaced).toEqual([]);
  });

  it("goes to /login when nobody answers, at once when it is not framed or must not ask", () => {
    vi.useFakeTimers();
    const login = "/login?redirect=%2Fapps%2Fnotes%2F";
    const unanswered = runPage(appReopenPage(login), true);
    vi.advanceTimersByTime(APP_REOPEN_WAIT_MS - 1);
    expect(unanswered.replaced).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(unanswered.replaced).toEqual([login]);

    const topLevel = runPage(appReopenPage(login), false);
    expect(topLevel.posted).toEqual([]);
    expect(topLevel.replaced).toEqual([login]);

    const signedOut = runPage(appReopenPage(login, false), true);
    expect(signedOut.posted).toEqual([]);
    expect(signedOut.replaced).toEqual([login]);
  });

  it("keeps a hostile login address inside its string", () => {
    const html = appReopenPage('/login?redirect=</script><script>alert(1)</script>"');
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).not.toContain("</script><script>alert(1)");
  });
});
