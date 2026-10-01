/**
 * The Files app's GitHub backup, as the owner sees it (TASK-1358): the panel's
 * four faces (not connected, first backup, backed up with history, a folder
 * with its own remote), the help, the suggestion card and who sees it.
 * The box's answers are stubbed by URL; what is pinned is what the panel SENDS
 * and the words it puts on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import { ProjectBackupPanel } from "@/components/ProjectBackup";
import FilesApp from "@/components/FilesApp";
import { _resetSessionUserForTest } from "@/lib/use-session-user";
import type { FolderBackupStatus } from "@/lib/project-backup-shared";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({
  useT: () => ({ locale: "en", localeResolved: true, setLocale: () => {}, t }),
}));

const FOLDER = { path: "projects/site", name: "site" };
const HOUR = 3_600_000;

interface Call { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[];
type Answer = { status: number; body: unknown };
let routes: Array<{ match: (c: Call) => boolean; answer: (c: Call) => Answer }>;

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status, statusText: "", json: async () => body,
});

function stubFetch() {
  calls = [];
  routes = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    for (const r of [...routes].reverse()) {
      if (r.match(call)) {
        const a = r.answer(call);
        return json(a.status, a.body);
      }
    }
    return json(404, { error: "not stubbed" });
  }));
}
const on = (match: (c: Call) => boolean, answer: Answer | ((c: Call) => Answer)) =>
  routes.push({ match, answer: typeof answer === "function" ? answer : () => answer });
const isStatusRead = (c: Call) => c.method === "GET" && c.url.startsWith("/setup-api/project-backup?path=") && !c.url.includes("stage=1");
const posted = (action: string) => calls.filter((c) => c.method === "POST" && c.body?.action === action);

function status(over: Partial<FolderBackupStatus>): FolderBackupStatus {
  return {
    folder: FOLDER,
    github: { installed: true, connected: true, login: "demo-owner" },
    state: "not_set_up",
    lastBackupAt: null,
    auto: false,
    lastAutoError: null,
    history: [],
    lastLeftOut: [],
    pending: null,
    running: null,
    ...over,
  };
}

/** The words on the main path — everything but the Advanced disclosure and the help. */
const mainText = (panel: HTMLElement) => {
  const clone = panel.cloneNode(true) as HTMLElement;
  clone.querySelector("[data-testid='project-backup-advanced']")?.remove();
  return clone.textContent ?? "";
};
const JARGON = /\b(commit|push|remote|repository)\b/i;

