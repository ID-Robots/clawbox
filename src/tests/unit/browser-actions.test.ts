/**
 * The Browser app's two writes (src/lib/browser-actions.ts).
 *
 * Three components post through these now — the app, its wizard and its
 * settings page — and none of them can recover on its own from a request that
 * never answers: each sets a `busy` flag before the call and clears it after,
 * so a promise that stays pending leaves a spinner the owner can only escape
 * by reloading the window. What is pinned here is that every write carries a
 * deadline, that each deadline is longer than the route's own worst case (a
 * timeout must mean "wedged", never "slow"), and that tripping one becomes the
 * `unreachable` refusal every locale already words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTION_DEADLINE_MS,
  runBrowserAction,
  saveBrowserSetup,
  type BrowserAction,
} from "@/lib/browser-actions";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const signalFor = (call: number) =>
  (fetchMock.mock.calls[call][1] as RequestInit).signal as AbortSignal | undefined;

describe("the deadline on a device write", () => {
  it("is on every call the app can make", async () => {
    const actions: BrowserAction[] = ["install-chromium", "enable", "disable", "open-browser", "close-browser"];
    for (const action of actions) await runBrowserAction(action);
    await saveBrowserSetup({ autoOpen: false });
    for (let i = 0; i <= actions.length; i++) {
      expect(signalFor(i)).toBeInstanceOf(AbortSignal);
      expect(signalFor(i)?.aborted).toBe(false);
    }
  });

  it("gives each action more rope than the route's own worst case", async () => {
    // install-chromium runs dpkg, apt update, apt install, snap install, apt
    // install again and the Playwright runtime IN SERIES — the route's own
    // exec timeouts add up past ten minutes on their own.
    expect(ACTION_DEADLINE_MS["install-chromium"]).toBeGreaterThan(10 * 60_000);
    // enable and disable each write config and restart the gateway.
    expect(ACTION_DEADLINE_MS.enable).toBeGreaterThan(60_000);
    expect(ACTION_DEADLINE_MS.disable).toBe(ACTION_DEADLINE_MS.enable);
    // open-browser clears the agent's hold on the CDP port (five one-second
    // rounds), starts the unit and then waits ten seconds for readiness;
    // close-browser gives systemctl thirty.
    expect(ACTION_DEADLINE_MS["open-browser"]).toBeGreaterThan(60_000);
    expect(ACTION_DEADLINE_MS["close-browser"]).toBeGreaterThan(60_000);
    // And the slowest action is the install, by a wide margin.
    const others = (["enable", "disable", "open-browser", "close-browser"] as BrowserAction[])
      .map((a) => ACTION_DEADLINE_MS[a]);
    expect(ACTION_DEADLINE_MS["install-chromium"]).toBeGreaterThan(Math.max(...others));
  });

  it("turns a request that never answers into the refusal the locales word", async () => {
    // What a tripped AbortSignal looks like from here: the fetch rejects. The
    // `code` is what browserErrorText reads, and it has a key for `unreachable`
    // in all ten languages — the device's own English sentence is only ever a
    // fallback for a refusal we have no wording for.
    fetchMock.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await runBrowserAction("open-browser")).toMatchObject({ ok: false, code: "unreachable" });
    fetchMock.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await saveBrowserSetup({ startUrl: null })).toMatchObject({ ok: false, code: "unreachable" });
  });
});

describe("what a refusal carries", () => {
  it("keeps the route's code, and names the one refusal the route states without one", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ code: "owner_only" }) });
    expect(await runBrowserAction("enable")).toMatchObject({ code: "owner_only" });
    // The agent's own headless browser holding the CDP port is the 409 the
    // route answers with a sentence and no code.
    fetchMock.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({}) });
    expect(await runBrowserAction("open-browser")).toMatchObject({ code: "agent_holds_cdp" });
  });
});
