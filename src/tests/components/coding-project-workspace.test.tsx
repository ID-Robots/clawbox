/**
 * The project page's workspace (src/components/CodingProjectWorkspace.tsx):
 * Activity · Files · Changes with no inputs (2026-10-30). The folder as a
 * tree read through the tree route, one file beside it READ-ONLY (editing
 * belongs to the Files app, which Open in Files points at the folder), and
 * what changed — the working tree or one commit, stepped with Newer / Older
 * — with a unified diff per file. On a phone one pane at a time. Against a
 * stubbed device, with the real English strings so a missing key fails here
 * rather than on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingProjectWorkspace, { DiffView } from "@/components/CodingProjectWorkspace";
import { OPEN_APP_EVENT, type OpenAppDetail } from "@/lib/ui-events";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SHA = "a".repeat(40);
const OLDER = "b".repeat(40);

const ROOT_LISTING = {
  path: "",
  truncated: false,
  entries: [
    { name: "src", type: "directory", size: null, modified: "2026-09-05T00:00:00.000Z" },
    { name: "README.md", type: "file", size: 5, modified: "2026-09-05T00:00:00.000Z" },
    { name: "logo.png", type: "file", size: 8, modified: "2026-09-05T00:00:00.000Z" },
  ],
};
const SRC_LISTING = { path: "src", truncated: false, entries: [{ name: "app.js", type: "file", size: 30, modified: "2026-09-05T00:00:00.000Z" }] };

const WORKING = {
  available: true, truncated: false, additions: 5, deletions: 1,
  files: [
    { path: "a.txt", status: "modified", additions: 2, deletions: 1 },
    { path: "src/new.js", status: "untracked", additions: 3, deletions: 0 },
  ],
};
const COMMITTED = {
  available: true, truncated: false, additions: 1, deletions: 0,
  files: [{ path: "c.txt", status: "added", additions: 1, deletions: 0 }],
};
const CLEAN = { available: true, truncated: false, additions: 0, deletions: 0, files: [] };
const LOG = [
  { sha: SHA, subject: "run abc123: add the toggle", date: Date.now() - 3600_000 },
  { sha: OLDER, subject: "first", date: Date.now() - 7200_000 },
];
const A_DIFF = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,3 +1,4 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "+four",
].join("\n");

let calls: string[];
/** Every PUT the tree route received — there must be none: the pane reads. */
let saves: unknown[];

