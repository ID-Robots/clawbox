/**
 * The Run history card on the Coding Agent's settings page (TASK-1178): what
 * it says and what it sends. Two modes since SCA2 C1 — the older runs
 * themselves are on a project's Runs tab (coding-agent-app.test.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingRunHistoryCard, { type RunHistorySummaryWire } from "@/components/CodingRunHistoryCard";
import { CODING_AGENT_CHANGED_EVENT } from "@/lib/ui-events";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({
  useT: () => ({ locale: "en", t }),
}));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function summary(over: Partial<RunHistorySummaryWire> = {}): RunHistorySummaryWire {
  return {
    mode: "standard",
    liveKept: 30,
    counts: { live: 30, older: 0 },
    usage: { runsFile: 1000, olderRuns: 0, evidence: 5 * 1024 * 1024, inputs: 0, streams: 0, transcripts: 0, total: 5 * 1024 * 1024 + 1000, truncated: false },
    disk: { freeBytes: 20 * 1024 ** 3, totalBytes: 64 * 1024 ** 3, minFreeBytes: 2 * 1024 ** 3, low: false },
    transcripts: [
      { file: "/home/c/.claude-ds/settings.json", label: "~/.claude-ds/settings.json", days: null, kept: false, readable: true }, // public-hygiene: allow synthetic test fixture, not a real host/account/credential
      { file: "/home/c/.claude/settings.json", label: "~/.claude/settings.json", days: null, kept: false, readable: true }, // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    ],
    ...over,
  };
}

let requests: { url: string; method: string }[];

function stubFetch(routes: (url: string, method: string) => Response | undefined) {
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    return routes(url, method) ?? json({ error: "unexpected" }, 500);
  }));
}

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CodingRunHistoryCard", () => {
  it("shows the mode, what the history weighs and the free space, and saves a new mode", async () => {
    stubFetch((url) => (url === "/setup-api/coding-agent/history" ? json(summary()) : undefined));
    const onSave = vi.fn(async () => ({}));
    render(<CodingRunHistoryCard mode="standard" liveKept={30} saving={false} onSave={onSave} error={null} />);
    const select = screen.getByTestId("coding-agent-history-mode") as HTMLSelectElement;
    expect(select.value).toBe("standard");
    // Two modes: Extended and Archive went in SCA2 C1.
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Standard", "Keep everything"]);
    expect(screen.getByTestId("coding-agent-history-mode-hint").textContent).toContain("The newest 30 runs");
    await waitFor(() => expect(screen.getByTestId("coding-agent-history-usage").textContent).toContain("Run history uses 5.0 MB on this box."));
    expect(screen.getByTestId("coding-agent-history-usage").textContent).toContain("20.0 GB free");
    expect(screen.queryByTestId("coding-agent-history-limit")).toBeNull();
    expect(screen.queryByTestId("coding-agent-history-low-disk")).toBeNull();
    // No "Open run history" button: the app's rail has the page, and the card
    // never draws one (it used to, for a host that passed a callback).
    expect(screen.queryByTestId("coding-agent-history-open")).toBeNull();
    expect(screen.getByTestId("coding-agent-history-export").getAttribute("href")).toBe("/setup-api/coding-agent/history/export");
    // No Clear archive: the archive went with its mode.
    expect(screen.queryByTestId("coding-agent-history-clear-archive")).toBeNull();
    expect(screen.queryByTestId("coding-agent-history-archive-note")).toBeNull();

    fireEvent.change(select, { target: { value: "everything" } });
    expect(onSave).toHaveBeenCalledWith({ historyRetention: "everything" });
  });

  it("warns under standard what the next run will delete — the older runs a keep-everything spell left", async () => {
    stubFetch(() => json(summary({ mode: "standard", counts: { live: 30, older: 120 } })));
    const onSave = vi.fn(async () => ({}));
    render(<CodingRunHistoryCard mode="standard" liveKept={30} saving={false} onSave={onSave} error={null} />);
    await waitFor(() => expect(screen.getByTestId("coding-agent-history-pending").textContent).toBe(
      "120 older runs are past this setting and will be deleted when the next run starts. Switch back to keep them.",
    ));
    expect(screen.getByTestId("coding-agent-history-usage").textContent).toContain("30 in the list · 120 older");
    expect(onSave).not.toHaveBeenCalled();
    // Never drawn, whatever the mode.
    expect(screen.queryByTestId("coding-agent-history-open")).toBeNull();
  });

  it("warns of nothing under keep everything", async () => {
    stubFetch(() => json(summary({ mode: "everything", counts: { live: 30, older: 120 } })));
    render(<CodingRunHistoryCard mode="everything" liveKept={30} saving={false} onSave={vi.fn(async () => ({}))} error={null} />);
    await waitFor(() => expect(screen.getByTestId("coding-agent-history-usage").textContent).toContain("120 older"));
    expect(screen.queryByTestId("coding-agent-history-pending")).toBeNull();
  });

  it("says where the transcripts stand under keep everything, and warns when the disk is low", async () => {
    stubFetch(() => json(summary({
      mode: "everything",
      disk: { freeBytes: 1024 ** 3, totalBytes: 16 * 1024 ** 3, minFreeBytes: 2 * 1024 ** 3, low: true },
      transcripts: [
        { file: "/h/.claude-ds/settings.json", label: "~/.claude-ds/settings.json", days: 36_500, kept: true, readable: true },
        { file: "/h/.claude/settings.json", label: "~/.claude/settings.json", days: null, kept: false, readable: false },
      ],
    })));
    render(<CodingRunHistoryCard mode="everything" liveKept={30} saving={false} onSave={vi.fn(async () => ({}))} error={null} />);
    await waitFor(() => expect(screen.getByTestId("coding-agent-history-transcripts").textContent).toContain("Claude Code keeps its transcripts (~/.claude-ds/settings.json)."));
    expect(screen.getByTestId("coding-agent-history-transcripts").textContent).toContain("~/.claude/settings.json is not a settings file the box can read");
    const alert = screen.getByTestId("coding-agent-history-low-disk");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("Less than 2.0 GB is free on this box.");
  });

  it("re-reads its figures when the coding agent says it changed — the app's Clear history on the same page", async () => {
    let older = 12;
    stubFetch((url) => (url === "/setup-api/coding-agent/history" ? json(summary({ mode: "everything", counts: { live: 30, older } })) : undefined));
    render(<CodingRunHistoryCard mode="everything" liveKept={30} saving={false} onSave={vi.fn(async () => ({}))} error={null} />);
    await waitFor(() => expect(screen.getByTestId("coding-agent-history-usage").textContent).toContain("12 older"));
    // The owner's Clear history just took the older runs with it.
    older = 0;
    window.dispatchEvent(new Event(CODING_AGENT_CHANGED_EVENT));
    await waitFor(() => expect(screen.getByTestId("coding-agent-history-usage").textContent).toContain("0 older"));
  });
});

