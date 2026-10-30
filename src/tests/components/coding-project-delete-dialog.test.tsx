/**
 * The "Remove this project" dialog.
 *
 * What is pinned here is the ORDER OF THE GESTURE, because that order is the
 * whole safety design: the box's facts first, the list of what would be lost
 * second, and then ONE button that says what it will do and asks twice — the
 * first tap arms it for five seconds and re-words it with the folder's name
 * and the cost, the second removes. No typed name, no checkbox (2026-10-30:
 * the app carries no inputs); the route still gets the folder's name back as
 * `confirm`, and `force` / `purgeOldest` travel only when the button named
 * what they cost.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingProjectDeleteDialog, { DELETE_CONFIRM_MS, type ProjectDeletePreview } from "@/components/CodingProjectDeleteDialog";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};

vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const CLEAN: ProjectDeletePreview = {
  folder: "shop",
  kind: "folder",
  directory: "/srv/projects/shop",
  size: { bytes: 4096, files: 12, truncated: false },
  unsaved: { dirty: [], dirtyCount: 0, dirtyTruncated: false, unpushed: 0, stashes: 0, ignored: [], ignoredCount: 0, ignoredTruncated: false, worktrees: [], notARepository: false, any: false },
  liveRuns: [],
  secretNames: [],
  runCount: 0,
  retentionDays: 30,
  retentionMax: 10,
  trashCount: 2,
  wouldPurge: [],
  refusal: null,
};

const OUTCOME = {
  folder: "shop",
  trashPath: "/srv/clawbox/data/deleted-projects/shop--20260913T120000Z",
  retentionDays: 30,
  retentionMax: 10,
  secretsRemoved: ["DEPLOY_TOKEN"],
  metadataKeptFor: null,
  prunedEarly: [],
  runsKept: 3,
};

let deletes: { body: unknown }[] = [];

/** Answer the preview GET with `preview`, and the DELETE with `remove`. */
function stubFetch(preview: unknown, remove: { ok: boolean; status?: number; body: unknown } = { ok: true, body: OUTCOME }) {
  deletes = [];
  const json = (body: unknown, ok = true, status = 200) => Promise.resolve({
    ok, status, json: () => Promise.resolve(body),
  } as Response);
  vi.stubGlobal("fetch", vi.fn((_input: string | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      deletes.push({ body: JSON.parse(String(init.body)) });
      return json(remove.body, remove.ok, remove.status ?? (remove.ok ? 200 : 409));
    }
    const isRefusal = typeof preview === "object" && preview !== null && "error" in (preview as object);
    return json(preview, !isRefusal, isRefusal ? 403 : 200);
  }));
}

function open(props: Partial<Parameters<typeof CodingProjectDeleteDialog>[0]> = {}) {
  return render(
    <CodingProjectDeleteDialog
      folder="shop"
      kind="folder"
      name="My Shop"
      onClose={props.onClose ?? (() => {})}
      onDeleted={props.onDeleted ?? (() => {})}
    />,
  );
}

/** The one button, once the box has said what is there. */
async function button() {
  await screen.findByTestId("coding-agent-delete-facts");
  return screen.getByTestId("coding-agent-delete-confirm") as HTMLButtonElement;
}

beforeEach(() => { deletes = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the dialog while it is reading the folder", () => {
  it("says it is looking before it claims anything about what is there, and offers no button yet", async () => {
    let answer!: (v: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { answer = resolve; })));
    open();
    expect(screen.getByTestId("coding-agent-delete-loading")).toBeTruthy();
    expect(screen.queryByTestId("coding-agent-delete-facts")).toBeNull();
    expect(screen.queryByTestId("coding-agent-delete-confirm")).toBeNull();
    answer({ ok: true, status: 200, json: () => Promise.resolve(CLEAN) });
    await screen.findByTestId("coding-agent-delete-facts");
  });
});

