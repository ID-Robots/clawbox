/**
 * The GitHub device-flow card polls at the cadence the ROUTE answers with.
 *
 * github.com's `slow_down` is answered to the box, and the box now refuses to
 * ask early — but a card that kept its original timer would spend most of
 * its ticks being told "not yet" from memory. So every pending answer carries
 * the interval, and the card reschedules from it. And the interval is clamped
 * to GitHub's own floor: `data.interval ?? 5` accepted `0`, which is
 * `setInterval(fn, 0)` — a hot loop against the box.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentSettingsPanel, { devicePollSeconds } from "@/components/CodingAgentSettingsPanel";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const READY = { ready: true, wrapperInstalled: true, claudeInstalled: true, clawaiConnected: true, problems: [] as string[] };
const LOGIN_COMMAND = "gh auth login --hostname github.com --git-protocol https";
const NOT_CONNECTED = { installed: true, connected: false, login: null, loginCommand: LOGIN_COMMAND };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The device, with the login route's answers under the test's control. */
function stubFetch(opts: { startInterval: unknown; pollAnswer: () => Record<string, unknown> }) {
  const polls = { count: 0 };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.startsWith("/setup-api/coding-agent/status")) {
      return json({
        enabled: true, ready: true, readiness: READY, running: 0,
        harnessCommand: "claude-ds", maxTaskChars: 4000, defaultDirectory: null,
      });
    }
    if (url.startsWith("/setup-api/coding-agent/runs")) return json({ runs: [] });
    // Matched by path, not prefix: "/git" is a prefix of "/github-login".
    if (url.split("?")[0] === "/setup-api/coding-agent/git") return json(NOT_CONNECTED);
    if (url.startsWith("/setup-api/coding-agent/github-login")) {
      const { action } = JSON.parse(String(init?.body)) as { action: string };
      if (action === "start") {
        return json({ userCode: "8A5B-0396", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: opts.startInterval });
      }
      if (action === "poll") {
        polls.count += 1;
        return json(opts.pollAnswer());
      }
      return json({ ok: true });
    }
    return json({ error: "unexpected" }, 404);
  }));
  return polls;
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

/** Mount, and press Connect until the code is on screen. */
async function openDeviceLogin() {
  render(<CodingAgentSettingsPanel />);
  await advance(50);
  fireEvent.click(screen.getByTestId("coding-agent-github-connect"));
  await advance(50);
  expect(screen.getByTestId("coding-agent-github-device-code-value").textContent).toBe("8A5B-0396");
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("devicePollSeconds", () => {
  it("clamps to GitHub's five-second floor and never yields zero", () => {
    expect(devicePollSeconds(0)).toBe(5);
    expect(devicePollSeconds(undefined)).toBe(5);
    expect(devicePollSeconds(null)).toBe(5);
    expect(devicePollSeconds("nonsense")).toBe(5);
    expect(devicePollSeconds(-3)).toBe(5);
    expect(devicePollSeconds(3)).toBe(5);
  });

  it("keeps a slower cadence as given", () => {
    expect(devicePollSeconds(10)).toBe(10);
    expect(devicePollSeconds("15")).toBe(15);
  });
});

describe("the poll cadence", () => {
  it("does not spin when the route answers an interval of zero", async () => {
    const polls = stubFetch({ startInterval: 0, pollAnswer: () => ({ status: "pending", interval: 0 }) });
    await openDeviceLogin();

    await advance(4_000);
    expect(polls.count).toBe(0);
    await advance(2_000);
    expect(polls.count).toBe(1);
    // Thirty seconds of a five-second cadence is six polls, not thousands.
    await advance(30_000);
    expect(polls.count).toBeLessThanOrEqual(7);
    expect(polls.count).toBeGreaterThanOrEqual(6);
  });

  it("reschedules from the interval each pending answer carries — a slow_down slows the card down", async () => {
    let interval = 5;
    const polls = stubFetch({ startInterval: 5, pollAnswer: () => ({ status: "pending", interval }) });
    await openDeviceLogin();

    // github.com said slow_down to the box; the box now answers 15.
    interval = 15;
    await advance(5_100);
    expect(polls.count).toBe(1);

    // On the old cadence a second poll would go out at ten seconds.
    await advance(5_000);
    expect(polls.count).toBe(1);
    await advance(11_000);
    expect(polls.count).toBe(2);
  });

  it("still ends the wait on a verdict", async () => {
    let answer: Record<string, unknown> = { status: "pending", interval: 5 };
    stubFetch({ startInterval: 5, pollAnswer: () => answer });
    await openDeviceLogin();

    answer = { status: "connected", login: "yalexx" };
    await advance(5_100);
    expect(screen.queryByTestId("coding-agent-github-device")).toBeNull();
  });
});
