import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HERMES-05, the CLI path: which model a turn records when the request did not
 * name one.
 *
 * `hermes chat -q` with no `-m` runs config.yaml's default, and the route
 * already reads that pairing (`payload.current`) to validate the turn — but it
 * only recorded a model when the request named one, and reasoned that it
 * "does not presume to name" the default. The bubble then had nothing to show
 * for the turn, while the tools tell the agent the label is there. The value
 * was in hand; a blank was a false unknown.
 */
vi.mock("child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("@/lib/harness", () => ({ HERMES_BIN: "/home/clawbox/.local/bin/hermes" }));
vi.mock("@/lib/hermes-model-options", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hermes-model-options")>();
  return { ...actual, getModelOptions: vi.fn(), readCurrentFromCli: vi.fn() };
});
vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/tmp/clawbox-chat-served-model-test",
  get: vi.fn(),
}));
// The dashboard transport, captured: the cases below read what the route
// HANDS it, then let the turn fall through to the CLI.
vi.mock("@/lib/hermes-dashboard-turn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hermes-dashboard-turn")>();
  return { ...actual, openDashboardTurn: vi.fn(async () => null) };
});

import { spawn } from "child_process";
import { getModelOptions, readCurrentFromCli } from "@/lib/hermes-model-options";
import { openDashboardTurn } from "@/lib/hermes-dashboard-turn";

const mockSpawn = vi.mocked(spawn);
const mockGetModelOptions = vi.mocked(getModelOptions);
/** The mtime-keyed read of config.yaml's pairing — what the CLI itself falls back to. */
const mockReadCurrent = vi.mocked(readCurrentFromCli);
const current = (provider: string, model: string) => ({ provider, model, reasoning: "medium" });
const mockOpenDashboardTurn = vi.mocked(openDashboardTurn);

/** A `hermes chat` that exits 0 with a one-line answer and a session banner. */
function fakeHermes() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setImmediate(() => {
    child.stderr.emit("data", Buffer.from("session_id: 20260822_120000_abc123\n"));
    child.stdout.emit("data", Buffer.from("hello"));
    child.emit("close", 0);
  });
  return child;
}

function payload(
  provider: string,
  model: string,
  source = "dashboard",
  isUserDefined: boolean | null = false,
) {
  return {
    providers: [{ id: provider, name: provider, authenticated: true, models: [{ id: model }], total: 1, source, isUserDefined }],
    current: { provider, model },
    reasoning: "medium",
    fetchedAt: Date.now(),
    source,
    stale: false,
  };
}

async function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const { POST } = await import("@/app/setup-api/hermes/chat/route");
  return POST(new Request("http://localhost/setup-api/hermes/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));
}

describe("/setup-api/hermes/chat — what the CLI path records as the served model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockImplementation(() => fakeHermes() as never);
    mockGetModelOptions.mockResolvedValue(payload("clawai", "deepseek-v4-flash") as never);
    mockReadCurrent.mockResolvedValue(current("clawai", "deepseek-v4-flash"));
  });

  it("records the device default when the request named neither model nor provider", async () => {
    const res = await post({ message: "which model are you" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ model: "deepseek-v4-flash", provider: "clawai" });
  });

  it("records the device's provider when only the model was named", async () => {
    // `-m` without `--provider` runs the named model on config.yaml's provider.
    const res = await post({ message: "hi", model: "deepseek-v4-flash" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ model: "deepseek-v4-flash", provider: "clawai" });
  });

  it("reads the pairing off config.yaml itself, not the catalogue memo, which can lag an outside write", async () => {
    // getModelOptions() memoises the whole payload (fresh <60 s, stale-served
    // <6 h) and only ClawBox's own writers invalidate it; Hermes' own `/model`
    // persist and `hermes config set` do not. The `hermes config get` read is
    // keyed on config.yaml's mtime and cannot lag.
    mockGetModelOptions.mockResolvedValue(payload("clawai", "deepseek-v4-flash") as never);
    mockReadCurrent.mockResolvedValue(current("openai", "gpt-5.6-sol"));

    const res = await post({ message: "which model are you" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ model: "gpt-5.6-sol", provider: "openai" });
  });

  it("reads the default before the run, so a switch made during the turn is not the turn's record", async () => {
    // "Switch to GPT" makes the agent call ai_set_model mid-turn, which
    // rewrites config.yaml. The turn itself ran on what the file said when
    // it was spawned.
    mockSpawn.mockImplementation(() => {
      mockReadCurrent.mockResolvedValue(current("openai", "gpt-5.6-sol"));
      return fakeHermes() as never;
    });

    const res = await post({ message: "switch to gpt" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ model: "deepseek-v4-flash", provider: "clawai" });
  });

  it("does not read the pairing at all when the request named both halves", async () => {
    const res = await post({ message: "hi", provider: "clawai", model: "deepseek-v4-flash" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ model: "deepseek-v4-flash", provider: "clawai" });
    expect(mockReadCurrent).not.toHaveBeenCalled();
  });

  it("records nothing rather than a guess when the default cannot be read", async () => {
    // The real shape of "could not read": `hermesConfigGet` catches the CLI and
    // `configMtime` catches the stat, so the failure arrives as empty strings —
    // this function does not reject. Asserting on a rejection instead would
    // pin a path that cannot happen.
    mockReadCurrent.mockResolvedValue({ provider: "", model: "", reasoning: "" });

    const res = await post({ message: "hi" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("provider");
  });

  it("does not fill a half from config.yaml on a RESUMED run, which may be on a session override", async () => {
    // The dashboard transport pins per-session overrides with `/model … --session`
    // and a conversation crosses between the transports (an attachment turn is
    // forced onto this one). config.yaml's default is not that session's model,
    // and whether `-m` even beats such an override is unverified on a box.
    const res = await post({ message: "hi", model: "deepseek-v4-flash", sessionId: "20260823_185842_1eabd5" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ model: "deepseek-v4-flash" });
    expect(body).not.toHaveProperty("provider");
    expect(mockReadCurrent).not.toHaveBeenCalled();
  });
});