describe("a project that may go", () => {
  it("states its size and what goes with it, and offers one plain button — no name to type, no inputs at all", async () => {
    stubFetch({ ...CLEAN, secretNames: ["DEPLOY_TOKEN"], runCount: 3 });
    open();

    const facts = await screen.findByTestId("coding-agent-delete-facts");
    expect(facts.textContent).toContain(t("codingAgent.delete.whatIsThere", { size: "4.0 KB", files: 12 }));
    expect(facts.textContent).toContain(t("codingAgent.delete.willMove", { days: 30, max: 10 }));
    expect(facts.textContent).toContain(t("codingAgent.delete.willRemoveSecrets", { names: "DEPLOY_TOKEN" }));
    // The runs are KEPT, and the dialog says so rather than leaving it to be
    // discovered afterwards.
    expect(facts.textContent).toContain(t("codingAgent.delete.willKeepRuns", { n: 3 }));
    expect(screen.queryByTestId("coding-agent-delete-name")).toBeNull();
    expect(document.querySelectorAll("input, textarea, select")).toHaveLength(0);
    const confirm = await button();
    expect(confirm).toBeEnabled();
    expect(confirm.textContent).toBe(t("codingAgent.delete.deleteProject"));
    expect(confirm).not.toHaveAttribute("data-force");
    expect(confirm).not.toHaveAttribute("data-purge");
  });

  it("asks twice: the first tap arms the button and names the folder, the second removes and reports where it went", async () => {
    const onDeleted = vi.fn();
    stubFetch(CLEAN);
    open({ onDeleted });
    const confirm = await button();
    fireEvent.click(confirm);
    // Armed, nothing sent yet.
    expect(deletes).toEqual([]);
    expect(confirm).toHaveAttribute("data-armed", "true");
    expect(confirm).toHaveAttribute("aria-pressed", "true");
    expect(confirm.textContent).toBe(t("codingAgent.delete.really", { name: "My Shop" }));
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.queryByTestId("coding-agent-delete-done")).toBeTruthy());
    // The folder's name goes back as `confirm` — the route compares it byte
    // for byte — with neither flag, since nothing demanded one.
    expect(deletes).toEqual([{ body: { folder: "shop", kind: "folder", confirm: "shop", force: false, purgeOldest: false } }]);
    expect(screen.getByTestId("coding-agent-delete-trash-path").textContent).toBe(OUTCOME.trashPath);
    expect(screen.getByTestId("coding-agent-delete-done").textContent).toContain(t("codingAgent.delete.retention", { days: 30, max: 10 }));
    expect(screen.getByTestId("coding-agent-delete-done").textContent).toContain(t("codingAgent.delete.runsKept", { n: 3 }));
    expect(onDeleted).toHaveBeenCalledWith(OUTCOME);
  });

  it("disarms by itself after five seconds, so an armed button found later is not a mis-tap waiting to happen", async () => {
    stubFetch(CLEAN);
    open();
    const confirm = await button();
    vi.useFakeTimers();
    try {
      fireEvent.click(confirm);
      expect(confirm).toHaveAttribute("data-armed", "true");
      act(() => { vi.advanceTimersByTime(DELETE_CONFIRM_MS + 10); });
      expect(confirm).not.toHaveAttribute("data-armed");
      expect(confirm.textContent).toBe(t("codingAgent.delete.deleteProject"));
      expect(deletes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("states BOTH retention bounds, never the period on its own", async () => {
    stubFetch({ ...CLEAN, retentionDays: 7, retentionMax: 3 });
    open();
    const facts = await screen.findByTestId("coding-agent-delete-facts");
    expect(facts.textContent).toContain(t("codingAgent.delete.willMove", { days: 7, max: 3 }));
    expect(facts.textContent).not.toContain("kept there for up to 7 days.");
  });

  it("names what this removal would delete early, and asks for it on the armed button — the yes IS the sentence", async () => {
    const onDeleted = vi.fn();
    stubFetch({ ...CLEAN, trashCount: 10, wouldPurge: ["old-site"] });
    open({ onDeleted });
    const confirm = await button();
    const warning = screen.getByTestId("coding-agent-delete-would-purge");
    expect(warning.textContent).toContain(t("codingAgent.delete.willPurge", { names: "old-site", max: 10 }));
    expect(screen.queryByTestId("coding-agent-delete-purge-oldest")).toBeNull();
    expect(confirm).toHaveAttribute("data-purge", "true");

    fireEvent.click(confirm);
    expect(confirm.textContent).toBe(t("codingAgent.delete.reallyPurging", { name: "My Shop", names: "old-site" }));
    fireEvent.click(confirm);
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0].body).toMatchObject({ confirm: "shop", purgeOldest: true, force: false });
  });

  it("re-reads the shelf after a trash_full refusal, instead of leaving a dead button", async () => {
    // The preview saw room; by the time of the DELETE the shelf had filled.
    let previews = 0;
    const json = (body: unknown, ok = true, status = 200) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);
    vi.stubGlobal("fetch", vi.fn((_input: string | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deletes.push({ body: JSON.parse(String(init.body)) });
        return json({ error: "The shelf is full.", code: "trash_full" }, false, 409);
      }
      previews += 1;
      return json(previews === 1 ? CLEAN : { ...CLEAN, trashCount: 10, wouldPurge: ["old-site"] });
    }));
    open();
    const confirm = await button();
    expect(screen.queryByTestId("coding-agent-delete-would-purge")).toBeNull();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await screen.findByTestId("coding-agent-delete-error");
    expect(screen.getByTestId("coding-agent-delete-error")).toHaveAttribute("data-refusal", "trash_full");
    // The second preview names what a second try would cost, and the button
    // says so — disarmed, so it has to be asked twice again.
    await screen.findByTestId("coding-agent-delete-would-purge");
    expect(confirm).not.toHaveAttribute("data-armed");
    expect(confirm).toHaveAttribute("data-purge", "true");
    expect(deletes).toEqual([{ body: { folder: "shop", kind: "folder", confirm: "shop", force: false, purgeOldest: false } }]);
  });

  it("says when the secrets stayed because another project shares the name", async () => {
    stubFetch(CLEAN, { ok: true, body: { ...OUTCOME, secretsRemoved: [], metadataKeptFor: "shop" } });
    open();
    const confirm = await button();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await screen.findByTestId("coding-agent-delete-done");
    expect(screen.getByTestId("coding-agent-delete-metadata-kept").textContent).toBe(t("codingAgent.delete.metadataKeptSecrets"));
  });

  it("reports afterwards what the count bound actually took, and nothing about a purge when nothing went early", async () => {
    stubFetch(CLEAN, { ok: true, body: { ...OUTCOME, prunedEarly: ["old-site"] } });
    const first = open();
    let confirm = await button();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await screen.findByTestId("coding-agent-delete-done");
    expect(screen.getByTestId("coding-agent-delete-purged").textContent).toBe(t("codingAgent.delete.purged", { names: "old-site" }));
    first.unmount();

    stubFetch(CLEAN);
    open();
    confirm = await button();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await screen.findByTestId("coding-agent-delete-done");
    expect(screen.queryByTestId("coding-agent-delete-purged")).toBeNull();
  });

  it("says a folder is empty rather than quoting a size of nothing, and a measured size as a floor when the walk was cut short", async () => {
    stubFetch({ ...CLEAN, size: { bytes: 0, files: 0, truncated: false } });
    const first = open();
    expect((await screen.findByTestId("coding-agent-delete-facts")).textContent).toContain(t("codingAgent.delete.empty"));
    first.unmount();
    stubFetch({ ...CLEAN, size: { bytes: 4096, files: 12, truncated: true } });
    open();
    expect((await screen.findByTestId("coding-agent-delete-facts")).textContent).toContain(t("codingAgent.delete.sizeAtLeast"));
  });
});