beforeEach(() => {
  stubFetch();
  _resetSessionUserForTest();
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the backup panel — GitHub not connected", () => {
  it("says what happens in one plain sentence, connects through the Coding Agent's sign-in, then backs up by itself", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let connected = false;
    on(isStatusRead, () => ({
      status: 200,
      body: posted("first_backup").length
        ? status({ state: "backed_up", repo: { fullName: "demo-owner/site", webUrl: "https://github.com/demo-owner/site", branch: "main" }, lastBackupAt: Date.now(), history: [{ at: Date.now(), files: 3, commit: "abc1234" }], pending: { files: 0, leftOut: [] } })
        : connected
          ? status({ suggestedName: "site" })
          : status({ github: { installed: true, connected: false, login: null } }),
    }));
    on((c) => c.url === "/setup-api/coding-agent/github-login" && c.body?.action === "start", { status: 200, body: { userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 } });
    on((c) => c.url === "/setup-api/coding-agent/github-login" && c.body?.action === "poll", () => {
      connected = true;
      return { status: 200, body: { status: "connected", login: "demo-owner" } };
    });
    on((c) => c.body?.action === "first_backup", { status: 200, body: { ok: true, nothingChanged: false, files: 3, commit: "abc1234", leftOut: [], repo: "demo-owner/site" } });

    render(<ProjectBackupPanel folder={FOLDER} onClose={() => {}} />);
    const panel = await screen.findByTestId("project-backup-panel");
    expect(await screen.findByTestId("project-backup-intro")).toHaveTextContent(
      "A private copy of this folder is kept on GitHub. Only you can see it. You can get any earlier version back.",
    );
    expect(panel).toHaveTextContent(t("files.backup.notConnected"));
    expect(mainText(panel)).not.toMatch(JARGON);

    fireEvent.click(screen.getByTestId("project-backup-connect"));
    expect(await screen.findByText("ABCD-1234")).toBeTruthy();
    expect(panel).toHaveTextContent(t("files.backup.deviceIntro"));

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(posted("first_backup")).toHaveLength(1));
    // It continued on its own, with the name the box suggested.
    expect(posted("first_backup")[0].body).toEqual({ action: "first_backup", path: "projects/site", name: "site" });
    expect(await screen.findByText(t("files.backup.doneFirst", { name: "site" }))).toBeTruthy();
    // Daily backup is offered right after the first one, and is off until said yes.
    expect(screen.getByTestId("project-backup-auto-offer")).toBeTruthy();
  });

  it("links a 'What is GitHub?' help with the sign-up link and three steps", async () => {
    on(isStatusRead, { status: 200, body: status({ github: { installed: true, connected: false, login: null } }) });
    render(<ProjectBackupPanel folder={FOLDER} onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("project-backup-help-link"));
    const help = await screen.findByTestId("project-backup-help");
    for (const key of ["files.backup.help1", "files.backup.help2", "files.backup.help3", "files.backup.help4", "files.backup.help5", "files.backup.helpStep1", "files.backup.helpStep2", "files.backup.helpStep3"]) {
      expect(help).toHaveTextContent(t(key));
    }
    const signup = within(help).getByTestId("project-backup-signup");
    expect(signup.getAttribute("href")).toBe("https://github.com/signup");
    expect(signup.getAttribute("target")).toBe("_blank");
    expect(signup.getAttribute("rel")).toContain("noopener");
    fireEvent.click(within(help).getByText(t("files.backup.helpClose")));
    expect(screen.queryByTestId("project-backup-help")).toBeNull();
    // Closing the help leaves the panel open.
    expect(screen.getByTestId("project-backup-panel")).toBeTruthy();
  });
});

