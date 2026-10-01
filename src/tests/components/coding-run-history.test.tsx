/**
 * The Run history card on the Coding Agent's settings page and the Run history
 * page (TASK-1178): what they say, what they send, and what they open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingRunHistoryCard, { olderRunsOverLimit, type RunHistorySummaryWire } from "@/components/CodingRunHistoryCard";
import CodingRunHistoryPage from "@/components/CodingRunHistoryPage";
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
    limit: 100,
    limits: [100, 300, 1000],
    liveKept: 30,
    counts: { live: 30, older: 0, archived: 0 },
    usage: { runsFile: 1000, olderRuns: 0, evidence: 5 * 1024 * 1024, inputs: 0, streams: 0, archive: 0, transcripts: 0, total: 5 * 1024 * 1024 + 1000, truncated: false },
    disk: { freeBytes: 20 * 1024 ** 3, totalBytes: 64 * 1024 ** 3, minFreeBytes: 2 * 1024 ** 3, low: false },
    transcripts: [
      { file: "/home/c/.claude-ds/settings.json", label: "~/.claude-ds/settings.json", days: null, kept: false, readable: true },
      { file: "/home/c/.claude/settings.json", label: "~/.claude/settings.json", days: null, kept: false, readable: true },
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

describe("olderRunsOverLimit", () => {
  it("counts what the next run would take away, the way the trim does", () => {
    const counts = { live: 30, older: 120, archived: 0 };
    expect(olderRunsOverLimit("standard", 100, counts)).toBe(120);
    expect(olderRunsOverLimit("archive", 100, counts)).toBe(120);
    expect(olderRunsOverLimit("extended", 100, counts)).toBe(50);
    expect(olderRunsOverLimit("extended", 300, counts)).toBe(0);
    expect(olderRunsOverLimit("everything", 100, counts)).toBe(0);
  });
});

describe("CodingRunHistoryCard", () => {
  it("shows the mode, what the history weighs and the free space, and saves a new mode", async () => {
    stubFetch((url) => (url === "/setup-api/coding-agent/history" ? json(summary()) : undefined));
    const onSave = vi.fn(async () => ({}));
    render(<CodingRunHistoryCard mode="standard" limit={100} limits={[100, 300, 1000]} liveKept={30} saving={false} onSave={onSave} error={null} />);
    const select = screen.getByTestId("coding-agent-history-mode") as HTMLSelectElement;
    expect(select.value).toBe("standard");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Standard", "Extended", "Keep everything", "Archive"]);
    expect(screen.getByTestId("coding-agent-history-mode-hint").textContent).toContain("The newest 30 runs");
    await waitFor(() => expect(screen.getByTestId("coding-agent-history-usage").textContent).toContain("Run history uses 5.0 MB on this box."));
    expect(screen.getByTestId("coding-agent-history-usage").textContent).toContain("20.0 GB free");
    expect(screen.queryByTestId("coding-agent-history-limit")).toBeNull();
    expect(screen.queryByTestId("coding-agent-history-low-disk")).toBeNull();
    // No button to a page this host does not have.
    expect(screen.queryByTestId("coding-agent-history-open")).toBeNull();
    expect(screen.getByTestId("coding-agent-history-export").getAttribute("href")).toBe("/setup-api/coding-agent/history/export");
    expect((screen.getByTestId("coding-agent-history-clear-archive") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(select, { target: { value: "archive" } });
    expect(onSave).toHaveBeenCalledWith({ historyRetention: "archive" });
  });

  it("offers N under extended, and warns what the next run will delete", async () => {
    stubFetch(() => json(summary({ mode: "extended", counts: { live: 30, older: 120, archived: 0 } })));
    const onSave = vi.fn(async () => ({}));
    render(<CodingRunHistoryCard mode="extended" limit={100} limits={[100, 300, 1000]} liveKept={30} saving={false} onSave={onSave} error={null} onOpenHistory={() => {}} />);
    const limit = screen.getByTestId("coding-agent-history-limit") as HTMLSelectElement;
    expect(Array.from(limit.options).map((o) => o.textContent)).toEqual(["100 runs", "300 runs", "1000 runs"]);
    await waitFor(() => expect(screen.getByTestId("coding-agent-history-pending").textContent).toBe(
      "50 older runs are past this setting and will be deleted when the next run starts. Switch back to keep them.",
    ));
    fireEvent.change(limit, { target: { value: "300" } });
    expect(onSave).toHaveBeenCalledWith({ historyLimit: 300 });
    expect(screen.getByTestId("coding-agent-history-open")).toBeTruthy();
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
    render(<CodingRunHistoryCard mode="everything" limit={100} limits={[100, 300, 1000]} liveKept={30} saving={false} onSave={vi.fn(async () => ({}))} error={null} />);
    await waitFor(() => expect(screen.getByTestId("coding-agent-history-transcripts").textContent).toContain("Claude Code keeps its transcripts (~/.claude-ds/settings.json)."));
    expect(screen.getByTestId("coding-agent-history-transcripts").textContent).toContain("~/.claude/settings.json is not a settings file the box can read");
    const alert = screen.getByTestId("coding-agent-history-low-disk");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("Less than 2.0 GB is free on this box.");
  });

  it("re-reads its figures when the coding agent says it changed — the app's Clear history on the same page", async () => {
    let archived = 0;
    stubFetch((url) => (url === "/setup-api/coding-agent/history" ? json(summary({ mode: "archive", counts: { live: 30, older: 0, archived } })) : undefined));
    render(<CodingRunHistoryCard mode="archive" limit={100} limits={[100, 300, 1000]} liveKept={30} saving={false} onSave={vi.fn(async () => ({}))} error={null} />);
    await waitFor(() => expect(screen.getByTestId("coding-agent-history-usage").textContent).toContain("0 archived"));
    expect((screen.getByTestId("coding-agent-history-clear-archive") as HTMLButtonElement).disabled).toBe(true);
    // The owner's Clear history just moved 12 runs into the archive.
    archived = 12;
    window.dispatchEvent(new Event(CODING_AGENT_CHANGED_EVENT));
    await waitFor(() => expect(screen.getByTestId("coding-agent-history-usage").textContent).toContain("12 archived"));
    expect((screen.getByTestId("coding-agent-history-clear-archive") as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears the archive on the second tap only, and says how many went", async () => {
    let archived = 3;
    stubFetch((url, method) => {
      if (url === "/setup-api/coding-agent/history?view=archive" && method === "DELETE") {
        const cleared = archived;
        archived = 0;
        return json({ cleared });
      }
      if (url === "/setup-api/coding-agent/history") return json(summary({ mode: "archive", counts: { live: 30, older: 0, archived } }));
      return undefined;
    });
    render(<CodingRunHistoryCard mode="archive" limit={100} limits={[100, 300, 1000]} liveKept={30} saving={false} onSave={vi.fn(async () => ({}))} error={null} />);
    const button = screen.getByTestId("coding-agent-history-clear-archive") as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(screen.getByTestId("coding-agent-history-archive-note")).toBeTruthy();
    fireEvent.click(button);
    expect(button.textContent).toBe("Delete 3 archived runs?");
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId("coding-agent-history-clear-note").textContent).toContain("Deleted 3 archived runs."));
    expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    await waitFor(() => expect((screen.getByTestId("coding-agent-history-clear-archive") as HTMLButtonElement).disabled).toBe(true));
  });
});

describe("CodingRunHistoryPage", () => {
  const OLDER = {
    id: "run-older001", task: "# Build the pong game\nwith sound", status: "completed", startedAt: 1_700_000_000_000, completedAt: 1_700_000_100_000,
    directory: "/home/c/Projects/pong", numTurns: 12, filesTouched: ["a.js", "b.css"],
  };
  const ENTRY = {
    id: "run-archiv01", title: "Make the landing page", status: "failed", startedAt: 1_690_000_000_000, completedAt: 1_690_000_100_000,
    archivedAt: 1_700_000_000_000, directory: "/home/c/Projects/site", project: "/home/c/Projects/site", bytes: 2048,
    evidence: 2, inputs: 1, transcript: true, stream: false, reason: "trimmed",
  };
  const DETAIL = {
    entry: ENTRY,
    record: { ...ENTRY, task: "Make the landing page\nwith a hero", resultText: "It did not build.", error: "npm ERR!", progress: ["Started", "Ran npm test"], progressAt: [1_690_000_000_000, 1_690_000_050_000], filesTouched: ["index.html"] },
    evidence: [{ name: "shot.png", bytes: 1000, kind: "image" }, { name: "report.md", bytes: 48, kind: "markdown" }],
    inputs: [{ name: "brief.txt", bytes: 12 }],
    transcriptBytes: 4096,
    streamBytes: null,
  };

  function routes(url: string) {
    if (url.startsWith("/setup-api/coding-agent/runs?history=1")) return json({ runs: [OLDER], total: 1, offset: 0 });
    if (url.startsWith("/setup-api/coding-agent/history?view=archive&id=run-archiv01")) return json({ run: DETAIL });
    if (url.startsWith("/setup-api/coding-agent/history?view=archive&id=")) return json({ error: "no", kind: "not_found" }, 404);
    if (url.startsWith("/setup-api/coding-agent/history?view=archive")) return json({ entries: [ENTRY], total: 1, offset: 0 });
    return undefined;
  }

  it("lists the older runs first and opens one on the ordinary run page", async () => {
    stubFetch(routes);
    const onOpenRun = vi.fn();
    render(<CodingRunHistoryPage onOpenRun={onOpenRun} />);
    const row = await screen.findByTestId("coding-agent-history-older-run-older001");
    expect(row.textContent).toContain("Build the pong game");
    expect(row.textContent).toContain("12 turns · 2 files");
    expect(screen.getByTestId("coding-agent-history-tab-older").textContent).toContain("(1)");
    expect(screen.getByTestId("coding-agent-history-tab-archived").textContent).toContain("(1)");
    // The older runs are asked for with their evidence: the run page draws it.
    expect(requests.some((r) => r.url.includes("history=1") && r.url.includes("artifacts=1"))).toBe(true);
    fireEvent.click(row);
    expect(onOpenRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run-older001" }));
  });

  it("shows an archived run read-only, with its evidence, its summary and its zip", async () => {
    stubFetch(routes);
    render(<CodingRunHistoryPage onOpenRun={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("coding-agent-history-tab-archived"));
    const zip = screen.getByTestId("coding-agent-history-archived-export-run-archiv01");
    expect(zip.getAttribute("href")).toBe("/setup-api/coding-agent/history/export?runId=run-archiv01");
    fireEvent.click(screen.getByTestId("coding-agent-history-archived-run-archiv01"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-archived-title").textContent).toBe("Make the landing page"));
    expect(screen.getByTestId("coding-agent-archived-readonly").textContent).toBe("Read-only");
    expect(screen.getByTestId("coding-agent-archived-summary").textContent).toContain("It did not build.");
    expect(screen.getByTestId("coding-agent-archived-summary").textContent).toContain("npm ERR!");
    const img = screen.getByTestId("coding-agent-archived-evidence").querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/setup-api/coding-agent/history/file?runId=run-archiv01&file=shot.png");
    expect(screen.getByTestId("coding-agent-archived-activity").textContent).toContain("Ran npm test");
    expect(screen.getByTestId("coding-agent-archived-transcript").textContent).toContain("4.0 KB");
    expect(screen.getByTestId("coding-agent-archived-export").getAttribute("href")).toBe("/setup-api/coding-agent/history/export?runId=run-archiv01");
    fireEvent.click(screen.getByTestId("coding-agent-archived-back"));
    expect(await screen.findByTestId("coding-agent-history-archived")).toBeTruthy();
  });

  it("opens straight onto an archived run it was asked for, and says so when it is gone", async () => {
    stubFetch(routes);
    const { unmount } = render(<CodingRunHistoryPage onOpenRun={vi.fn()} initialArchivedId="run-archiv01" />);
    await waitFor(() => expect(screen.getByTestId("coding-agent-archived-title").textContent).toBe("Make the landing page"));
    unmount();
    render(<CodingRunHistoryPage onOpenRun={vi.fn()} initialArchivedId="run-gone0000" />);
    await waitFor(() => expect(screen.getByTestId("coding-agent-archived-run").textContent).toContain("That run is not in the archive any more."));
  });

  it("says why a list is empty, and opens on the archive when only it has runs", async () => {
    stubFetch((url) => {
      if (url.startsWith("/setup-api/coding-agent/runs?history=1")) return json({ runs: [], total: 0, offset: 0 });
      if (url.startsWith("/setup-api/coding-agent/history?view=archive")) return json({ entries: [ENTRY], total: 1, offset: 0 });
      return undefined;
    });
    render(<CodingRunHistoryPage onOpenRun={vi.fn()} />);
    expect(await screen.findByTestId("coding-agent-history-archived")).toBeTruthy();
    fireEvent.click(screen.getByTestId("coding-agent-history-tab-older"));
    expect(screen.getByTestId("coding-agent-history-older-empty").textContent).toContain("keep more than the newest 30");
  });
});