function stubDevice(opts: { changes?: unknown; log?: unknown[]; tree?: unknown; noGit?: boolean; filesOutside?: boolean } = {}) {
  calls = [];
  saves = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    calls.push(url);
    const q = new URL(url, "http://box").searchParams;
    if (url === "/setup-api/coding-agent/tree" && init?.method === "PUT") {
      saves.push(JSON.parse(String(init.body)));
      return json({ error: "unexpected" }, 500);
    }
    if (url.startsWith("/setup-api/files?") && init?.method === "POST") {
      if (opts.filesOutside) return json({ error: "Invalid path" }, 400);
      return json({ absPath: "/srv/projects/site", relPath: "Projects/site" });
    }
    if (url.startsWith("/setup-api/coding-agent/tree?")) {
      const file = q.get("file");
      if (file === "src/app.js") return json({ file: { path: file, content: "console.log(1)\nconsole.log(2)\n", size: 30, truncated: false, binary: false } });
      if (file === "README.md") return json({ file: { path: file, content: "# hi\n", size: 5, truncated: false, binary: false } });
      if (file === "big.log") return json({ file: { path: file, content: "first part", size: 900_000, truncated: true, binary: false } });
      if (file === "logo.png") return json({ file: { path: file, content: "", size: 8, truncated: false, binary: true } });
      if (file !== null) return json({ error: "No such file in the project", kind: "not_found" }, 404);
      const p = q.get("path") ?? "";
      if (p === "") return json({ listing: opts.tree ?? ROOT_LISTING });
      if (p === "src") return json({ listing: SRC_LISTING });
      return json({ error: "No such folder in the project", kind: "not_found" }, 404);
    }
    if (url.startsWith("/setup-api/coding-agent/git?")) {
      const diff = q.get("diff");
      if (diff !== null) {
        if (diff === "a.txt") return json({ diff: { path: "a.txt", diff: A_DIFF, truncated: false, binary: false } });
        if (diff === "c.txt") return json({ diff: { path: "c.txt", diff: "@@ -0,0 +1 @@\n+new", truncated: false, binary: false } });
        return json({ error: "No diff for that file", kind: "not_found" }, 404);
      }
      if (q.has("changes")) {
        if (opts.noGit) return json({ changes: { available: false, files: [], additions: 0, deletions: 0, truncated: false }, log: [] });
        const ref = q.get("ref");
        return json({ changes: ref ? COMMITTED : (opts.changes ?? WORKING), log: opts.log ?? LOG });
      }
    }
    return json({ error: "unexpected" }, 404);
  }));
}

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the tabs", () => {
  it("opens on Activity when the host hands one — Activity, Files, Changes, then the Team tab last — and on Files otherwise", async () => {
    stubDevice();
    const { unmount } = render(
      <CodingProjectWorkspace query="projectId=site" live={false} activity={<div data-testid="activity-pane" />} activityLive team={<div data-testid="team-pane" />} />,
    );
    await screen.findByTestId("coding-agent-workspace");
    const tabs = screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-testid"));
    expect(tabs).toEqual(["coding-agent-workspace-runs", "coding-agent-workspace-files", "coding-agent-workspace-changes", "coding-agent-workspace-team"]);
    const activity = screen.getByTestId("coding-agent-workspace-runs");
    expect(activity).toHaveAttribute("aria-selected", "true");
    expect(activity).toHaveTextContent(t("codingAgent.activityTab"));
    expect(within(activity).getByTestId("coding-agent-workspace-runs-live")).toBeInTheDocument();
    expect(screen.getByTestId("activity-pane").closest("[role=tabpanel]")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("team-pane").closest("[role=tabpanel]")).toHaveAttribute("hidden");
    // No Setup tab, no Runs tab: notes and tools are folds on the page.
    expect(screen.queryByTestId("coding-agent-workspace-setup")).toBeNull();
    // Zero inputs on every tab.
    fireEvent.click(screen.getByTestId("coding-agent-workspace-files"));
    await screen.findByTestId("coding-agent-file-tree");
    fireEvent.click(screen.getByTestId("coding-agent-workspace-changes"));
    await screen.findByTestId("coding-agent-change-a.txt");
    expect(document.querySelectorAll("input, textarea, select")).toHaveLength(0);
    unmount();

    stubDevice();
    render(<CodingProjectWorkspace query="projectId=site" live={false} />);
    await screen.findByTestId("coding-agent-workspace");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByTestId("coding-agent-workspace-files")).toHaveAttribute("aria-selected", "true");
  });

  it("follows a tab the host asks for after mount — a team's row opening the Team tab", async () => {
    stubDevice();
    const { rerender } = render(<CodingProjectWorkspace query="projectId=site" live={false} activity={<div />} team={<div data-testid="team-pane" />} />);
    await screen.findByTestId("coding-agent-workspace");
    expect(screen.getByTestId("coding-agent-workspace-runs")).toHaveAttribute("aria-selected", "true");
    rerender(<CodingProjectWorkspace query="projectId=site" live={false} activity={<div />} team={<div data-testid="team-pane" />} initialTab="team" />);
    expect(screen.getByTestId("coding-agent-workspace-team")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("team-pane").closest("[role=tabpanel]")).not.toHaveAttribute("hidden");
  });
});