describe("the backup panel — the first backup", () => {
  it("names the copy, asks before using the next free name on a clash, shows progress, and offers the daily backup", async () => {
    // A fetch of its own: the backup's answer is held back so the progress
    // line can be read while it runs.
    let resolveBackup!: (a: Answer) => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null };
      calls.push(call);
      if (call.body?.action === "first_backup") {
        const a = await new Promise<Answer>((r) => { resolveBackup = r; });
        return json(a.status, a.body);
      }
      if (call.url.includes("stage=1")) return json(200, { running: "uploading" });
      if (call.body?.action === "auto") return json(200, { ok: true, auto: true });
      if (isStatusRead(call)) {
        return json(200, posted("first_backup").length
          ? status({ state: "backed_up", repo: { fullName: "demo-owner/site-2", webUrl: "https://github.com/demo-owner/site-2", branch: "main" }, lastBackupAt: Date.now(), history: [{ at: Date.now(), files: 3, commit: "abc1234" }], pending: { files: 0, leftOut: [] } })
          : status({ suggestedName: "site-2", takenName: "site" }));
      }
      return json(404, {});
    }));

    render(<ProjectBackupPanel folder={FOLDER} onClose={() => {}} />);
    expect(await screen.findByTestId("project-backup-name-line")).toHaveTextContent(
      "You already have something called “site” on GitHub, so this one will be called “site-2”.",
    );
    expect(mainText(screen.getByTestId("project-backup-panel"))).not.toMatch(JARGON);
    fireEvent.click(screen.getByTestId("project-backup-first"));
    expect(await screen.findByTestId("project-backup-progress")).toHaveTextContent(t("files.backup.stepPreparing"));
    await waitFor(() => expect(screen.getByTestId("project-backup-progress")).toHaveTextContent(t("files.backup.stepUploading")), { timeout: 3_000 });
    expect(posted("first_backup")[0].body).toEqual({ action: "first_backup", path: "projects/site", name: "site-2" });

    await act(async () => { resolveBackup({ status: 200, body: { ok: true, nothingChanged: false, files: 3, commit: "abc1234", leftOut: [{ path: ".env", reason: "secret_name" }, { path: "key.pem", reason: "secret_name" }], repo: "demo-owner/site-2" } }); });
    expect(await screen.findByText(t("files.backup.doneFirst", { name: "site" }))).toBeTruthy();
    expect(screen.getByTestId("project-backup-progress")).toHaveTextContent(t("files.backup.stepDone"));
    // "We left out 2 files that look like passwords or keys", and a way to see which.
    expect(screen.getByText("We left out 2 files that look like passwords or keys.")).toBeTruthy();
    fireEvent.click(screen.getAllByTestId("project-backup-left-out-toggle")[0]);
    expect(screen.getByTestId("project-backup-left-out-list")).toHaveTextContent(".env");

    fireEvent.click(await screen.findByTestId("project-backup-auto-offer-yes"));
    await waitFor(() => expect(posted("auto")).toHaveLength(1));
    expect(posted("auto")[0].body).toEqual({ action: "auto", path: "projects/site", enabled: true });
  });

  it("a clash found only at the last moment shows the next free name and waits for the owner", async () => {
    on(isStatusRead, { status: 200, body: status({ suggestedName: "site" }) });
    on((c) => c.body?.action === "first_backup", { status: 409, body: { code: "name_taken", takenName: "site", suggestedName: "site-2" } });
    render(<ProjectBackupPanel folder={FOLDER} onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("project-backup-first"));
    expect(await screen.findByTestId("project-backup-notice")).toHaveTextContent("so this one will be called “site-2”");
    expect(posted("first_backup")).toHaveLength(1);
  });
});

describe("the backup panel — backed up", () => {
  it("shows the last backup, what changed since, Open on GitHub, History, the daily switch and Disconnect", async () => {
    const now = Date.now();
    on(isStatusRead, {
      status: 200,
      body: status({
        state: "backed_up",
        repo: { fullName: "demo-owner/site", webUrl: "https://github.com/demo-owner/site", branch: "main" },
        lastBackupAt: now - 2 * HOUR,
        pending: { files: 3, leftOut: [] },
        history: [
          { at: now - 2 * HOUR, files: 3, commit: "abc1234" },
          { at: now - 30 * HOUR, files: 1, commit: "def5678" },
        ],
        lastLeftOut: [{ path: ".env", reason: "secret_name" }, { path: "model.gguf", reason: "too_large" }],
      }),
    });
    on((c) => c.body?.action === "disconnect", { status: 200, body: { ok: true, removedRemote: true } });
    render(<ProjectBackupPanel folder={FOLDER} onClose={() => {}} />);
    expect(await screen.findByTestId("project-backup-status-line")).toHaveTextContent("Last backup: 2 hours ago · 3 files changed since");
    expect(screen.getByTestId("project-backup-open").getAttribute("href")).toBe("https://github.com/demo-owner/site");
    const history = screen.getByTestId("project-backup-history");
    expect(within(history).getAllByRole("listitem")).toHaveLength(2);
    expect(history).toHaveTextContent("3 files changed");
    expect(history).toHaveTextContent("1 file changed");
    expect(screen.getByTestId("project-backup-auto").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("We left out 1 file that looks like a password or key.")).toBeTruthy();
    expect(screen.getByText("We left out 1 file that is too big for GitHub (over 50 MB).")).toBeTruthy();
    expect(mainText(screen.getByTestId("project-backup-panel"))).not.toMatch(JARGON);

    // Technical words live behind Advanced, each with its plain meaning.
    fireEvent.click(screen.getByTestId("project-backup-advanced-toggle"));
    expect(screen.getByTestId("project-backup-advanced")).toHaveTextContent("Repository: demo-owner/site · branch: main");

    fireEvent.click(screen.getByTestId("project-backup-disconnect"));
    expect(screen.getByTestId("project-backup-disconnect-confirm")).toHaveTextContent("The copy on GitHub stays where it is");
    fireEvent.click(screen.getByText(t("files.backup.disconnectYes")));
    await waitFor(() => expect(posted("disconnect")).toHaveLength(1));
    expect(await screen.findByText(t("files.backup.disconnected"))).toBeTruthy();
  });

  it("says why the last daily backup did not run", async () => {
    on(isStatusRead, { status: 200, body: status({ state: "backed_up", auto: true, lastBackupAt: Date.now() - HOUR, repo: { fullName: "demo-owner/site", webUrl: "https://github.com/demo-owner/site", branch: "main" }, lastAutoError: { at: Date.now(), code: "gh_unreachable" } }) });
    render(<ProjectBackupPanel folder={FOLDER} onClose={() => {}} />);
    expect(await screen.findByTestId("project-backup-auto-error")).toHaveTextContent(`The last daily backup didn't work: ${t("files.backup.errUnreachable")}`);
    expect(screen.getByTestId("project-backup-auto").getAttribute("aria-checked")).toBe("true");
  });
});

