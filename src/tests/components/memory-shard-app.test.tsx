import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import MemoryShardApp from "@/components/MemoryShardApp";
import { I18nProvider } from "@/lib/i18n";

/**
 * TASK-398, added UI scope, on the surface the owner actually uses — now its
 * own window. These are the memory-index assertions that used to drive
 * ClawKeepApp, mounted on Memory Shard instead: the routes, the copy and the
 * controls are the same, only the window changed.
 *
 * The point of the panel is that a customer can see whether their notes are
 * embedded on the box or in somebody's cloud, and can reindex without SSH.
 */

const LOCAL_MEMORY = {
  available: true,
  provider: "ollama",
  model: "qwen3-embedding:0.6b",
  location: "local",
  health: "healthy",
  semanticAvailable: true,
  indexIdentity: "valid",
  fingerprint: "a1b2c3d4e5f6",
  sourceCount: 2,
  files: 41,
  chunks: 318,
  vectors: 318,
  pendingFiles: 0,
  failedItems: 0,
  dirty: false,
  indexBytes: 4_194_304,
  error: "",
  run: { status: "idle", mode: "", trigger: "", startedAtMs: 0, finishedAtMs: 0, durationMs: 0, error: "" },
  schedule: { enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0 },
  nextRunAtMs: 0,
  // The app shows the SETUP WIZARD until the owner has been through it, so a
  // fixture describing an already-configured box has to say so — otherwise
  // every test below would be looking at the wizard rather than the index card
  // it means to exercise. The wizard's own behaviour is covered by
  // memory-shard-wizard.test.tsx.
  enabled: true,
  setupComplete: true,
};

let memory: Record<string, unknown> = { ...LOCAL_MEMORY };
let indexCalls: unknown[] = [];
let scheduleCalls: unknown[] = [];
let indexStatus = 200;
// A promise a POST/PUT waits on before answering — never resolved when a test
// needs the request to stay in flight.
let indexGate: Promise<void> | null = null;
let scheduleGate: Promise<void> | null = null;

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const ok = (json: unknown, status = 200) => ({ ok: status < 400, status, json: async () => json });
    if (url.includes("/setup-api/clawkeep/memory/index")) {
      indexCalls.push(JSON.parse(String(init?.body ?? "{}")));
      if (indexGate) await indexGate;
      return ok({ accepted: indexStatus === 200, run: memory.run, status: memory }, indexStatus);
    }
    if (url.includes("/setup-api/clawkeep/memory/schedule")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      scheduleCalls.push(body);
      if (scheduleGate) await scheduleGate;
      return ok({ schedule: body, nextRunAtMs: Date.now() + 3_600_000 });
    }
    if (url.includes("/setup-api/clawkeep/memory")) return ok(memory);
    return ok({});
  }));
}

function mount() {
  return render(<I18nProvider><MemoryShardApp /></I18nProvider>);
}

