/**
 * The Coding Agent app's own clock (`now` in src/components/CodingAgentApp.tsx).
 *
 * It is what redraws the page's "N minutes ago" labels — a project's last
 * commit, a run's "started"/"updated" — because `timeAgo` reads the time when
 * the page is drawn. It used to tick only while a run was live; with nothing
 * live, the desktop's own renders (its clock, the pairing poll) redrew the
 * window as a side effect. The desktop's windows are memoised now, so on an
 * idle box a label that said "just now" still said it an hour later.
 *
 * Pinned: idle, the labels move once a minute; while the page is hidden the
 * clock stops; on the way back it is set at once, without waiting for a read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentApp, { NOW_IDLE_TICK_MS, NOW_LIVE_TICK_MS } from "@/components/CodingAgentApp";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));
vi.mock("@/components/TerminalApp", () => ({ default: () => <div data-testid="terminal-mock" /> }));
vi.mock("@/components/VNCApp", () => ({ default: () => <div data-testid="vnc-mock" /> }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SUBJECT = "Coding agent: add a dark mode toggle";
const READY = { ready: true, wrapperInstalled: true, claudeInstalled: true, clawaiConnected: true, problems: [] as string[] };

/** The box: one project, committed to "now", and whatever runs the test passes. */
function stubBox(runs: unknown[] = []) {
  const commitAt = Date.now();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = input.toString();
    if (url.startsWith("/setup-api/coding-agent/status")) {
      return json({
        enabled: true, ready: true, readiness: READY, running: 0, harnessCommand: "claude-ds", maxTaskChars: 4000,
        defaultDirectory: "/home/clawbox/Projects", setupComplete: true,
        effort: "ultracode", effortLevels: ["low", "xhigh", "max", "ultracode"], reviewPass: false,
      });
    }
    if (url.startsWith("/setup-api/coding-agent/runs")) return json({ runs });
    if (url.startsWith("/setup-api/coding-agent/projects")) {
      return json({
        directory: "/home/clawbox/Projects",
        projects: [{
          folder: "site", directory: "/home/clawbox/Projects/site", kind: "folder", name: "My Site",
          lastCommit: { subject: SUBJECT, date: commitAt }, onDesktop: false, latestRun: null,
        }],
      });
    }
    if (url === "/setup-api/coding-agent/git") return json({ installed: false, connected: false, login: null, loginCommand: "gh auth login" });
    if (url === "/setup-api/ai-models/status") return json({ clawaiConfigured: true, clawaiAccountTier: "flash" });
    return json({ error: "unexpected" }, 404);
  }));
}

/** The project row's commit line, by the text it carries. */
const commitLine = (ago: string) => screen.queryByText(`${SUBJECT} · ${ago}`);
const justNow = () => t("clawkeep.justNow");
const minutesAgo = (count: number) => t("clawkeep.minutesAgo", { count });

let visibility: DocumentVisibilityState = "visible";
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const setVisibility = (next: DocumentVisibilityState) => {
  visibility = next;
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
};

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe("the Coding Agent's clock with no run live", () => {
  it("moves the \"ago\" labels once a minute", async () => {
    stubBox();
    render(<CodingAgentApp />);
    await advance(50);
    expect(commitLine(justNow())).not.toBeNull();

    // Inside the minute nothing is drawn again — and nothing needs to be.
    await advance(NOW_IDLE_TICK_MS - 1_000);
    expect(commitLine(justNow())).not.toBeNull();

    await advance(1_000);
    expect(commitLine(minutesAgo(1))).not.toBeNull();

    await advance(2 * NOW_IDLE_TICK_MS);
    expect(commitLine(minutesAgo(3))).not.toBeNull();
  });

  it("stops while the page is hidden, and is set at once when it is shown again", async () => {
    stubBox();
    render(<CodingAgentApp />);
    await advance(50);
    expect(commitLine(justNow())).not.toBeNull();

    setVisibility("hidden");
    await advance(3 * NOW_IDLE_TICK_MS);
    // Nothing was drawn for a page nobody could see.
    expect(commitLine(justNow())).not.toBeNull();

    // The box is slow to answer the read the visible edge makes: the label
    // must not wait for it. Only the clock can have moved it.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    setVisibility("visible");
    expect(commitLine(minutesAgo(3))).not.toBeNull();

    // And it ticks on from there.
    await advance(NOW_IDLE_TICK_MS);
    expect(commitLine(minutesAgo(4))).not.toBeNull();
  });
});

describe("the Coding Agent's clock while a run is live", () => {
  it("still ticks every second, and stops while the page is hidden", async () => {
    // The live poll would redraw the page every 5 s on its own; hold its reads
    // so the only thing that can move the label is the clock.
    const LIVE = {
      id: "run-live0001", task: "Add a dark mode toggle", directory: "/home/clawbox/Projects/site", projectId: null,
      source: "agent", status: "running", startedAt: Date.now(), completedAt: null, summary: null, error: null,
      numTurns: 1, filesTouched: [], permissionDenials: 0, progress: [],
    };
    stubBox([LIVE]);
    render(<CodingAgentApp />);
    await advance(50);
    expect(commitLine(justNow())).not.toBeNull();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    // 59.95 s in: still "just now"; the next second's tick is what says 1m.
    await advance(NOW_IDLE_TICK_MS - 50 - NOW_LIVE_TICK_MS);
    expect(commitLine(justNow())).not.toBeNull();
    await advance(NOW_LIVE_TICK_MS + 50);
    expect(commitLine(minutesAgo(1))).not.toBeNull();

    setVisibility("hidden");
    await advance(2 * NOW_IDLE_TICK_MS);
    expect(commitLine(minutesAgo(1))).not.toBeNull();
    setVisibility("visible");
    expect(commitLine(minutesAgo(3))).not.toBeNull();
  });
});
