/**
 * The Files app's Projects: the folders the owner pins so they show in the
 * desktop's own file manager (the sidebar, the Projects view, the desktop's
 * Projects icon) — and a folder downloaded as one ZIP.
 *
 * The box's answers are stubbed by URL; what is pinned here is what the app
 * SENDS and what it puts on screen for each answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import FilesApp from "@/components/FilesApp";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({
  useT: () => ({ locale: "en", localeResolved: true, setLocale: () => {}, t }),
}));

const ISO = "2026-09-01T10:00:00.000Z";
const dir = (name: string) => ({ name, type: "directory", size: null, modified: ISO });
const file = (name: string) => ({ name, type: "file", size: 5, modified: ISO });

const LISTINGS: Record<string, unknown[]> = {
  "": [dir("Projects"), dir("work"), file("notes.txt")],
  work: [dir("site"), file("todo.md")],
  ".openclaw/workspace/projects": [dir("architektur-review"), dir("website")],
  ".openclaw/workspace/projects/architektur-review": [file("SELBSTGUTACHTEN.md")],
};

const REVIEW = { path: ".openclaw/workspace/projects", name: "projects" };

interface Call { url: string; method: string; body: unknown }
let calls: Call[];
let folders: Array<{ path: string; name: string; missing?: boolean }>;
let suggestions: Array<{ path: string; name: string }>;
/** Overrides for a pin (POST) or a ZIP check, when a test needs a refusal. */
let postAnswer: { status: number; body: Record<string, unknown> } | null;
let zipCheck: { status: number; body: Record<string, unknown> };

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status, statusText: status === 200 ? "OK" : "Error", json: async () => body,
});

function stubFetch() {
  calls = [];
  postAnswer = null;
  zipCheck = { status: 200, body: { name: "x.zip", entries: 3, files: 2, bytes: 2048, tooMany: false, limit: 100000 } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith("/setup-api/project-folders")) {
      if (method === "GET") return json(200, { folders, suggestions, max: 50 });
      if (method === "POST") {
        if (postAnswer) return json(postAnswer.status, postAnswer.body);
        const path = (JSON.parse(String(init!.body)) as { path: string }).path.replace(/^~\//, "");
        const folder = { path, name: path.split("/").pop()! };
        if (!folders.some((f) => f.path === path)) folders = [...folders, folder];
        suggestions = suggestions.filter((s) => s.path !== path);
        return json(200, { ok: true, added: true, folder, folders });
      }
      const path = new URL(url, "http://x").searchParams.get("path");
      folders = folders.filter((f) => f.path !== path);
      return json(200, { ok: true, removed: true, folders });
    }
    if (url.includes("zip=1&check=1")) return json(zipCheck.status, zipCheck.body);
    const d = new URL(url, "http://x").searchParams.get("dir") ?? "";
    return json(200, { files: LISTINGS[d] ?? [], availableSpace: 1e9 });
  }));
}

const listed = (d: string) => calls.some((c) => c.method === "GET" && c.url === `/setup-api/files?dir=${encodeURIComponent(d)}`);
/** A sidebar row's name — its icon is a ligature, which is text too. */
const rowName = (el: HTMLElement) => el.querySelector("span.truncate")?.textContent;
const crumbs = () => within(screen.getByTestId("files-breadcrumbs")).getAllByRole("button").map((b) => b.textContent);

let anchorClicks: Array<{ href: string; download: string }>;