describe("the Files tab", () => {
  it("lists the project's root from the tree route, folders first, and opens a folder on tap", async () => {
    stubDevice();
    render(<CodingProjectWorkspace query="projectId=site" live={false} />);
    const tree = await screen.findByTestId("coding-agent-file-tree");
    await within(tree).findByTestId("coding-agent-tree-src");
    // Each row's button is titled with its path; the text also carries the
    // icon ligatures, which is why the title is what is read here.
    const names = within(tree).getAllByRole("treeitem").map((row) => row.getAttribute("title"));
    expect(names).toEqual(["src", "README.md", "logo.png"]);
    expect(calls).toContain("/setup-api/coding-agent/tree?projectId=site&path=");

    fireEvent.click(within(tree).getByTestId("coding-agent-tree-src"));
    await within(tree).findByTestId("coding-agent-tree-src/app.js");
    expect(calls).toContain("/setup-api/coding-agent/tree?projectId=site&path=src");
    // The row's button is the treeitem: its state travels with the focus.
    expect(within(tree).getByTestId("coding-agent-tree-src")).toHaveAttribute("role", "treeitem");
    expect(within(tree).getByTestId("coding-agent-tree-src")).toHaveAttribute("aria-expanded", "true");
    // The DOM is flat; the level says how deep the row sits.
    expect(within(tree).getByTestId("coding-agent-tree-src")).toHaveAttribute("aria-level", "1");
    expect(within(tree).getByTestId("coding-agent-tree-src/app.js")).toHaveAttribute("aria-level", "2");
  });

  it("opens a file READ-ONLY beside the tree — numbered and coloured by its name, no textarea, no Save — and says so for a binary one", async () => {
    stubDevice();
    render(<CodingProjectWorkspace query="projectId=site" live={false} />);
    const tree = await screen.findByTestId("coding-agent-file-tree");
    expect(screen.getByTestId("coding-agent-file-view").textContent).toContain(t("codingAgent.pickFile"));

    fireEvent.click(within(tree).getByTestId("coding-agent-tree-src"));
    fireEvent.click(await within(tree).findByTestId("coding-agent-tree-src/app.js"));
    const view = screen.getByTestId("coding-agent-file-view");
    await waitFor(() => expect(view.textContent).toContain("console.log(2)"));
    expect(view.textContent).toContain("src/app.js");
    // The shared editor in its read-only form: a numbered gutter and the text.
    const editor = within(view).getByTestId("coding-agent-file-editor");
    expect(editor).toHaveAttribute("data-language", "javascript");
    expect(editor.querySelectorAll(".cb-code-gutter-line").length).toBeGreaterThanOrEqual(2);
    expect(view.querySelector("textarea")).toBeNull();
    expect(within(view).queryByTestId("coding-agent-file-save")).toBeNull();
    expect(within(view).queryByTestId("coding-agent-file-editor-input")).toBeNull();

    fireEvent.click(within(tree).getByTestId("coding-agent-tree-logo.png"));
    await waitFor(() => expect(view.textContent).toContain(t("codingAgent.binaryFile")));
    expect(saves).toEqual([]);
  });

  it("shows one pane at a time on a phone: the tree gives way to the file, and the file's header leads back", async () => {
    stubDevice();
    render(<CodingProjectWorkspace query="projectId=site" live={false} />);
    const tree = await screen.findByTestId("coding-agent-file-tree");
    const files = screen.getByTestId("coding-agent-files");
    expect(files).toHaveAttribute("data-pane", "tree");
    // jsdom measures no container: the pane classes say which pane a phone
    // shows (`hidden` until `@3xl`, where both sit side by side).
    expect(screen.getByTestId("coding-agent-file-view").className).toContain("hidden @3xl:flex");
    expect(tree.className).not.toContain("hidden");

    fireEvent.click(within(tree).getByTestId("coding-agent-tree-README.md"));
    await waitFor(() => expect(files).toHaveAttribute("data-pane", "file"));
    expect(tree.className).toContain("hidden @3xl:block");
    expect(screen.getByTestId("coding-agent-file-view").className).not.toContain("hidden");
    const back = screen.getByTestId("coding-agent-file-back");
    expect(back).toHaveAttribute("aria-label", t("codingAgent.filesBack"));
    expect(back.className).toContain("@3xl:hidden");
    fireEvent.click(back);
    expect(files).toHaveAttribute("data-pane", "tree");
    expect(screen.getByTestId("coding-agent-file-view").textContent).toContain(t("codingAgent.pickFile"));
  });

  it("shows a cut file with its note, and never offers to save it", async () => {
    stubDevice({ tree: { ...ROOT_LISTING, entries: [...ROOT_LISTING.entries, { name: "big.log", type: "file", size: 900_000, modified: null }] } });
    render(<CodingProjectWorkspace query="projectId=site" live />);
    const tree = await screen.findByTestId("coding-agent-file-tree");
    fireEvent.click(within(tree).getByTestId("coding-agent-tree-big.log"));
    const view = screen.getByTestId("coding-agent-file-view");
    await waitFor(() => expect(view.textContent).toContain("first part"));
    expect(view.textContent).toContain(t("codingAgent.fileTruncated"));
    expect(view.querySelector("textarea")).toBeNull();
    expect(within(view).queryByTestId("coding-agent-file-save")).toBeNull();
  });

  it("names the folder as text in the Files header, and opens it in the Files app — a window of its own, at the path the Files route names", async () => {
    stubDevice();
    const seen: OpenAppDetail[] = [];
    const handler = (e: Event) => seen.push((e as CustomEvent<OpenAppDetail>).detail);
    window.addEventListener(OPEN_APP_EVENT, handler);
    try {
      render(<CodingProjectWorkspace query="directory=%2Fsrv%2Fprojects%2Fsite" live={false} directory="/srv/projects/site" filesDirectory="/srv/projects/site" />);
      await screen.findByTestId("coding-agent-file-tree");
      expect(screen.getByTestId("coding-agent-project-path")).toHaveTextContent("/srv/projects/site");
      // The path is text: no copy button, no input.
      expect(screen.getByTestId("coding-agent-project-path").tagName).toBe("SPAN");
      fireEvent.click(screen.getByTestId("coding-agent-open-in-files"));
      await waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]).toEqual({ appId: "files", forceNew: true, meta: { path: "Projects/site" } });
      const [, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.find(([u]) => u.startsWith("/setup-api/files?"))!;
      expect(JSON.parse(String(init.body))).toEqual({ action: "resolve", filePath: "/srv/projects/site" });
    } finally {
      window.removeEventListener(OPEN_APP_EVENT, handler);
    }
  });

  it("says so when the Files app cannot reach the folder, and offers no button without a folder the Files app can open", async () => {
    stubDevice({ filesOutside: true });
    const { unmount } = render(<CodingProjectWorkspace query="projectId=site" live={false} directory="/srv/elsewhere" filesDirectory="/srv/elsewhere" />);
    await screen.findByTestId("coding-agent-file-tree");
    fireEvent.click(screen.getByTestId("coding-agent-open-in-files"));
    expect(await screen.findByText(t("codingAgent.openInFilesFailed"))).toBeInTheDocument();
    unmount();
    stubDevice();
    render(<CodingProjectWorkspace query="projectId=site" live={false} directory="/srv/code-projects/site" />);
    await screen.findByTestId("coding-agent-file-tree");
    expect(screen.queryByTestId("coding-agent-open-in-files")).toBeNull();
    expect(screen.getByTestId("coding-agent-project-path")).toHaveTextContent("/srv/code-projects/site");
  });

  it("says when the folder is empty", async () => {
    stubDevice({ tree: { path: "", truncated: false, entries: [] } });
    render(<CodingProjectWorkspace query="directory=%2Fsrv%2Fprojects%2Fx" live={false} />);
    expect(await screen.findByText(t("codingAgent.emptyFolder"))).toBeInTheDocument();
    expect(calls[0]).toBe("/setup-api/coding-agent/tree?directory=%2Fsrv%2Fprojects%2Fx&path=");
  });
});

