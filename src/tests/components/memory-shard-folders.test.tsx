/**
 * The folders Memory Shard reads — the ONE component behind the wizard's
 * folders step and the settings page's Folders card.
 *
 * What the real-browser sweep found (ms-findings F-A, F-D, F-G): a write to
 * the list is a ~5 s CLI spawn, the buttons were merely `disabled` for that
 * long with no word about it and the picker stayed open — which is what
 * invited the second click that raced the first; after setup there was no
 * surface at all that showed the folders; and a refused Remove said nothing.
 *
 * Rendered without an I18nProvider, `t` answers the key itself, which is what
 * these tests match on; the English behind the new keys is pinned once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import MemoryShardFolders from "@/components/MemoryShardFolders";
import MemoryShardSettingsPanel from "@/components/MemoryShardSettingsPanel";
import { clawkeepTranslations } from "@/lib/clawkeep-translations";

const ADDING = "clawkeep.memory.folders.adding";
const REMOVING = "clawkeep.memory.folders.removing";
const REMOVE = "clawkeep.memory.setup.removeFolder";
const USE_FOLDER = "clawkeep.memory.setup.useFolder";
const REMOVE_FAILED = "clawkeep.memory.folders.removeFailed";

const A = "/home/clawbox/A";
const B = "/home/clawbox/B";
const PICKED = "/home/clawbox/Documents";

let sources: string[];
let writes: { method: string; path: string }[];
/** An in-flight write waits on this before answering; null answers at once. */
let gate: { promise: Promise<void>; release: () => void } | null;
/** The next write's refusal: a status and a body, or no body at all. */
let refuse: { status: number; body: unknown } | null;

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

    if (url.startsWith("/setup-api/clawkeep/memory/sources")) {
      if (!init?.method) return json({ paths: sources });
      const body = JSON.parse(String(init.body)) as { path: string };
      writes.push({ method: init.method, path: body.path });
      if (gate) await gate.promise;
      if (refuse) {
        const answer = refuse;
        refuse = null;
        return answer.body === null ? new Response(null, { status: answer.status }) : json(answer.body, answer.status);
      }
      sources = init.method === "POST"
        ? (sources.includes(body.path) ? sources : [...sources, body.path])
        : sources.filter((p) => p !== body.path);
      return json({ paths: sources });
    }
    if (url.startsWith("/setup-api/coding-agent/browse")) {
      return json({ root: "/home/clawbox", path: PICKED, parent: "/home/clawbox", entries: [{ name: "Notes", path: `${PICKED}/Notes` }] });
    }
    return json({});
  }));
}

beforeEach(() => {
  sources = [A, B];
  writes = [];
  gate = null;
  refuse = null;
  installFetch();
});
afterEach(() => vi.unstubAllGlobals());

/** Every Remove button, in row order. */
const removeButtons = () => screen.getAllByTestId("memory-shard-folder-remove") as HTMLButtonElement[];

async function openPicker() {
  fireEvent.click(screen.getByTestId("memory-shard-browse"));
  return (await screen.findByTestId("memory-shard-picker")) as HTMLElement;
}