describe("the backup panel — a folder that already uses Git", () => {
  it("names its own online copy, offers Back up now only, and explains a rejected push in plain words", async () => {
    on(isStatusRead, { status: 200, body: status({ state: "existing_git", remote: { label: "github.com/acme/site", webUrl: "https://github.com/acme/site", branch: "main" } }) });
    on((c) => c.body?.action === "backup_now", { status: 409, body: { code: "remote_ahead", detail: "! [rejected] main -> main (fetch first)" } });
    render(<ProjectBackupPanel folder={FOLDER} onClose={() => {}} />);
    expect(await screen.findByTestId("project-backup-existing")).toHaveTextContent("This folder already uses Git");
    const panel = screen.getByTestId("project-backup-panel");
    expect(panel).toHaveTextContent("an online copy at github.com/acme/site");
    expect(screen.queryByTestId("project-backup-auto")).toBeNull();
    expect(screen.queryByTestId("project-backup-disconnect")).toBeNull();
    expect(mainText(panel)).not.toMatch(JARGON);

    fireEvent.click(screen.getByTestId("project-backup-now"));
    expect(await screen.findByTestId("project-backup-notice")).toHaveTextContent(
      "The online copy has changes this folder doesn't have yet, maybe from another computer. Nothing was overwritten and nothing was lost.",
    );
    expect(posted("backup_now")[0].body).toEqual({ action: "backup_now", path: "projects/site" });
    // What git said is kept for Advanced, not shown on the main path.
    expect(mainText(panel)).not.toContain("fetch first");
    fireEvent.click(screen.getByTestId("project-backup-advanced-toggle"));
    expect(screen.getByTestId("project-backup-advanced")).toHaveTextContent("fetch first");
  });

  it("refuses a folder inside a bigger project with the reason, and nothing to click", async () => {
    on(isStatusRead, { status: 200, body: status({ state: "refused", refusal: { code: "inside_repo", parent: "big" } }) });
    render(<ProjectBackupPanel folder={FOLDER} onClose={() => {}} />);
    expect(await screen.findByTestId("project-backup-refused")).toHaveTextContent("This folder is part of a bigger Git project (“big”)");
    expect(screen.queryByTestId("project-backup-now")).toBeNull();
    expect(screen.queryByTestId("project-backup-first")).toBeNull();
  });

  it("says the box's own data cannot be backed up when the box refuses the folder", async () => {
    on(isStatusRead, { status: 403, body: { code: "protected", error: "no" } });
    render(<ProjectBackupPanel folder={FOLDER} onClose={() => {}} />);
    expect(await screen.findByTestId("project-backup-load-error")).toHaveTextContent(t("files.backup.errProtected"));
  });
});

