/**
 * The Import panel on the Coding Agent home: the owner's GitHub repositories
 * (with the ClawBox apps marked), and a folder on the box.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import ImportProjectPanel from "@/components/ImportProjectPanel";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const REPOS = [
  { fullName: "yalexx/tinder-clone", name: "tinder-clone", owner: "yalexx", description: "Swipe on profiles", private: true, pushedAt: "2026-09-01T00:00:00Z", clawboxApp: true, folder: "tinder-clone" },
  { fullName: "yalexx/notes", name: "notes", owner: "yalexx", description: null, private: false, pushedAt: null, clawboxApp: false, folder: "notes" },
];

let posts: { url: string; body: unknown }[];
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function stubFetch(repos: { status: number; body: unknown }, imported: { status: number; body: unknown }) {
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.startsWith("/setup-api/coding-agent/github-repos")) return json(repos.body, repos.status);
    if (url.startsWith("/setup-api/coding-agent/projects/import")) {
      posts.push({ url, body: JSON.parse(String(init?.body)) });
      return json(imported.body, imported.status);
    }
    return json({ error: "unexpected" }, 500);
  }));
}

beforeEach(() => {
  stubFetch({ status: 200, body: { login: "yalexx", repos: REPOS, truncated: false } }, { status: 200, body: { project: { directory: "/p/tinder-clone", folder: "tinder-clone", name: "Tinder Clone" }, directory: "/p/tinder-clone", folder: "tinder-clone", initialized: false, skipped: [] } });
});
afterEach(() => vi.unstubAllGlobals());

describe("ImportProjectPanel", () => {
  it("lists the repositories, marks the ClawBox apps, filters, and imports the one chosen", async () => {
    const onImported = vi.fn();
    render(<ImportProjectPanel onImported={onImported} onClose={() => {}} />);
    const rows = await screen.findAllByTestId("coding-agent-import-repo");
    expect(rows.map((r) => r.getAttribute("data-repo"))).toEqual(["yalexx/tinder-clone", "yalexx/notes"]);
    expect(screen.getAllByTestId("coding-agent-import-app-chip")).toHaveLength(1);
    expect(rows[0].textContent).toContain("Swipe on profiles");

    fireEvent.change(screen.getByTestId("coding-agent-import-filter"), { target: { value: "note" } });
    expect(screen.getAllByTestId("coding-agent-import-repo").map((r) => r.getAttribute("data-repo"))).toEqual(["yalexx/notes"]);
    fireEvent.change(screen.getByTestId("coding-agent-import-filter"), { target: { value: "zzz" } });
    expect(screen.getByText(t("codingAgent.importNoMatches"))).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("coding-agent-import-filter"), { target: { value: "" } });

    fireEvent.click(screen.getAllByTestId("coding-agent-import-repo-import")[0]);
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(posts).toEqual([{ url: "/setup-api/coding-agent/projects/import", body: { source: "github", repo: "yalexx/tinder-clone" } }]);
    expect(onImported).toHaveBeenCalledWith({ project: { directory: "/p/tinder-clone", folder: "tinder-clone", name: "Tinder Clone" }, directory: "/p/tinder-clone", folder: "tinder-clone", initialized: false, skipped: [] });
  });

  // 231 repositories, 60 rows, and the note tied to the ROUTE's truncation —
  // which was false — so everything older than the 60th was invisible and
  // nothing on screen said so.
  it("says how many repositories are listed when its own ceiling cuts the list", async () => {
    const many = Array.from({ length: 65 }, (_, i) => ({
      ...REPOS[1], fullName: `yalexx/repo-${i}`, name: `repo-${i}`, folder: `repo-${i}`,
    }));
    stubFetch({ status: 200, body: { login: "yalexx", repos: many, truncated: false } }, { status: 200, body: {} });
    render(<ImportProjectPanel onImported={() => {}} onClose={() => {}} />);
    expect(await screen.findAllByTestId("coding-agent-import-repo")).toHaveLength(60);
    expect(screen.getByTestId("coding-agent-import-truncated").textContent).toBe(t("codingAgent.importTruncated", { n: 60 }));
    // Filtered down to what fits, there is nothing hidden to warn about.
    fireEvent.change(screen.getByTestId("coding-agent-import-filter"), { target: { value: "repo-1" } });
    expect(screen.queryByTestId("coding-agent-import-truncated")).toBeNull();
  });

  // The segmented control carried a CSS `capitalize`, which title-cases EVERY
  // word: "From a folder" was drawn "From A Folder", and the German "Aus einem
  // Ordner" became "Aus Einem Ordner".
  it("leaves the tab labels cased as the translation wrote them", async () => {
    render(<ImportProjectPanel onImported={() => {}} onClose={() => {}} />);
    const folder = await screen.findByTestId("coding-agent-import-tab-folder");
    expect(folder.textContent).toBe("From a folder");
    expect(folder.className).not.toContain("capitalize");
    expect(screen.getByTestId("coding-agent-import-tab-github").className).not.toContain("capitalize");
  });

  it("says nothing about a cut when every repository is on screen", async () => {
    render(<ImportProjectPanel onImported={() => {}} onClose={() => {}} />);
    await screen.findAllByTestId("coding-agent-import-repo");
    expect(screen.queryByTestId("coding-agent-import-truncated")).toBeNull();
  });

  // The pushed date shared one `truncate` line with the description, so a repo
  // with a long summary never showed when it was last pushed — the very fact
  // this list is ordered by.
  it("keeps the pushed date on the row beside a long description", async () => {
    const long = "ClawBox — your private AI assistant on NVIDIA Jetson, with a desktop, a captive portal and a coding agent that ships";
    stubFetch({ status: 200, body: { login: "yalexx", repos: [{ ...REPOS[0], description: long }], truncated: false } }, { status: 200, body: {} });
    render(<ImportProjectPanel onImported={() => {}} onClose={() => {}} />);
    const row = (await screen.findAllByTestId("coding-agent-import-repo"))[0];
    const pushed = within(row).getByTestId("coding-agent-import-repo-pushed");
    expect(pushed.textContent).toBe(new Date("2026-09-01T00:00:00Z").toLocaleDateString());
    // Its own box, and one that never gives up its width to the description.
    expect(pushed.className).toContain("shrink-0");
    expect(pushed.className).not.toContain("truncate");
    expect(within(row).getByText(long).className).toContain("truncate");
  });

  it("clears a folder refusal when the owner switches to the GitHub tab", async () => {
    stubFetch(
      { status: 200, body: { login: "yalexx", repos: REPOS, truncated: false } },
      { status: 400, body: { error: "Give the folder as an absolute path, e.g. /home/clawbox/old-site or ~/old-site.", kind: "bad_path" } },
    );
    render(<ImportProjectPanel onImported={() => {}} onClose={() => {}} initialTab="folder" />);
    fireEvent.change(screen.getByTestId("coding-agent-import-path"), { target: { value: "relative/path" } });
    fireEvent.submit(screen.getByTestId("coding-agent-import-folder"));
    expect((await screen.findByTestId("coding-agent-import-error")).textContent).toContain("absolute path");
    fireEvent.click(screen.getByTestId("coding-agent-import-tab-github"));
    expect(screen.queryByTestId("coding-agent-import-error")).toBeNull();
  });

  // An import outlives the half that started it. The folder refusal used to
  // land wherever the owner happened to be standing, so "Give the folder as an
  // absolute path" was drawn over the repository list, naming nothing there.
  it("keeps a folder refusal that lands after the switch out of the GitHub tab", async () => {
    let refuse: (() => void) | null = null;
    const late = new Promise<Response>((resolve) => {
      refuse = () => resolve(json({ error: "Give the folder as an absolute path.", kind: "bad_path" }, 400));
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/coding-agent/github-repos")) return json({ login: "yalexx", repos: REPOS, truncated: false });
      if (url.startsWith("/setup-api/coding-agent/projects/import")) return late;
      return json({ error: "unexpected" }, 500);
    }));

    render(<ImportProjectPanel onImported={() => {}} onClose={() => {}} initialTab="folder" />);
    fireEvent.change(screen.getByTestId("coding-agent-import-path"), { target: { value: "relative/path" } });
    fireEvent.submit(screen.getByTestId("coding-agent-import-folder"));

    // Away to the other half while the request is still out.
    fireEvent.click(screen.getByTestId("coding-agent-import-tab-github"));
    await screen.findAllByTestId("coding-agent-import-repo");

    // Let the refusal land — the panel is one state write away from drawing it.
    refuse!();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(screen.queryByTestId("coding-agent-import-error")).toBeNull();
    expect(screen.getAllByTestId("coding-agent-import-repo")).toHaveLength(2);
  });

  it("says in words when no account is connected, with the way to Settings", async () => {
    stubFetch({ status: 409, body: { error: "Connect first", kind: "not_connected" } }, { status: 200, body: {} });
    const onOpenSettings = vi.fn();
    render(<ImportProjectPanel onImported={() => {}} onClose={() => {}} onOpenSettings={onOpenSettings} />);
    await screen.findByTestId("coding-agent-import-not-connected");
    fireEvent.click(screen.getByText(t("codingAgent.openSettings")));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(screen.queryByTestId("coding-agent-import-repo")).toBeNull();
  });

  it("shows the route's refusal and keeps the panel open", async () => {
    stubFetch({ status: 200, body: { login: "yalexx", repos: REPOS, truncated: false } }, { status: 409, body: { error: "There is already a \"tinder-clone\" in your project folder.", kind: "exists" } });
    const onImported = vi.fn();
    render(<ImportProjectPanel onImported={onImported} onClose={() => {}} />);
    fireEvent.click((await screen.findAllByTestId("coding-agent-import-repo-import"))[0]);
    const err = await screen.findByTestId("coding-agent-import-error");
    expect(err.textContent).toContain("already a \"tinder-clone\"");
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("coding-agent-import-repo")).toHaveLength(2);
  });

  it("copies a folder the owner typed on submit", async () => {
    const onImported = vi.fn();
    render(<ImportProjectPanel onImported={onImported} onClose={() => {}} initialTab="folder" />);
    const submit = screen.getByTestId("coding-agent-import-folder-submit");
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId("coding-agent-import-path"), { target: { value: "~/old-site" } });
    expect(submit).toBeEnabled();
    fireEvent.submit(screen.getByTestId("coding-agent-import-folder"));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(posts).toEqual([{ url: "/setup-api/coding-agent/projects/import", body: { source: "folder", path: "~/old-site" } }]);
  });

  it("offers Retry when the listing fails, and reloads on it", async () => {
    stubFetch({ status: 500, body: { error: "gh blew up", kind: "failed" } }, { status: 200, body: {} });
    render(<ImportProjectPanel onImported={() => {}} onClose={() => {}} />);
    expect(await screen.findByText("gh blew up")).toBeInTheDocument();
    stubFetch({ status: 200, body: { login: "yalexx", repos: REPOS, truncated: false } }, { status: 200, body: {} });
    fireEvent.click(screen.getByText(t("retry")));
    expect(await screen.findAllByTestId("coding-agent-import-repo")).toHaveLength(2);
  });

  it("switches between the two halves and closes", async () => {
    const onClose = vi.fn();
    render(<ImportProjectPanel onImported={() => {}} onClose={onClose} />);
    await screen.findAllByTestId("coding-agent-import-repo");
    // A tab list assistive tech can follow: each tab names its panel.
    expect(screen.getByTestId("coding-agent-import-tab-github")).toHaveAttribute("aria-controls", "coding-agent-import-panel-github");
    expect(screen.getByTestId("coding-agent-import-github")).toHaveAttribute("role", "tabpanel");
    fireEvent.click(screen.getByTestId("coding-agent-import-tab-folder"));
    expect(screen.getByTestId("coding-agent-import-folder")).toBeInTheDocument();
    expect(screen.getByTestId("coding-agent-import-folder")).toHaveAttribute("aria-labelledby", "coding-agent-import-tab-folder");
    expect(screen.queryByTestId("coding-agent-import-github")).toBeNull();
    fireEvent.click(screen.getByTestId("coding-agent-import-close"));
    expect(onClose).toHaveBeenCalled();
  });
});