beforeEach(() => {
  window.localStorage.clear();
  folders = [REVIEW];
  suggestions = [];
  stubFetch();
  anchorClicks = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    anchorClicks.push({ href: this.getAttribute("href") ?? "", download: this.download });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FilesApp — pinned project folders in the sidebar", () => {
  it("lists them under Projects, and one click opens the folder with a trail that starts at the project", async () => {
    render(<FilesApp />);
    const row = await screen.findByTestId("files-sidebar-project");
    expect(rowName(row)).toBe("projects");
    expect(row.getAttribute("title")).toBe("~/.openclaw/workspace/projects");
    fireEvent.click(row);
    await screen.findByText("architektur-review");
    expect(listed(".openclaw/workspace/projects")).toBe(true);
    // Not Home › .openclaw › workspace › projects.
    expect(crumbs()).toEqual([t("files.projects"), "projects"]);
    fireEvent.doubleClick(screen.getByText("architektur-review"));
    await screen.findByText("SELBSTGUTACHTEN.md");
    expect(crumbs()).toEqual([t("files.projects"), "projects", "architektur-review"]);
  });

  it("walks Up from a project's own folder to the Projects view, not into the hidden folders above it", async () => {
    render(<FilesApp initialPath=".openclaw/workspace/projects/architektur-review" />);
    await screen.findByText("SELBSTGUTACHTEN.md");
    await waitFor(() => expect(crumbs()[0]).toBe(t("files.projects")));
    const up = screen.getByTitle(t("files.goUp"));
    fireEvent.click(up);
    await screen.findByText("website");
    fireEvent.click(up);
    expect(await screen.findByTestId("files-projects")).toBeTruthy();
    expect(listed(".openclaw/workspace")).toBe(false);
  });

  it("keeps the Home trail for a folder that is in no project", async () => {
    render(<FilesApp initialPath="work" />);
    await screen.findByText("todo.md");
    await screen.findByTestId("files-sidebar-project");
    expect(crumbs()).toEqual([t("files.home"), "work"]);
  });

  it("offers the Projects view from the sidebar when nothing is pinned yet", async () => {
    folders = [];
    render(<FilesApp />);
    fireEvent.click(await screen.findByText(t("files.projectsAdd"), { selector: "span" }));
    expect(await screen.findByTestId("files-projects-empty")).toBeTruthy();
  });
});

describe("FilesApp — pinning from a folder", () => {
  it("pins the folder on screen from the toolbar, and the same button unpins it", async () => {
    folders = [];
    render(<FilesApp initialPath="work" />);
    await screen.findByText("todo.md");
    const pin = screen.getByTestId("files-pin-toggle");
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pin);
    await waitFor(() => expect(screen.getByTestId("files-pin-toggle").getAttribute("aria-pressed")).toBe("true"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ path: "work" });
    expect(screen.getByTestId("files-status").textContent).toContain(t("files.pinned", { name: "work" }));
    expect(rowName(await screen.findByTestId("files-sidebar-project"))).toBe("work");

    fireEvent.click(screen.getByTestId("files-pin-toggle"));
    await waitFor(() => expect(screen.queryByTestId("files-sidebar-project")).toBeNull());
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/setup-api/project-folders?path=work");
  });

  it("has no pin on the home folder itself", async () => {
    render(<FilesApp />);
    await screen.findByText("notes.txt");
    expect(screen.queryByTestId("files-pin-toggle")).toBeNull();
  });

  it("pins and unpins a folder from its context menu", async () => {
    folders = [];
    render(<FilesApp />);
    fireEvent.contextMenu(await screen.findByText("work"), { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByText(t("files.pinFolder")));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ path: "work" });
    await screen.findByTestId("files-sidebar-project");
    fireEvent.contextMenu(screen.getByText("work", { selector: "span.text-xs" }), { clientX: 10, clientY: 10 });
    expect(await screen.findByText(t("files.unpinFolder"))).toBeTruthy();
  });
});

