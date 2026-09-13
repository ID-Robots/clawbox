/**
 * The "Remove this project" dialog.
 *
 * What is pinned here is the ORDER OF THE GESTURE, because that order is the
 * whole safety design: the box's facts first, the list of what would be lost
 * second, the force flag third, the typed name last. Every test below is one
 * link in that chain.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingProjectDeleteDialog, { type ProjectDeletePreview } from "@/components/CodingProjectDeleteDialog";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};

vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const CLEAN: ProjectDeletePreview = {
  folder: "shop",
  kind: "folder",
  directory: "/home/clawbox/Projects/shop",
  size: { bytes: 4096, files: 12, truncated: false },
  unsaved: { dirty: [], dirtyCount: 0, dirtyTruncated: false, unpushed: 0, stashes: 0, ignored: [], ignoredCount: 0, ignoredTruncated: false, worktrees: [], notARepository: false, any: false },
  liveRuns: [],
  vercelLinked: false,
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
  trashPath: "/home/clawbox/clawbox/data/deleted-projects/shop--20260913T120000Z",
  retentionDays: 30,
  retentionMax: 10,
  vercelLinkRemoved: true,
  secretsRemoved: ["VERCEL_TOKEN"],
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

beforeEach(() => { deletes = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the dialog while it is reading the folder", () => {
  it("says it is looking before it claims anything about what is there", async () => {
    stubFetch(new Promise(() => {}));
    open();
    expect(screen.getByTestId("coding-agent-delete-loading").textContent).toBe(t("codingAgent.delete.loading"));
    expect(screen.queryByTestId("coding-agent-delete-name")).toBeNull();
    expect((screen.getByTestId("coding-agent-delete-confirm") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("a project that may go", () => {
  it("states its size and what goes with it, and asks for the name", async () => {
    stubFetch({ ...CLEAN, vercelLinked: true, secretNames: ["VERCEL_TOKEN"], runCount: 3 });
    open();

    const facts = await screen.findByTestId("coding-agent-delete-facts");
    expect(facts.textContent).toContain(t("codingAgent.delete.whatIsThere", { size: "4.0 KB", files: 12 }));
    expect(facts.textContent).toContain(t("codingAgent.delete.willMove", { days: 30, max: 10 }));
    expect(facts.textContent).toContain(t("codingAgent.delete.willRemoveVercel"));
    expect(facts.textContent).toContain(t("codingAgent.delete.willRemoveSecrets", { names: "VERCEL_TOKEN" }));
    // The runs are KEPT, and the dialog says so rather than leaving it to be
    // discovered afterwards.
    expect(facts.textContent).toContain(t("codingAgent.delete.willKeepRuns", { n: 3 }));
    expect(screen.getByTestId("coding-agent-delete-name")).toBeTruthy();
  });

  it("keeps the button off until the folder's name is typed exactly", async () => {
    stubFetch(CLEAN);
    open();
    await screen.findByTestId("coding-agent-delete-facts");
    const button = screen.getByTestId("coding-agent-delete-confirm") as HTMLButtonElement;
    const field = screen.getByTestId("coding-agent-delete-name");

    expect(button.disabled).toBe(true);
    for (const typed of ["sho", "Shop", "my shop"]) {
      fireEvent.change(field, { target: { value: typed } });
      expect(button.disabled, typed).toBe(true);
    }
    fireEvent.change(field, { target: { value: "shop" } });
    expect(button.disabled).toBe(false);
  });

  it("sends the folder twice and reports where it went", async () => {
    const onDeleted = vi.fn();
    stubFetch(CLEAN);
    open({ onDeleted });
    await screen.findByTestId("coding-agent-delete-facts");
    fireEvent.change(screen.getByTestId("coding-agent-delete-name"), { target: { value: "shop" } });
    fireEvent.click(screen.getByTestId("coding-agent-delete-confirm"));

    await waitFor(() => expect(screen.queryByTestId("coding-agent-delete-done")).toBeTruthy());
    expect(deletes).toEqual([{ body: { folder: "shop", kind: "folder", confirm: "shop", force: false, purgeOldest: false } }]);
    expect(screen.getByTestId("coding-agent-delete-trash-path").textContent).toBe(OUTCOME.trashPath);
    expect(screen.getByTestId("coding-agent-delete-done").textContent).toContain(t("codingAgent.delete.retention", { days: 30, max: 10 }));
    expect(screen.getByTestId("coding-agent-delete-done").textContent).toContain(t("codingAgent.delete.vercelRemoved"));
    expect(screen.getByTestId("coding-agent-delete-done").textContent).toContain(t("codingAgent.delete.runsKept", { n: 3 }));
    expect(onDeleted).toHaveBeenCalledWith(OUTCOME);
  });

  it("states BOTH retention bounds, never the period on its own", async () => {
    // The consent defect: "kept for 30 days" is untrue the moment an eleventh
    // removal arrives. The dialog must say the count bound wherever it says the
    // period — see coding-project-delete-promise.test.ts for the copy's own half
    // of this rule.
    stubFetch(CLEAN);
    open();
    const facts = await screen.findByTestId("coding-agent-delete-facts");
    expect(facts.textContent).toContain("10");
    expect(facts.textContent).toContain("30");
    // Nothing is at risk on a shelf with room, so no warning is drawn.
    expect(screen.queryByTestId("coding-agent-delete-would-purge")).toBeNull();
  });

  it("names what this removal would delete early, and DEMANDS a yes for it", async () => {
    // The folder at risk is another project, still inside the thirty days it
    // was promised. Being told is not the same as agreeing, so the tick is a
    // condition and not a nudge — and it lives inside the panel that names it.
    stubFetch({ ...CLEAN, trashCount: 10, wouldPurge: ["old-thing--20260801T090000Z"] });
    open();
    const warning = await screen.findByTestId("coding-agent-delete-would-purge");
    expect(warning.textContent).toContain(t("codingAgent.delete.willPurge", { names: "old-thing--20260801T090000Z", max: 10 }));
    expect(warning.querySelector("[data-testid='coding-agent-delete-purge-oldest']")).toBeTruthy();

    const button = screen.getByTestId("coding-agent-delete-confirm") as HTMLButtonElement;
    fireEvent.change(screen.getByTestId("coding-agent-delete-name"), { target: { value: "shop" } });
    // The name alone is not enough while another project is at stake.
    expect(button.disabled).toBe(true);

    fireEvent.click(screen.getByTestId("coding-agent-delete-purge-oldest"));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0].body).toMatchObject({ purgeOldest: true });
  });

  it("asks for no such yes when the shelf has room", async () => {
    stubFetch(CLEAN);
    open();
    await screen.findByTestId("coding-agent-delete-facts");
    expect(screen.queryByTestId("coding-agent-delete-purge-oldest")).toBeNull();
    fireEvent.change(screen.getByTestId("coding-agent-delete-name"), { target: { value: "shop" } });
    expect((screen.getByTestId("coding-agent-delete-confirm") as HTMLButtonElement).disabled).toBe(false);
  });

  it("says when the secrets stayed because another project shares the name", async () => {
    stubFetch(CLEAN, {
      ok: true,
      body: { ...OUTCOME, vercelLinkRemoved: false, secretsRemoved: [], metadataKeptFor: "/home/clawbox/clawbox/data/code-projects/shop" },
    });
    open();
    await screen.findByTestId("coding-agent-delete-facts");
    fireEvent.change(screen.getByTestId("coding-agent-delete-name"), { target: { value: "shop" } });
    fireEvent.click(screen.getByTestId("coding-agent-delete-confirm"));
    // "No secrets went" would otherwise read as "there were none".
    expect((await screen.findByTestId("coding-agent-delete-metadata-kept")).textContent)
      .toBe(t("codingAgent.delete.metadataKept"));
  });

  it("reports afterwards what the count bound actually took", async () => {
    stubFetch(
      { ...CLEAN, trashCount: 10, wouldPurge: ["old-thing--20260801T090000Z"] },
      { ok: true, body: { ...OUTCOME, prunedEarly: ["old-thing--20260801T090000Z"] } },
    );
    open();
    await screen.findByTestId("coding-agent-delete-facts");
    fireEvent.change(screen.getByTestId("coding-agent-delete-name"), { target: { value: "shop" } });
    // The shelf is full, so the removal needs the explicit yes as well.
    fireEvent.click(screen.getByTestId("coding-agent-delete-purge-oldest"));
    fireEvent.click(screen.getByTestId("coding-agent-delete-confirm"));

    const purged = await screen.findByTestId("coding-agent-delete-purged");
    expect(purged.textContent).toBe(t("codingAgent.delete.purged", { names: "old-thing--20260801T090000Z" }));
  });

  it("says nothing about a purge when nothing went early", async () => {
    stubFetch(CLEAN);
    open();
    await screen.findByTestId("coding-agent-delete-facts");
    fireEvent.change(screen.getByTestId("coding-agent-delete-name"), { target: { value: "shop" } });
    fireEvent.click(screen.getByTestId("coding-agent-delete-confirm"));
    await screen.findByTestId("coding-agent-delete-done");
    expect(screen.queryByTestId("coding-agent-delete-purged")).toBeNull();
  });

  it("says a folder is empty rather than quoting a size of nothing", async () => {
    stubFetch({ ...CLEAN, size: { bytes: 0, files: 0, truncated: false } });
    open();
    expect((await screen.findByTestId("coding-agent-delete-facts")).textContent).toContain(t("codingAgent.delete.empty"));
  });

  it("reports a measured size as a floor when the walk was cut short", async () => {
    stubFetch({ ...CLEAN, size: { bytes: 1024 * 1024 * 900, files: 40_000, truncated: true } });
    open();
    expect((await screen.findByTestId("coding-agent-delete-facts")).textContent).toContain(t("codingAgent.delete.sizeAtLeast"));
  });
});

describe("a project with work that exists nowhere else", () => {
  const DIRTY: ProjectDeletePreview = {
    ...CLEAN,
    unsaved: {
      dirty: ["index.html", "src/app.ts"],
      dirtyCount: 14,
      dirtyTruncated: true,
      unpushed: 2,
      stashes: 1,
      ignored: ["app.db"],
      ignoredCount: 1,
      ignoredTruncated: false,
      worktrees: ["run-abc12345"],
      notARepository: false,
      any: true,
    },
    refusal: { code: "unsaved_work", message: "shop has 14 uncommitted changes, 2 unpushed commits…" },
  };

  it("lists exactly what would be lost, and offers the flag only after that", async () => {
    stubFetch(DIRTY);
    open();
    const panel = await screen.findByTestId("coding-agent-delete-unsaved");

    expect(panel.textContent).toContain(t("codingAgent.delete.unsavedDirty", { n: 14 }));
    expect(panel.textContent).toContain("index.html, src/app.ts");
    expect(panel.textContent).toContain(t("codingAgent.delete.andMore"));
    expect(panel.textContent).toContain(t("codingAgent.delete.unsavedUnpushed", { n: 2 }));
    // Stashes and ignored files are work that exists nowhere else too, and the
    // ignored ones are NAMED, because git cannot tell `node_modules/` from the
    // only copy of a database and the owner can.
    expect(panel.textContent).toContain(t("codingAgent.delete.unsavedStashes", { n: 1 }));
    expect(panel.textContent).toContain(t("codingAgent.delete.unsavedIgnored", { n: 1 }));
    expect(panel.textContent).toContain("app.db");
    expect(panel.textContent).toContain(t("codingAgent.delete.unsavedWorktrees", { names: "run-abc12345" }));
    // The flag lives INSIDE the panel that lists the losses: it cannot be
    // reached without the list being on screen.
    expect(panel.querySelector("[data-testid='coding-agent-delete-force']")).toBeTruthy();
  });

  it("will not remove until the flag is ticked AND the name is typed", async () => {
    stubFetch(DIRTY);
    open();
    await screen.findByTestId("coding-agent-delete-unsaved");
    const button = screen.getByTestId("coding-agent-delete-confirm") as HTMLButtonElement;

    fireEvent.change(screen.getByTestId("coding-agent-delete-name"), { target: { value: "shop" } });
    expect(button.disabled).toBe(true);

    fireEvent.click(screen.getByTestId("coding-agent-delete-force"));
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0].body).toMatchObject({ force: true });
  });

  it("says so when the folder has no history of its own", async () => {
    stubFetch({
      ...DIRTY,
      unsaved: { ...DIRTY.unsaved, dirty: [], dirtyCount: 0, dirtyTruncated: false, unpushed: null, worktrees: [], notARepository: true },
    });
    open();
    expect((await screen.findByTestId("coding-agent-delete-unsaved")).textContent)
      .toContain(t("codingAgent.delete.unsavedNoGit"));
  });
});

describe("the refusals no flag clears", () => {
  it("shows a live run in the owner's language and offers nothing beside it", async () => {
    stubFetch({ ...CLEAN, liveRuns: [{ id: "run-abc12345", task: "x" }], refusal: { code: "live_run", message: "raw box sentence" } });
    open();

    const refusal = await screen.findByTestId("coding-agent-delete-refusal");
    expect(refusal.getAttribute("data-refusal")).toBe("live_run");
    expect(refusal.textContent).toBe(t("codingAgent.delete.refusal.liveRun"));
    expect(screen.queryByTestId("coding-agent-delete-force")).toBeNull();
    expect(screen.queryByTestId("coding-agent-delete-name")).toBeNull();
    expect((screen.getByTestId("coding-agent-delete-confirm") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a preview that was refused outright — the checkout, a path that escapes", async () => {
    for (const [code, key] of [
      ["protected_checkout", "codingAgent.delete.refusal.protectedCheckout"],
      ["path_escape", "codingAgent.delete.refusal.pathEscape"],
      ["outside_roots", "codingAgent.delete.refusal.outsideRoots"],
      ["not_found", "codingAgent.delete.refusal.notFound"],
    ] as const) {
      stubFetch({ error: "raw box sentence", code });
      const view = open();
      const refusal = await screen.findByTestId("coding-agent-delete-refusal");
      expect(refusal.getAttribute("data-refusal")).toBe(code);
      expect(refusal.textContent).toBe(t(key));
      expect(screen.queryByTestId("coding-agent-delete-name")).toBeNull();
      view.unmount();
    }
  });

  it("falls back to the box's own sentence for a code it has no copy for", async () => {
    stubFetch({ error: "Something this build has never heard of.", code: "some_new_reason" });
    open();
    expect((await screen.findByTestId("coding-agent-delete-refusal")).textContent)
      .toBe("Something this build has never heard of.");
  });

  it("shows a refusal the REMOVAL met, even when the preview was clean", async () => {
    // The race the confirmation cannot close: a run starts between the preview
    // and the click. The route refuses, and the dialog says why rather than
    // reporting a removal that did not happen.
    stubFetch(CLEAN, { ok: false, status: 409, body: { error: "raw", code: "live_run" } });
    open();
    await screen.findByTestId("coding-agent-delete-facts");
    fireEvent.change(screen.getByTestId("coding-agent-delete-name"), { target: { value: "shop" } });
    fireEvent.click(screen.getByTestId("coding-agent-delete-confirm"));

    const error = await screen.findByTestId("coding-agent-delete-error");
    expect(error.getAttribute("data-refusal")).toBe("live_run");
    expect(error.textContent).toBe(t("codingAgent.delete.refusal.liveRun"));
    expect(screen.queryByTestId("coding-agent-delete-done")).toBeNull();
  });
});

describe("getting out of the dialog", () => {
  it("closes without asking the box for anything", async () => {
    const onClose = vi.fn();
    stubFetch(CLEAN);
    open({ onClose });
    await screen.findByTestId("coding-agent-delete-facts");
    fireEvent.click(screen.getByTestId("coding-agent-delete-cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(deletes).toEqual([]);
  });

  it("is a dialog the whole way — labelled, modal, and describable", async () => {
    stubFetch(CLEAN);
    open();
    const panel = await screen.findByRole("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(panel.getAttribute("aria-labelledby") ?? "")?.textContent)
      .toBe(t("codingAgent.delete.title", { name: "My Shop" }));
    expect(document.getElementById(panel.getAttribute("aria-describedby") ?? "")?.textContent)
      .toBe("/home/clawbox/Projects/shop");
  });
});