describe("the Memory Shard app", () => {
  beforeEach(() => {
    memory = { ...LOCAL_MEMORY };
    indexCalls = [];
    scheduleCalls = [];
    indexStatus = 200;
    indexGate = null;
    scheduleGate = null;
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("says out loud that the embedding is happening on the device", async () => {
    mount();
    // The privacy claim is the feature. If this reads "Cloud" on a local
    // embedder, or reads nothing, the panel is worse than not shipping it.
    // This file runs beside 500 others on a six-core Jetson: the default
    // one-second wait was the only thing that ever failed here, and only
    // under that load.
    expect(await screen.findByText("On device", {}, { timeout: 5000 })).toBeTruthy();
    expect(await screen.findByText("Embedding with qwen3-embedding:0.6b", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText("Healthy")).toBeTruthy();
  });

  it("opens the setup wizard on a box whose owner has not been through it", async () => {
    memory = { ...LOCAL_MEMORY, enabled: false, setupComplete: false };
    mount();
    expect(await screen.findByTestId("memory-shard-wizard")).toBeTruthy();
    // The wizard REPLACES the card: an index card underneath it would invite
    // "Index now" on a box with no embedding model yet.
    expect(screen.queryByRole("button", { name: "Index now" })).toBeNull();
  });

  it("does not put a configured owner in front of onboarding when the status carries no flag", async () => {
    // The e2e mock's `{}` again, and a server mid-restart answers the same way.
    // A missing `setupComplete` says nothing about setup: only an explicit
    // false opens the wizard, so the index card stays and says it is loading.
    memory = {} as Record<string, unknown>;
    mount();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(await screen.findByText(/Memory index — Loading/)).toBeTruthy();
    expect(screen.queryByTestId("memory-shard-wizard")).toBeNull();
  });

  it("keeps its loading line when the route answers something else, rather than throwing", async () => {
    // Exactly what the e2e mock does: any unrecognised /setup-api/* path is
    // answered `{}` with HTTP 200. That used to be adopted as a status, and
    // the first render read `status.run.status` off undefined and threw —
    // back then it took the whole ClawKeep window down. Now that the panel is
    // the window, the rule is the same: an answer it does not recognise is
    // ignored, not rendered.
    memory = {} as Record<string, unknown>;
    mount();
    expect(screen.getByTestId("memory-shard-app")).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByText(/Memory index — Loading/)).toBeTruthy();
  });

  it("shows a cloud embedder as cloud", async () => {
    memory = { ...LOCAL_MEMORY, provider: "openai", model: "text-embedding-3-large", location: "cloud" };
    mount();
    expect(await screen.findByText("Cloud")).toBeTruthy();
  });

  it("shows the index it actually has, not a spinner", async () => {
    mount();
    await screen.findByText("On device");
    expect(screen.getByText("41")).toBeTruthy();
    expect(screen.getByText("318")).toBeTruthy();
    expect(screen.getByText("4.0 MB")).toBeTruthy();
    expect(screen.getByText(/a1b2c3d4e5f6/)).toBeTruthy();
  });

  it("runs an incremental index from the button, without a confirmation", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Index now" }));
    await waitFor(() => expect(indexCalls).toEqual([{ mode: "incremental" }]));
  });

  it("reads Indexing… from the click, not from the first status read that comes back", async () => {
    // A short pass is over before the status read after the click answers;
    // waiting for that read to flip the label meant no feedback for the whole
    // run and a flash of "Indexing…" once it was done.
    indexGate = new Promise(() => {});
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Index now" }));
    const button = await screen.findByRole("button", { name: "Indexing…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows who started the last run, what it did and how long it took", async () => {
    // Without these a scheduled pass was indistinguishable from a click, and
    // "Index now" on an empty index — which runs a full build — looked like
    // the incremental pass it was not.
    memory = {
      ...LOCAL_MEMORY,
      run: { status: "succeeded", mode: "full", trigger: "schedule", startedAtMs: Date.now() - 68_248, finishedAtMs: Date.now() - 60_000, durationMs: 8_248, error: "" },
    };
    mount();
    const line = await screen.findByText(/finished 1m ago/);
    expect(line.textContent).toContain("scheduled");
    expect(line.textContent).toContain("full");
    expect(line.textContent).toContain("8 s");
  });

  it("says there is nothing to index yet on a box whose assistant has written no memory", async () => {
    // A stock box showed "Healthy" over six zeros and nothing else; the CLI's
    // own hint for that state carries a path, so the panel says it in its
    // own words instead.
    memory = { ...LOCAL_MEMORY, files: 0, chunks: 0, vectors: 0, pendingFiles: 0, sourceCount: 1, indexBytes: 131_072 };
    mount();
    expect(await screen.findByText(/Nothing to index yet/)).toBeTruthy();
  });

  it("asks before a full reindex, and only sends it once confirmed", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Full reindex" }));
    // A full reindex re-embeds everything on an 8 GB box. It must not be one
    // stray click away.
    expect(await screen.findByText("Rebuild the whole index?")).toBeTruthy();
    expect(indexCalls).toEqual([]);
    const confirm = screen.getAllByRole("button", { name: "Full reindex" }).at(-1)!;
    fireEvent.click(confirm);
    await waitFor(() => expect(indexCalls).toEqual([{ mode: "full" }]));
  });

  it("tells the customer when a run was declined because one is already going", async () => {
    indexStatus = 409;
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Index now" }));
    expect(await screen.findByText(/Indexing is already running/)).toBeTruthy();
  });

  it("lets the customer dismiss that notice, since nothing else in this window clears it", async () => {
    indexStatus = 409;
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Index now" }));
    await screen.findByText(/Indexing is already running/);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Indexing is already running/)).toBeNull();
  });

  it("saves the schedule the moment it is switched on, so it cannot be half-applied", async () => {
    mount();
    await screen.findByText("On device");
    fireEvent.click(screen.getByLabelText("Automatic indexing"));
    await waitFor(() => expect(scheduleCalls).toEqual([
      { enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0 },
    ]));
    // And the controls it gates appear, rather than staying hidden behind a
    // separate Save the user has to find.
    expect(await screen.findByLabelText("Time")).toBeTruthy();
  });

  it("does not save a half-typed time, so the field cannot jump under the user", async () => {
    // `<input type="time">` fires onChange while the value is still being
    // entered and reports an incomplete entry as "". Sent as-is, the server
    // sanitises it to 03:00 and the panel adopts that — the field jumps to a
    // time the customer never chose, mid-keystroke.
    memory = { ...LOCAL_MEMORY, schedule: { enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0 } };
    mount();
    const time = await screen.findByLabelText("Time");
    fireEvent.change(time, { target: { value: "" } });
    await waitFor(() => expect((time as HTMLInputElement).value).toBe(""));
    expect(scheduleCalls).toEqual([]);

    fireEvent.change(time, { target: { value: "04:45" } });
    await waitFor(() => expect(scheduleCalls).toEqual([
      { enabled: true, frequency: "daily", timeOfDay: "04:45", weekday: 0 },
    ]));
  });

  it("keeps the saved time when another control is clicked mid-edit, rather than sending the half-typed one", async () => {
    // One Backspace in the time field leaves it at "". The toggle, Daily/Weekly
    // and the weekday buttons all spread the draft into their save, and a ""
    // in there came back from the server as 03:00 — the saved 21:45 was lost
    // to a click on "Daily".
    memory = { ...LOCAL_MEMORY, schedule: { enabled: true, frequency: "weekly", timeOfDay: "21:45", weekday: 3 } };
    mount();
    const time = await screen.findByLabelText("Time");
    fireEvent.change(time, { target: { value: "" } });
    await waitFor(() => expect((time as HTMLInputElement).value).toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "Daily" }));
    await waitFor(() => expect(scheduleCalls).toEqual([
      { enabled: true, frequency: "daily", timeOfDay: "21:45", weekday: 3 },
    ]));
    // And the field snaps back to the time that is actually saved.
    await waitFor(() => expect((time as HTMLInputElement).value).toBe("21:45"));
  });

  it("never disables the schedule controls while a save is in flight, so focus and keystrokes survive it", async () => {
    // Chrome drops focus to <body> the moment the focused control is disabled:
    // in the time field that ate the rest of what was being typed, and after
    // Space on the toggle the next Tab started over from the shelf. jsdom does
    // not move focus, so the attribute is what is asserted.
    memory = { ...LOCAL_MEMORY, schedule: { enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0 } };
    scheduleGate = new Promise(() => {});
    mount();
    const time = await screen.findByLabelText("Time");
    fireEvent.change(time, { target: { value: "04:45" } });
    await waitFor(() => expect(scheduleCalls).toHaveLength(1));
    expect((time as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Daily" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("Automatic indexing") as HTMLInputElement).disabled).toBe(false);
  });

  it("names the weekday picker as a group, since no single control owns that label", async () => {
    memory = { ...LOCAL_MEMORY, schedule: { enabled: true, frequency: "weekly", timeOfDay: "03:00", weekday: 2 } };
    mount();
    const group = await screen.findByRole("group", { name: "Day" });
    expect(group).toBeTruthy();
    // And the chosen day is announced as chosen, not merely coloured.
    expect(screen.getByRole("button", { name: "Tue" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Wed" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("surfaces a mismatched index as something to fix, not as a healthy box", async () => {
    memory = {
      ...LOCAL_MEMORY,
      health: "degraded",
      indexIdentity: "mismatched",
      error: "The index does not match the configured embedding model. Run a full reindex.",
    };
    mount();
    expect(await screen.findByText(/does not match the configured embedding model/)).toBeTruthy();
    expect(screen.getByText("Needs attention")).toBeTruthy();
  });
});