describe("FilesApp — the Projects view", () => {
  it("opens on the Projects view without listing any folder, and opens a project from it", async () => {
    render(<FilesApp initialPlace="projects" />);
    const list = await screen.findByTestId("files-projects-list");
    expect(calls.some((c) => c.url.startsWith("/setup-api/files?dir="))).toBe(false);
    expect(crumbs()).toEqual([t("files.projects")]);
    expect(screen.getByTestId("files-status").textContent).toBe(t("files.projectsCount", { count: 1 }));
    fireEvent.click(within(list).getByTitle("~/.openclaw/workspace/projects"));
    await screen.findByText("architektur-review");
    expect(screen.queryByTestId("files-projects")).toBeNull();
  });

  it("pins a suggested folder with one click", async () => {
    folders = [];
    suggestions = [REVIEW];
    render(<FilesApp initialPlace="projects" />);
    const box = await screen.findByTestId("files-projects-suggestions");
    fireEvent.click(within(box).getByRole("button", { name: `${t("files.pinFolder")}: projects` }));
    await screen.findByTestId("files-projects-list");
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ path: ".openclaw/workspace/projects" });
    expect(screen.queryByTestId("files-projects-suggestions")).toBeNull();
    expect(rowName(await screen.findByTestId("files-sidebar-project"))).toBe("projects");
  });

  it("pins a typed path, and words a refusal under the box instead of the route's English", async () => {
    folders = [];
    render(<FilesApp initialPlace="projects" />);
    const form = await screen.findByTestId("files-projects-add");
    const input = within(form).getByRole("textbox");
    postAnswer = { status: 403, body: { error: "That folder holds the box's private data", code: "protected" } };
    fireEvent.change(input, { target: { value: "~/.ssh" } });
    fireEvent.submit(form);
    expect((await screen.findByTestId("files-projects-add-error")).textContent).toBe(t("files.pinProtected"));
    expect((input as HTMLInputElement).value).toBe("~/.ssh");

    postAnswer = null;
    fireEvent.change(input, { target: { value: "~/work" } });
    expect(screen.queryByTestId("files-projects-add-error")).toBeNull();
    fireEvent.submit(form);
    await screen.findByTestId("files-projects-list");
    expect(calls.filter((c) => c.method === "POST").at(-1)?.body).toEqual({ path: "~/work" });
    expect((input as HTMLInputElement).value).toBe("");
  });

  it.each([
    ["outside_root", 400, "files.pinOutsideRoot"],
    ["not_found", 404, "files.pinNotFound"],
    ["not_directory", 400, "files.pinNotDirectory"],
    ["is_root", 400, "files.pinIsRoot"],
  ])("words the %s refusal", async (code, status, key) => {
    folders = [];
    render(<FilesApp initialPlace="projects" />);
    const form = await screen.findByTestId("files-projects-add");
    postAnswer = { status, body: { error: "route text", code } };
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "x" } });
    fireEvent.submit(form);
    expect((await screen.findByTestId("files-projects-add-error")).textContent).toBe(t(key));
  });

  it("shows a folder that has gone as missing, with Remove as its only action", async () => {
    folders = [{ path: "old-site", name: "old-site", missing: true }];
    render(<FilesApp initialPlace="projects" />);
    const row = await screen.findByTestId("files-project-row");
    expect(row.textContent).toContain(t("files.projectMissing"));
    expect(within(row).queryByRole("button", { name: t("files.downloadZip") })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: t("files.unpinFolder") }));
    await screen.findByTestId("files-projects-empty");
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/setup-api/project-folders?path=old-site");
  });

  it("says so when the list cannot be read, and tries again on Retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(500, { error: "boom" })));
    render(<FilesApp initialPlace="projects" />);
    expect(await screen.findByTestId("files-projects-error")).toBeTruthy();
    stubFetch();
    fireEvent.click(screen.getByText(t("files.retry")));
    expect(await screen.findByTestId("files-projects-list")).toBeTruthy();
  });
});

describe("FilesApp — a folder downloaded as one ZIP", () => {
  it("asks the box first, then downloads <folder>.zip and says how big it is", async () => {
    render(<FilesApp initialPlace="projects" />);
    const row = await screen.findByTestId("files-project-row");
    fireEvent.click(within(row).getByRole("button", { name: t("files.downloadZip") }));
    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(calls.some((c) => c.url === "/setup-api/files/.openclaw/workspace/projects?zip=1&check=1")).toBe(true);
    expect(anchorClicks[0]).toEqual({ href: "/setup-api/files/.openclaw/workspace/projects?zip=1", download: "projects.zip" });
    expect(screen.getByTestId("files-status").textContent).toBe(
      t("files.zipStarted", { name: "projects.zip", count: 2, size: "2.0 KB" }),
    );
  });

  it("offers Download as ZIP on a folder's context menu, with the name encoded", async () => {
    render(<FilesApp />);
    fireEvent.contextMenu(await screen.findByText("Projects", { selector: "span.text-xs" }), { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByText(t("files.downloadZip")));
    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(anchorClicks[0]).toEqual({ href: "/setup-api/files/Projects?zip=1", download: "Projects.zip" });
  });

  it("does not start a download the box says is too big, and tells the owner why", async () => {
    render(<FilesApp initialPlace="projects" />);
    const row = await screen.findByTestId("files-project-row");
    zipCheck = { status: 413, body: { code: "too_many_entries", error: "too many", tooMany: true, limit: 100000 } };
    fireEvent.click(within(row).getByRole("button", { name: t("files.downloadZip") }));
    await waitFor(() => expect(screen.getByTestId("files-status").textContent).toBe(
      t("files.zipTooMany", { max: (100000).toLocaleString() }),
    ));
    expect(anchorClicks).toHaveLength(0);
  });

  it("still downloads a FILE as itself", async () => {
    render(<FilesApp />);
    fireEvent.contextMenu(await screen.findByText("notes.txt"), { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByText(t("files.download")));
    expect(anchorClicks).toEqual([{ href: "/setup-api/files/notes.txt", download: "notes.txt" }]);
    expect(calls.some((c) => c.url.includes("zip=1"))).toBe(false);
  });
});