describe("MemoryShardFolders", () => {
  it("lists the folders the route answers, with a Remove on each row", async () => {
    render(<MemoryShardFolders />);
    await waitFor(() => expect(removeButtons()).toHaveLength(2));
    expect(screen.getByTestId("memory-shard-sources").textContent).toContain(A);
    expect(screen.getByTestId("memory-shard-sources").textContent).toContain(B);
  });

  it("locks every folder control while a remove is in flight and relabels the pressed button", async () => {
    render(<MemoryShardFolders />);
    await waitFor(() => expect(removeButtons()).toHaveLength(2));
    gate = deferred();

    fireEvent.click(removeButtons()[0]);

    // The pressed button says what it is doing; the other row's button
    // keeps its own word but is disabled, and so is Add a folder.
    await waitFor(() => expect(removeButtons()[0].textContent).toBe(REMOVING));
    expect(removeButtons()[0]).toBeDisabled();
    expect(removeButtons()[1].textContent).toBe(REMOVE);
    expect(removeButtons()[1]).toBeDisabled();
    expect(screen.getByTestId("memory-shard-browse")).toBeDisabled();
    // A second click during the write must not reach the route.
    fireEvent.click(removeButtons()[1]);
    expect(writes).toEqual([{ method: "DELETE", path: A }]);

    gate.release();
    await waitFor(() => expect(removeButtons()).toHaveLength(1));
    expect(screen.getByTestId("memory-shard-sources").textContent).not.toContain(A);
    expect(removeButtons()[0]).not.toBeDisabled();
    expect(screen.getByTestId("memory-shard-browse")).not.toBeDisabled();
  });

  it("locks the rows and the picker while an add is in flight, and closes the picker once it succeeded", async () => {
    render(<MemoryShardFolders />);
    await waitFor(() => expect(removeButtons()).toHaveLength(2));
    const picker = await openPicker();
    gate = deferred();

    fireEvent.click(screen.getByTestId("memory-shard-pick"));

    await waitFor(() => expect(screen.getByTestId("memory-shard-pick").textContent).toBe(ADDING));
    expect(screen.getByTestId("memory-shard-pick")).toBeDisabled();
    for (const button of removeButtons()) expect(button).toBeDisabled();
    // The picker's own navigation and its Close are folder controls too.
    for (const button of within(picker).getAllByRole("button")) expect(button).toBeDisabled();
    // Still open while the write runs: the owner can see what is being added.
    expect(screen.getByTestId("memory-shard-picker")).toBeInTheDocument();

    gate.release();
    await waitFor(() => expect(screen.queryByTestId("memory-shard-picker")).not.toBeInTheDocument());
    expect(screen.getByTestId("memory-shard-sources").textContent).toContain(PICKED);
    expect(writes).toEqual([{ method: "POST", path: PICKED }]);
  });

  it("tells its host when a write starts and when it is answered, so a control the host owns can wait too", async () => {
    const onBusyChange = vi.fn();
    render(<MemoryShardFolders onBusyChange={onBusyChange} />);
    await waitFor(() => expect(removeButtons()).toHaveLength(2));
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    gate = deferred();

    fireEvent.click(removeButtons()[0]);
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));

    gate.release();
    await waitFor(() => expect(removeButtons()).toHaveLength(1));
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps the picker open and shows the route's own sentence when the add is refused", async () => {
    render(<MemoryShardFolders />);
    await waitFor(() => expect(removeButtons()).toHaveLength(2));
    await openPicker();
    refuse = { status: 400, body: { error: "That is not a folder.", kind: "not_found" } };

    fireEvent.click(screen.getByTestId("memory-shard-pick"));

    expect(await screen.findByText("That is not a folder.")).toBeInTheDocument();
    expect(screen.getByTestId("memory-shard-picker")).toBeInTheDocument();
    expect(screen.getByTestId("memory-shard-pick").textContent).toBe(USE_FOLDER);
    expect(screen.getByTestId("memory-shard-pick")).not.toBeDisabled();
    expect(screen.getByTestId("memory-shard-sources").textContent).not.toContain(PICKED);

    // The same click, once the box accepts it, closes the picker.
    fireEvent.click(screen.getByTestId("memory-shard-pick"));
    await waitFor(() => expect(screen.queryByTestId("memory-shard-picker")).not.toBeInTheDocument());
    expect(screen.queryByText("That is not a folder.")).not.toBeInTheDocument();
  });

  it("says so when a remove is refused — the route's words, or its own when there are none (F-G)", async () => {
    render(<MemoryShardFolders />);
    await waitFor(() => expect(removeButtons()).toHaveLength(2));

    refuse = { status: 500, body: { error: "The folder list could not be saved. Try again.", kind: "write_failed" } };
    fireEvent.click(removeButtons()[0]);
    expect(await screen.findByText("The folder list could not be saved. Try again.")).toBeInTheDocument();
    // Nothing was removed, and the row is back to its own word.
    expect(removeButtons()).toHaveLength(2);
    expect(removeButtons()[0].textContent).toBe(REMOVE);

    // A refusal with no body at all — a proxy's bare 502 — still gets a sentence.
    refuse = { status: 502, body: null };
    fireEvent.click(removeButtons()[1]);
    expect(await screen.findByText(REMOVE_FAILED)).toBeInTheDocument();
    expect(removeButtons()).toHaveLength(2);
  });

  it("has words behind every new key, in all ten locales", () => {
    expect(clawkeepTranslations.en[ADDING]).toBe("Adding…");
    expect(clawkeepTranslations.en[REMOVING]).toBe("Removing…");
    expect(clawkeepTranslations.en[REMOVE_FAILED]).toBe("Could not remove that folder.");
    expect(clawkeepTranslations.en["clawkeep.memory.folders.title"]).toBe("Folders it reads");
    for (const locale of Object.keys(clawkeepTranslations) as (keyof typeof clawkeepTranslations)[]) {
      for (const key of [ADDING, REMOVING, REMOVE_FAILED, "clawkeep.memory.folders.title", "clawkeep.memory.folders.hint"]) {
        expect(clawkeepTranslations[locale][key], `${locale} ${key}`).toBeTruthy();
      }
      // The hint names the next pass; a locale that pasted the English would
      // fail the eye, not this test, so the cheap check is that it is not the
      // English.
      if (locale !== "en") {
        expect(clawkeepTranslations[locale]["clawkeep.memory.folders.hint"]).not.toBe(clawkeepTranslations.en["clawkeep.memory.folders.hint"]);
      }
    }
  });
});