describe("the Projects view", () => {
  const LISTING = { files: [], availableSpace: 1e9 };
  function box(opts: { isOwner: boolean; connected: boolean; dismissedAt?: number | null }) {
    on(() => true, { status: 200, body: LISTING });
    on((c) => c.url === "/setup-api/users/me", { status: 200, body: { username: opts.isOwner ? "clawbox" : "maria", isOwner: opts.isOwner, multiUser: !opts.isOwner } });
    on((c) => c.url.startsWith("/setup-api/project-folders"), { status: 200, body: { folders: [FOLDER], suggestions: [], max: 50 } });
    on((c) => c.url === "/setup-api/project-backup" && c.method === "GET", {
      status: 200,
      body: {
        github: { installed: true, connected: opts.connected, login: opts.connected ? "demo-owner" : null },
        folders: [{ path: FOLDER.path, state: "none", lastBackupAt: null, auto: false }],
        suggestionDismissedAt: opts.dismissedAt ?? null,
      },
    });
    on((c) => c.body?.action === "dismiss_suggestion", { status: 200, body: { ok: true, dismissedAt: Date.now() } });
    on(isStatusRead, { status: 200, body: status({ github: { installed: true, connected: opts.connected, login: null } }) });
  }

  it("suggests GitHub to the owner, remembers 'Not now', and offers Back up on each project", async () => {
    box({ isOwner: true, connected: false });
    render(<FilesApp initialPlace="projects" />);
    const card = await screen.findByTestId("files-backup-suggestion");
    expect(card).toHaveTextContent("Keep a safe copy of your projects on GitHub. It's free and private.");
    expect(await screen.findByTestId("files-project-backup-state")).toHaveTextContent(t("files.backup.rowNone"));

    fireEvent.click(within(card).getByTestId("files-backup-suggestion-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("files-backup-suggestion")).toBeNull());
    expect(posted("dismiss_suggestion")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("files-project-backup"));
    expect(await screen.findByTestId("project-backup-panel")).toBeTruthy();
    expect(await screen.findByTestId("project-backup-intro")).toBeTruthy();
  });

  it("'Set up backup' opens the panel for a project that has no copy yet", async () => {
    box({ isOwner: true, connected: true });
    render(<FilesApp initialPlace="projects" />);
    fireEvent.click(await screen.findByTestId("files-backup-suggestion-setup"));
    expect(await screen.findByTestId("project-backup-panel")).toHaveAttribute("aria-label", t("files.backup.title", { name: "site" }));
  });

  it("does not come back within 30 days of 'Not now'", async () => {
    box({ isOwner: true, connected: false, dismissedAt: Date.now() - 3 * 24 * HOUR });
    render(<FilesApp initialPlace="projects" />);
    await screen.findByTestId("files-project-backup-state");
    expect(screen.queryByTestId("files-backup-suggestion")).toBeNull();
  });

  it("never shows the card, or asks the owner's backup route, for another ClawBox user", async () => {
    box({ isOwner: false, connected: false });
    render(<FilesApp initialPlace="projects" />);
    await screen.findByTestId("files-projects");
    await waitFor(() => expect(calls.some((c) => c.url === "/setup-api/users/me")).toBe(true));
    // Give any effect a chance to (wrongly) fire.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.queryByTestId("files-backup-suggestion")).toBeNull();
    expect(calls.some((c) => c.url === "/setup-api/project-backup")).toBe(false);
  });

  it("puts Back up in a project folder's own toolbar", async () => {
    box({ isOwner: true, connected: true });
    render(<FilesApp initialPath="projects/site" />);
    fireEvent.click(await screen.findByTestId("files-backup-toolbar"));
    expect(await screen.findByTestId("project-backup-panel")).toBeTruthy();
  });
});
