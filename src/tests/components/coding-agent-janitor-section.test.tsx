/**
 * "Clean up old run folders" in the Coding Agent settings
 * (CodingAgentJanitorSection.tsx): the switch and the retention are saved
 * through /setup-api/coding-agent/janitor, the dry run lists every candidate
 * with what would happen and why, and "Clean now" reports what it did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentJanitorSection from "@/components/CodingAgentJanitorSection";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const VIEW = {
  settings: { enabled: true, retentionDays: 14 },
  limits: { minRetentionDays: 1, maxRetentionDays: 365, defaultRetentionDays: 14, maxRemovalsPerPass: 25 },
  lastPass: null,
  nextPassAt: null,
  running: false,
  log: [],
};
const PLAN = {
  projectFolder: "/p",
  userProjects: 3,
  entries: [
    { path: "/p/shop-ref-task-7", kind: "worktree", branch: "ref-task-7", action: "remove", reason: "merged", idleDays: 30 },
    { path: "/p/shop/.clawbox/worktrees/run-abc", kind: "worktree", branch: "clawbox/run-abc", action: "keep", reason: "live_run", idleDays: null },
    { path: "/p/shop-wip", kind: "worktree", branch: "wip", action: "keep", reason: "dirty", idleDays: 40 },
  ],
};

let posts: unknown[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  posts = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      if (body.action === "clean") return json({ result: { at: 1, removed: 1, trashed: 0, pruned: 0, failed: 0, kept: 2, freedBytes: 2048 }, lastPass: null });
      return json({ settings: { ...VIEW.settings, ...body } });
    }
    return json(url.includes("plan=1") ? { ...VIEW, plan: PLAN } : VIEW);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CodingAgentJanitorSection", () => {
  it("shows the switch and the retention, and saves each", async () => {
    render(<CodingAgentJanitorSection />);
    const days = await screen.findByTestId("coding-agent-janitor-days");
    await waitFor(() => expect((days as HTMLInputElement).value).toBe("14"));
    const toggle = screen.getByTestId("coding-agent-janitor-enabled");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe(translations.en["codingAgent.janitorLabel"]);

    fireEvent.click(toggle);
    await waitFor(() => expect(posts).toContainEqual({ enabled: false }));
    await waitFor(() => expect(screen.getByTestId("coding-agent-janitor-enabled").getAttribute("aria-checked")).toBe("false"));

    fireEvent.change(days, { target: { value: "30" } });
    fireEvent.blur(days);
    await waitFor(() => expect(posts).toContainEqual({ retentionDays: 30 }));
  });

  it("refuses a retention out of range without asking the box", async () => {
    render(<CodingAgentJanitorSection />);
    const days = await screen.findByTestId("coding-agent-janitor-days");
    await waitFor(() => expect((days as HTMLInputElement).value).toBe("14"));
    fireEvent.change(days, { target: { value: "0" } });
    fireEvent.blur(days);
    expect(await screen.findByText(translations.en["codingAgent.janitorFailed"])).toBeTruthy();
    expect(posts).toEqual([]);
    expect((days as HTMLInputElement).value).toBe("14");
  });

  it("lists the dry run: what would go, and why each of the rest is kept", async () => {
    render(<CodingAgentJanitorSection />);
    const preview = await screen.findByTestId("coding-agent-janitor-preview");
    await waitFor(() => expect((preview as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(preview);
    const plan = await screen.findByTestId("coding-agent-janitor-plan");
    expect(within(plan).getByText(t("codingAgent.janitorPlanSummary", { go: 1, kept: 2 }))).toBeTruthy();
    const rows = within(plan).getAllByTestId("coding-agent-janitor-entry");
    expect(rows.map((r) => [r.getAttribute("data-action"), r.getAttribute("data-reason")])).toEqual([["remove", "merged"], ["keep", "live_run"], ["keep", "dirty"]]);
    expect(rows[0].textContent).toContain("shop-ref-task-7");
    expect(rows[0].textContent).toContain(translations.en["codingAgent.janitorReason.merged"]);
    expect(rows[1].textContent).toContain(translations.en["codingAgent.janitorReason.liveRun"]);
    expect(rows[2].textContent).toContain(t("codingAgent.janitorIdle", { days: 40 }));
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("plan=1"))).toBe(true);
  });

  it("cleans now and says what it did", async () => {
    render(<CodingAgentJanitorSection />);
    const clean = await screen.findByTestId("coding-agent-janitor-clean");
    await waitFor(() => expect((clean as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(clean);
    const result = await screen.findByTestId("coding-agent-janitor-result");
    expect(result.textContent).toBe(t("codingAgent.janitorResult", { removed: 1, trashed: 0, pruned: 0, kept: 2, size: "2.0 KB" }));
    expect(posts).toContainEqual({ action: "clean" });
  });

  it("stays quiet, and never throws, when the route answers something else", async () => {
    // The e2e stubs answer every unknown route with `{}`; an older server
    // answers 404. Neither may take the settings panel down.
    fetchMock.mockImplementation(async () => json({}));
    render(<CodingAgentJanitorSection />);
    const toggle = await screen.findByTestId("coding-agent-janitor-enabled");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(((await screen.findByTestId("coding-agent-janitor-preview")) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says so when a clean-up is already running", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ error: "busy", kind: "busy" }, 409) : json(VIEW));
    render(<CodingAgentJanitorSection />);
    const clean = await screen.findByTestId("coding-agent-janitor-clean");
    await waitFor(() => expect((clean as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(clean);
    expect(await screen.findByText(translations.en["codingAgent.janitorBusy"])).toBeTruthy();
  });
});
