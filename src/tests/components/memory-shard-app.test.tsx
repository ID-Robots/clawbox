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
  lastIndexedAtMs: 0,
  error: "",
  run: { status: "idle", mode: "", trigger: "", startedAtMs: 0, finishedAtMs: 0, durationMs: 0, error: "" },
  schedule: { enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0 },
  nextRunAtMs: 0,
};

let memory: Record<string, unknown> = { ...LOCAL_MEMORY };
let indexCalls: unknown[] = [];
let scheduleCalls: unknown[] = [];
let indexStatus = 200;

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const ok = (json: unknown, status = 200) => ({ ok: status < 400, status, json: async () => json });
    if (url.includes("/setup-api/clawkeep/memory/index")) {
      indexCalls.push(JSON.parse(String(init?.body ?? "{}")));
      return ok({ accepted: indexStatus === 200, run: memory.run, status: memory }, indexStatus);
    }
    if (url.includes("/setup-api/clawkeep/memory/schedule")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      scheduleCalls.push(body);
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
