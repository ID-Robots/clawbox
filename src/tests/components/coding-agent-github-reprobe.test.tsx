/**
 * GH-01c. `githubStatus()` refuses to cache, and says why at coding-github.ts
 * lines 160-165: "`unreachable` is a statement about this moment's network, not
 * a property of the box: caching one would outlive the outage that produced it
 * and go on refusing backups after the uplink came back."
 *
 * The card then caches it anyway. `load()` runs once on mount; the only re-poll
 * is gated on `anyRunning`, i.e. a run being in progress. So an owner who opens
 * the panel during a thirty-second uplink blip sees "GitHub unreachable" with
 * no refresh affordance for as long as the panel stays mounted — the outage
 * outlives itself on the one surface the owner looks at. It is the probe-once
 * shape #518 exists to remove, moved one layer out.
 *
 * The two facts pinned here: the card keeps asking while the answer is
 * inconclusive, and it stops asking once it is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentApp from "@/components/CodingAgentApp";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const READY = { ready: true, wrapperInstalled: true, claudeInstalled: true, clawaiConnected: true, problems: [] as string[] };
const LOGIN_COMMAND = "gh auth login --hostname github.com --git-protocol https";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const UNREACHABLE = { installed: true, connected: false, login: null, loginCommand: LOGIN_COMMAND, reason: "unreachable" };
const CONNECTED = { installed: true, connected: true, login: "yalexx", loginCommand: LOGIN_COMMAND };

/** The device, with a git answer the test can change mid-flight. */
function stubFetch(next: () => Record<string, unknown>) {
  const gitCalls = { count: 0 };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = input.toString();
    if (url.startsWith("/setup-api/coding-agent/status")) {
      return json({
        enabled: true, ready: true, readiness: READY, running: 0,
        harnessCommand: "claude-ds", maxTaskChars: 4000, defaultDirectory: null,
      });
    }
    if (url.startsWith("/setup-api/coding-agent/runs")) return json({ runs: [] });
    if (url.startsWith("/setup-api/coding-agent/git")) {
      gitCalls.count += 1;
      return json(next());
    }
    return json({ error: "unexpected" }, 404);
  }));
  return gitCalls;
}

/** Let the mount's three fetches settle before anything is counted. */
async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("an inconclusive GitHub answer is asked again", () => {
  it("keeps re-probing while the card says GitHub is unreachable", async () => {
    const calls = stubFetch(() => UNREACHABLE);
    render(<CodingAgentApp />);
    await settle();

    expect(screen.queryByTestId("coding-agent-github-unreachable")).not.toBeNull();
    const afterMount = calls.count;

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    // No run is in progress, so the existing poll is off. If the card only ever
    // asks once, the outage is permanent until the panel is remounted.
    expect(calls.count).toBeGreaterThan(afterMount);
  });

  it("shows the account again once the uplink comes back, without a remount", async () => {
    let answer: Record<string, unknown> = UNREACHABLE;
    stubFetch(() => answer);
    render(<CodingAgentApp />);
    await settle();

    expect(screen.queryByTestId("coding-agent-github-unreachable")).not.toBeNull();

    answer = CONNECTED;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(screen.queryByTestId("coding-agent-github-unreachable")).toBeNull();
    expect(screen.queryByTestId("coding-agent-github-login")?.textContent).toBe("yalexx");
  });

  it("stops asking once the answer is one to trust", async () => {
    // The discriminator: a healthy, connected box must not acquire a new
    // background poll it never had. Re-probing is for the inconclusive state
    // only.
    const calls = stubFetch(() => CONNECTED);
    render(<CodingAgentApp />);
    await settle();

    const afterMount = calls.count;

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(calls.count).toBe(afterMount);
  });

  it("stops asking once a settled failure is known", async () => {
    // `not_installed` is a property of the box, not of this moment's network.
    // Asking again forever would be a poll with nothing to learn.
    const calls = stubFetch(() => ({
      installed: false, connected: false, login: null, loginCommand: LOGIN_COMMAND, reason: "not_installed",
    }));
    render(<CodingAgentApp />);
    await settle();

    const afterMount = calls.count;

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(calls.count).toBe(afterMount);
  });
});

describe("a login made somewhere else", () => {
  it("shows up without a reload: the card keeps asking while merely not connected", async () => {
    // Not installed / not runnable are settled and stop the timer; plain
    // "not connected" is not: the owner may be finishing `gh auth login` in a
    // terminal right now, and a card that never asks again reads as "failed".
    let answer: Record<string, unknown> = { installed: true, connected: false, login: null, loginCommand: LOGIN_COMMAND };
    const calls = stubFetch(() => answer);
    render(<CodingAgentApp />);
    await settle();
    const afterMount = calls.count;

    answer = CONNECTED;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(calls.count).toBeGreaterThan(afterMount);
    expect(screen.queryByText(/yalexx/)).not.toBeNull();
  });
});
