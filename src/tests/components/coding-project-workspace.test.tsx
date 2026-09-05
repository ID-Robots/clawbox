/**
 * The project page's workspace (src/components/CodingProjectWorkspace.tsx):
 * the folder as a tree read through the tree route, one file read-only
 * beside it, and what changed — the working tree or one commit — with a
 * unified diff per file. Against a stubbed device, with the real English
 * strings so a missing key fails here rather than on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingProjectWorkspace, { DiffView } from "@/components/CodingProjectWorkspace";

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

function stubDevice(opts: { changes?: unknown; log?: unknown[]; tree?: unknown; noGit?: boolean } = {}) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = input.toString();
    calls.push(url);
    const q = new URL(url, "http://box").searchParams;
    if (url.startsWith("/setup-api/coding-agent/tree?")) {
      const file = q.get("file");
      if (file === "src/app.js") return json({ file: { path: file, content: "console.log(1)\nconsole.log(2)\n", size: 30, truncated: false, binary: false } });
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

describe("the Files tab", () => {
  it("lists the project's root from the tree route, folders first, and opens a folder on tap", async () => {
    stubDevice();
    render(<CodingProjectWorkspace query="projectId=site" live={false} />);
    const tree = await screen.findByTestId("coding-agent-file-tree");
    await within(tree).findByTestId("coding-agent-tree-src");
    // Each row's button is titled with its path; the text also carries the
    // icon ligatures, which is why the title is what is read here.
    const names = within(tree).getAllByRole("treeitem").map((li) => li.querySelector("button")?.getAttribute("title"));
    expect(names).toEqual(["src", "README.md", "logo.png"]);
    expect(calls).toContain("/setup-api/coding-agent/tree?projectId=site&path=");

    fireEvent.click(within(tree).getByTestId("coding-agent-tree-src"));
    await within(tree).findByTestId("coding-agent-tree-src/app.js");
    expect(calls).toContain("/setup-api/coding-agent/tree?projectId=site&path=src");
    expect(within(tree).getByTestId("coding-agent-tree-src").closest("[role=treeitem]")).toHaveAttribute("aria-expanded", "true");
  });

  it("opens a file read-only beside the tree, numbered, and says so for a binary one", async () => {
    stubDevice();
    render(<CodingProjectWorkspace query="projectId=site" live={false} />);
    const tree = await screen.findByTestId("coding-agent-file-tree");
    expect(screen.getByTestId("coding-agent-file-view").textContent).toContain(t("codingAgent.pickFile"));

    fireEvent.click(within(tree).getByTestId("coding-agent-tree-src"));
    fireEvent.click(await within(tree).findByTestId("coding-agent-tree-src/app.js"));
    const view = screen.getByTestId("coding-agent-file-view");
    await waitFor(() => expect(view.textContent).toContain("console.log(2)"));
    expect(view.textContent).toContain("src/app.js");
    // Line numbers, and no editor: the text is in a <pre>, not a textarea.
    expect(view.querySelector("pre")).not.toBeNull();
    expect(view.querySelector("textarea")).toBeNull();
    expect(view.textContent).toMatch(/1\s*console\.log\(1\)/);

    fireEvent.click(within(tree).getByTestId("coding-agent-tree-logo.png"));
    await waitFor(() => expect(view.textContent).toContain(t("codingAgent.binaryFile")));
  });

  it("says when the folder is empty", async () => {
    stubDevice({ tree: { path: "", truncated: false, entries: [] } });
    render(<CodingProjectWorkspace query="directory=%2Fhome%2Fclawbox%2FProjects%2Fx" live={false} />);
    expect(await screen.findByText(t("codingAgent.emptyFolder"))).toBeInTheDocument();
    expect(calls[0]).toBe("/setup-api/coding-agent/tree?directory=%2Fhome%2Fclawbox%2FProjects%2Fx&path=");
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
  });

  it("opens a file's diff, coloured line by line, with the file header folded away", async () => {
    stubDevice();
    render(<CodingProjectWorkspace query="projectId=site" live={false} initialTab="changes" />);
    fireEvent.click(await screen.findByTestId("coding-agent-change-a.txt"));
    const diff = await screen.findByTestId("coding-agent-diff");
    expect(calls).toContain("/setup-api/coding-agent/git?projectId=site&diff=a.txt");
    const kinds = Array.from(diff.querySelectorAll("[data-diff-line]")).map((el) => `${el.getAttribute("data-diff-line")}:${el.textContent}`);
    expect(kinds).toEqual(["hunk:@@ -1,3 +1,4 @@", "ctx: one", "del:-two", "add:+TWO", "ctx: three", "add:+four"]);
    expect(diff.textContent).not.toContain("diff --git");
    expect(diff.textContent).not.toContain("index 1111111");
  });

  it("switches from the working tree to one commit through the picker", async () => {
    stubDevice();
    render(<CodingProjectWorkspace query="projectId=site" live={false} initialTab="changes" />);
    await screen.findByTestId("coding-agent-change-a.txt");
    const picker = screen.getByTestId("coding-agent-change-picker") as HTMLSelectElement;
    const options = Array.from(picker.options).map((o) => o.textContent ?? "");
    expect(options[0]).toBe(t("codingAgent.uncommitted"));
    expect(options[1]).toContain("run abc123: add the toggle");

    fireEvent.change(picker, { target: { value: SHA } });
    await screen.findByTestId("coding-agent-change-c.txt");
    expect(calls).toContain(`/setup-api/coding-agent/git?projectId=site&changes=1&ref=${SHA}`);
    expect(screen.queryByTestId("coding-agent-change-a.txt")).toBeNull();
    fireEvent.click(screen.getByTestId("coding-agent-change-c.txt"));
    await screen.findByTestId("coding-agent-diff");
    expect(calls).toContain(`/setup-api/coding-agent/git?projectId=site&diff=c.txt&ref=${SHA}`);
  });

  it("opens on a commit when told which, the way a settled run's page asks", async () => {
    stubDevice();
    render(<CodingProjectWorkspace query="projectId=site" live={false} initialTab="changes" initialRef={SHA} />);
    await screen.findByTestId("coding-agent-change-c.txt");
    expect((screen.getByTestId("coding-agent-change-picker") as HTMLSelectElement).value).toBe(SHA);
  });

  it("follows a run in flight, and stops when it is not", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stubDevice();
      const { rerender } = render(<CodingProjectWorkspace query="projectId=site" live initialTab="changes" />);
      await screen.findByTestId("coding-agent-change-a.txt");
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
    unmount();

    stubDevice({ changes: { available: true, truncated: false, additions: 0, deletions: 0, files: [] } });
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
