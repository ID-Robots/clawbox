/**
 * The Import panel on the Coding Agent home: the owner's GitHub repositories
 * (with the ClawBox apps marked), and a folder on the box.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
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

  it("copies a folder the owner typed, on submit and on Enter", async () => {
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

  it("switches between the two halves and closes", async () => {
    const onClose = vi.fn();
    render(<ImportProjectPanel onImported={() => {}} onClose={onClose} />);
    await screen.findAllByTestId("coding-agent-import-repo");
    fireEvent.click(screen.getByTestId("coding-agent-import-tab-folder"));
    expect(screen.getByTestId("coding-agent-import-folder")).toBeInTheDocument();
    expect(screen.queryByTestId("coding-agent-import-github")).toBeNull();
    fireEvent.click(screen.getByTestId("coding-agent-import-close"));
    expect(onClose).toHaveBeenCalled();
  });
});