describe("a project with work that exists nowhere else", () => {
  const UNSAVED: ProjectDeletePreview = {
    ...CLEAN,
    unsaved: {
      dirty: ["src/app.js", "README.md"], dirtyCount: 2, dirtyTruncated: false,
      unpushed: 3, stashes: 1,
      ignored: [".env", "app.db"], ignoredCount: 2, ignoredTruncated: false,
      worktrees: ["run-abc12345"], notARepository: false, any: true,
    },
    refusal: { code: "unsaved_work", message: "There is work here that exists nowhere else." },
  };

  it("lists exactly what would be lost, then the button says it will lose it, and only the second tap sends force", async () => {
    const onDeleted = vi.fn();
    stubFetch(UNSAVED);
    open({ onDeleted });
    const confirm = await button();
    const list = screen.getByTestId("coding-agent-delete-unsaved");
    expect(list.textContent).toContain(t("codingAgent.delete.unsavedDirty", { n: 2 }));
    expect(list.textContent).toContain("src/app.js, README.md");
    expect(list.textContent).toContain(t("codingAgent.delete.unsavedUnpushed", { n: 3 }));
    expect(list.textContent).toContain(t("codingAgent.delete.unsavedStashes", { n: 1 }));
    expect(list.textContent).toContain(t("codingAgent.delete.unsavedIgnored", { n: 2 }));
    expect(list.textContent).toContain(".env, app.db");
    expect(list.textContent).toContain(t("codingAgent.delete.unsavedWorktrees", { names: "run-abc12345" }));
    // No tick: the button is the flag, and it says so before it is pressed.
    expect(screen.queryByTestId("coding-agent-delete-force")).toBeNull();
    expect(confirm).toHaveAttribute("data-force", "true");
    expect(confirm.textContent).toBe(t("codingAgent.delete.deleteAnyway"));
    // The list comes before the button in the document.
    expect(list.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(confirm);
    expect(confirm.textContent).toBe(t("codingAgent.delete.reallyLosing", { name: "My Shop" }));
    expect(deletes).toEqual([]);
    fireEvent.click(confirm);
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0].body).toEqual({ folder: "shop", kind: "folder", confirm: "shop", force: true, purgeOldest: false });
    expect(onDeleted).toHaveBeenCalled();
  });

  it("says so when the folder has no history of its own", async () => {
    stubFetch({ ...UNSAVED, unsaved: { ...UNSAVED.unsaved, notARepository: true } });
    open();
    await button();
    expect(screen.getByTestId("coding-agent-delete-unsaved").textContent).toContain(t("codingAgent.delete.unsavedNoGit"));
  });
});