describe("the settings page's Folders card (F-D)", () => {
  const renderPanel = () => render(
    <MemoryShardSettingsPanel
      state={{ enabled: true, setupComplete: true }}
      onChanged={() => {}}
      onReset={() => {}}
    />,
  );

  it("lists the indexed folders above Start over, with the title and the hint", async () => {
    renderPanel();
    const card = screen.getByTestId("memory-shard-folders-card");
    expect(card.textContent).toContain("clawkeep.memory.folders.title");
    expect(card.textContent).toContain("clawkeep.memory.folders.hint");
    await waitFor(() => expect(within(card).getAllByTestId("memory-shard-folder-remove")).toHaveLength(2));
    expect(within(card).getByTestId("memory-shard-sources").textContent).toContain(A);
    // The consent about which documents are read sits beside the switch, and
    // before the tool that throws the setup away.
    const reset = screen.getByTestId("memory-shard-reset-card");
    expect(card.compareDocumentPosition(reset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("removes a folder from the card, through the same route the wizard uses", async () => {
    renderPanel();
    const card = screen.getByTestId("memory-shard-folders-card");
    await waitFor(() => expect(within(card).getAllByTestId("memory-shard-folder-remove")).toHaveLength(2));

    fireEvent.click(within(card).getAllByTestId("memory-shard-folder-remove")[1]);

    await waitFor(() => expect(within(card).getAllByTestId("memory-shard-folder-remove")).toHaveLength(1));
    expect(writes).toEqual([{ method: "DELETE", path: B }]);
    expect(within(card).getByTestId("memory-shard-sources").textContent).not.toContain(B);
  });

  it("adds a folder from the card through the same picker the wizard has", async () => {
    renderPanel();
    const card = screen.getByTestId("memory-shard-folders-card");
    await waitFor(() => expect(within(card).getAllByTestId("memory-shard-folder-remove")).toHaveLength(2));

    fireEvent.click(within(card).getByTestId("memory-shard-browse"));
    fireEvent.click(await within(card).findByTestId("memory-shard-pick"));

    await waitFor(() => expect(within(card).getByTestId("memory-shard-sources").textContent).toContain(PICKED));
    expect(writes).toEqual([{ method: "POST", path: PICKED }]);
  });
});