describe("/setup-api/hermes/chat — what the dashboard transport is told about the provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockImplementation(() => fakeHermes() as never);
    mockOpenDashboardTurn.mockResolvedValue(null);
  });

  const stream = { Accept: "text/event-stream" };

  it("passes the catalogue's own user-defined flag when the catalogue is the live dashboard", async () => {
    mockGetModelOptions.mockResolvedValue(payload("clawai", "deepseek-v4-flash", "dashboard", true) as never);
    await post({ message: "hi", provider: "clawai", model: "deepseek-v4-flash" }, stream);
    expect(mockOpenDashboardTurn).toHaveBeenCalledTimes(1);
    expect(mockOpenDashboardTurn.mock.calls[0][0]).toMatchObject({ provider: "clawai", providerIsUserDefined: true });
  });

  it("passes no flag when the dashboard's own row did not carry one", async () => {
    // `source === "dashboard"` says where the payload came from, not that the
    // dashboard answered this question. No capture of a live
    // /api/model/options row exists in this repo, so a row without the field is
    // a shape we cannot rule out — and read as `false` it blanks the label on
    // the box's own provider from the second turn on, on the shipped config.
    mockGetModelOptions.mockResolvedValue(payload("clawai", "deepseek-v4-flash", "dashboard", null) as never);
    await post({ message: "hi", provider: "clawai", model: "deepseek-v4-flash" }, stream);
    expect(mockOpenDashboardTurn).toHaveBeenCalledTimes(1);
    expect(mockOpenDashboardTurn.mock.calls[0][0]).not.toHaveProperty("providerIsUserDefined");
  });

  it("passes the dashboard's own `false` through, which is an answer", async () => {
    mockGetModelOptions.mockResolvedValue(payload("anthropic", "claude-fable-5", "dashboard", false) as never);
    await post({ message: "hi", provider: "anthropic", model: "claude-fable-5" }, stream);
    expect(mockOpenDashboardTurn.mock.calls[0][0]).toMatchObject({ providerIsUserDefined: false });
  });

  it("passes no flag off the catalog-file fallback, which cannot know either", async () => {
    // The manifest has no such column, so the fallback reports null for every
    // row; a `false` here would blank the label on the box's own provider.
    mockGetModelOptions.mockResolvedValue(payload("clawai", "deepseek-v4-flash", "catalog-file", null) as never);
    await post({ message: "hi", provider: "clawai", model: "deepseek-v4-flash" }, stream);
    expect(mockOpenDashboardTurn).toHaveBeenCalledTimes(1);
    expect(mockOpenDashboardTurn.mock.calls[0][0]).not.toHaveProperty("providerIsUserDefined");
  });
});