describe("the refusals no flag clears", () => {
  it("shows a live run in the owner's language and offers nothing beside it", async () => {
    stubFetch({ ...CLEAN, liveRuns: [{ id: "run-live0001", task: "add a thing" }], refusal: { code: "live_run", message: "A run is working here." } });
    open();
    const refusal = await screen.findByTestId("coding-agent-delete-refusal");
    expect(refusal).toHaveAttribute("data-refusal", "live_run");
    expect(refusal.textContent).toBe(t("codingAgent.delete.refusal.liveRun"));
    expect(screen.queryByTestId("coding-agent-delete-confirm")).toBeNull();
    expect(screen.queryByTestId("coding-agent-delete-facts")).toBeNull();
  });

  it("shows a preview that was refused outright — the checkout, a path that escapes — in the owner's words", async () => {
    stubFetch({ error: "That folder is ClawBox's own checkout.", code: "protected_checkout" });
    open();
    const refusal = await screen.findByTestId("coding-agent-delete-refusal");
    expect(refusal).toHaveAttribute("data-refusal", "protected_checkout");
    expect(refusal.textContent).toBe(t("codingAgent.delete.refusal.protectedCheckout"));
    expect(screen.queryByTestId("coding-agent-delete-confirm")).toBeNull();
  });

  it("falls back to the box's own sentence for a code it has no copy for", async () => {
    stubFetch({ error: "Something new went wrong.", code: "brand_new_code" });
    open();
    const refusal = await screen.findByTestId("coding-agent-delete-refusal");
    expect(refusal.textContent).toBe("Something new went wrong.");
  });

  it("shows a refusal the REMOVAL met, even when the preview was clean", async () => {
    stubFetch(CLEAN, { ok: false, status: 409, body: { error: "A coding run started here meanwhile.", code: "live_run" } });
    open();
    const confirm = await button();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    const failure = await screen.findByTestId("coding-agent-delete-error");
    expect(failure).toHaveAttribute("data-refusal", "live_run");
    expect(failure.textContent).toBe(t("codingAgent.delete.refusal.liveRun"));
    expect(screen.queryByTestId("coding-agent-delete-done")).toBeNull();
  });
});

describe("getting out of the dialog", () => {
  it("closes without asking the box for anything", async () => {
    const onClose = vi.fn();
    stubFetch(CLEAN);
    open({ onClose });
    await button();
    fireEvent.click(screen.getByTestId("coding-agent-delete-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(deletes).toEqual([]);
  });

  it("is a dialog the whole way — labelled, modal, and describable", async () => {
    stubFetch(CLEAN);
    open();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName(t("codingAgent.delete.title", { name: "My Shop" }));
    expect(dialog).toHaveAccessibleDescription("/srv/projects/shop");
  });
});