describe("the Changes tab", () => {
  it("reads nothing until it is opened, then lists what changed with counts and totals", async () => {
    stubDevice();
    render(<CodingProjectWorkspace query="projectId=site" live={false} />);
    await screen.findByTestId("coding-agent-file-tree");
    expect(calls.some((u) => u.includes("changes"))).toBe(false);

    fireEvent.click(screen.getByTestId("coding-agent-workspace-changes"));
    const list = screen.getByTestId("coding-agent-change-list");
    await within(list).findByTestId("coding-agent-change-a.txt");
    expect(calls).toContain("/setup-api/coding-agent/git?projectId=site&changes=1");
    expect(within(list).getByTestId("coding-agent-change-a.txt").textContent).toContain("+2");
    expect(within(list).getByTestId("coding-agent-change-a.txt").textContent).toContain("−1");
    expect(within(list).getByTestId("coding-agent-change-src/new.js").textContent).toContain("+3");
    // An untracked file reads as new, a modified one as modified.
    expect(within(list).getByLabelText(t("codingAgent.change.untracked"))).toBeInTheDocument();
    expect(within(list).getByLabelText(t("codingAgent.change.modified"))).toBeInTheDocument();
    const totals = screen.getByTestId("coding-agent-change-totals").textContent ?? "";
    expect(totals).toContain(t("codingAgent.filesChanged", { n: 2 }));
    expect(totals).toContain("+5");
    expect(totals).toContain("−1");
    // The working tree, named, with Older the one way on.
    expect(screen.getByTestId("coding-agent-change-label")).toHaveTextContent(t("codingAgent.uncommitted"));
    expect(screen.getByTestId("coding-agent-change-newer")).toBeDisabled();
    expect(screen.getByTestId("coding-agent-change-older")).toBeEnabled();
  });

  it("opens a file's diff, coloured line by line, with the file header folded away — one pane at a time on a phone", async () => {
    stubDevice();
    render(<CodingProjectWorkspace query="projectId=site" live={false} initialTab="changes" />);
    const changes = await screen.findByTestId("coding-agent-changes");
    expect(changes).toHaveAttribute("data-pane", "list");
    fireEvent.click(await screen.findByTestId("coding-agent-change-a.txt"));
    const diff = await screen.findByTestId("coding-agent-diff");
    expect(calls).toContain("/setup-api/coding-agent/git?projectId=site&diff=a.txt");
    const kinds = Array.from(diff.querySelectorAll("[data-diff-line]")).map((el) => `${el.getAttribute("data-diff-line")}:${el.textContent}`);
    expect(kinds).toEqual(["hunk:@@ -1,3 +1,4 @@", "ctx: one", "del:-two", "add:+TWO", "ctx: three", "add:+four"]);
    expect(diff.textContent).not.toContain("diff --git");
    expect(diff.textContent).not.toContain("index 1111111");
    expect(changes).toHaveAttribute("data-pane", "diff");
    expect(screen.getByTestId("coding-agent-change-list").className).toContain("hidden @3xl:block");
    fireEvent.click(screen.getByTestId("coding-agent-diff-back"));
    expect(changes).toHaveAttribute("data-pane", "list");
    expect(screen.queryByTestId("coding-agent-diff")).toBeNull();
  });

  it("steps from the working tree to one commit and back with Older / Newer — no picker", async () => {
    stubDevice();
    render(<CodingProjectWorkspace query="projectId=site" live={false} initialTab="changes" />);
    await screen.findByTestId("coding-agent-change-a.txt");
    expect(screen.queryByTestId("coding-agent-change-picker")).toBeNull();
    expect(document.querySelector("select")).toBeNull();

    fireEvent.click(screen.getByTestId("coding-agent-change-older"));
    await screen.findByTestId("coding-agent-change-c.txt");
    expect(calls).toContain(`/setup-api/coding-agent/git?projectId=site&changes=1&ref=${SHA}`);
    expect(screen.queryByTestId("coding-agent-change-a.txt")).toBeNull();
    // The label names the commit: its short sha and its subject.
    expect(screen.getByTestId("coding-agent-change-label")).toHaveTextContent(`${SHA.slice(0, 7)} · run abc123: add the toggle`);
    expect(screen.getByTestId("coding-agent-change-newer")).toBeEnabled();
    fireEvent.click(screen.getByTestId("coding-agent-change-c.txt"));
    await screen.findByTestId("coding-agent-diff");
    expect(calls).toContain(`/setup-api/coding-agent/git?projectId=site&diff=c.txt&ref=${SHA}`);

    // Older again: the second commit, and nothing older than the log.
    fireEvent.click(screen.getByTestId("coding-agent-change-older"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-change-label")).toHaveTextContent(`${OLDER.slice(0, 7)} · first`));
    expect(calls).toContain(`/setup-api/coding-agent/git?projectId=site&changes=1&ref=${OLDER}`);
    expect(screen.getByTestId("coding-agent-change-older")).toBeDisabled();
    // Newer twice: back through the first commit to the working tree.
    fireEvent.click(screen.getByTestId("coding-agent-change-newer"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-change-label")).toHaveTextContent(SHA.slice(0, 7)));
    fireEvent.click(screen.getByTestId("coding-agent-change-newer"));
    await screen.findByTestId("coding-agent-change-a.txt");
    expect(screen.getByTestId("coding-agent-change-label")).toHaveTextContent(t("codingAgent.uncommitted"));
  });

  it("opens on a commit when told which, the way a settled run's page asks", async () => {
    stubDevice();
    render(<CodingProjectWorkspace query="projectId=site" live={false} initialTab="changes" initialRef={SHA} />);
    await screen.findByTestId("coding-agent-change-c.txt");
    expect(screen.getByTestId("coding-agent-change-label")).toHaveTextContent(SHA.slice(0, 7));
    expect(calls.filter((u) => u.includes("changes=1"))).toEqual([`/setup-api/coding-agent/git?projectId=site&changes=1&ref=${SHA}`]);
  });

  it("steps to the newest commit by itself when nothing works and nothing is uncommitted — once", async () => {
    stubDevice({ changes: CLEAN });
    render(<CodingProjectWorkspace query="projectId=site" live={false} initialTab="changes" />);
    await screen.findByTestId("coding-agent-change-c.txt");
    expect(calls.filter((u) => u.includes("changes=1"))).toEqual([
      "/setup-api/coding-agent/git?projectId=site&changes=1",
      `/setup-api/coding-agent/git?projectId=site&changes=1&ref=${SHA}`,
    ]);
    // Newer leads back to the (clean) working tree, and stays there.
    fireEvent.click(screen.getByTestId("coding-agent-change-newer"));
    await screen.findByText(t("codingAgent.noChanges"));
    expect(calls.filter((u) => u.includes("changes=1"))).toHaveLength(3);
  });

  it("stays on the working tree while a run works, follows it, and stops when it is not", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stubDevice({ changes: CLEAN });
      const { rerender } = render(<CodingProjectWorkspace query="projectId=site" live initialTab="changes" />);
      await screen.findByText(t("codingAgent.noChanges"));
      expect(screen.getByTestId("coding-agent-change-label")).toHaveTextContent(t("codingAgent.uncommitted"));
      const before = calls.filter((u) => u.includes("changes=1")).length;
      await vi.advanceTimersByTimeAsync(5_100);
      expect(calls.filter((u) => u.includes("changes=1")).length).toBe(before + 1);
      rerender(<CodingProjectWorkspace query="projectId=site" live={false} initialTab="changes" />);
      const settled = calls.filter((u) => u.includes("changes=1")).length;
      await vi.advanceTimersByTimeAsync(11_000);
      expect(calls.filter((u) => u.includes("changes=1")).length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says in words when there is no git history, and when nothing changed", async () => {
    stubDevice({ noGit: true });
    const { unmount } = render(<CodingProjectWorkspace query="projectId=site" live={false} initialTab="changes" />);
    expect(await screen.findByText(t("codingAgent.noGitHistory"))).toBeInTheDocument();
    expect(screen.queryByTestId("coding-agent-change-steps")).toBeNull();
    unmount();

    stubDevice({ changes: CLEAN, log: [] });
    render(<CodingProjectWorkspace query="projectId=site" live={false} initialTab="changes" />);
    expect(await screen.findByText(t("codingAgent.noChanges"))).toBeInTheDocument();
    expect(screen.getByTestId("coding-agent-change-totals").textContent).toBe("");
  });
});

describe("DiffView", () => {
  it("renders agent-written text as characters, never as markup", () => {
    render(<DiffView text={"@@ -1 +1 @@\n-<b>old</b>\n+<img src=x onerror=alert(1)>"} />);
    const diff = screen.getByTestId("coding-agent-diff");
    expect(diff.querySelector("img")).toBeNull();
    expect(diff.querySelector("b")).toBeNull();
    expect(diff.textContent).toContain("+<img src=x onerror=alert(1)>");
  });
});
