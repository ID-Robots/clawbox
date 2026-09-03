import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HERMES-06 — the DASHBOARD transport, on the turn nobody pinned.
 *
 * The existing served-model tests all sit under "what the CLI path records".
 * The CLI path fills both halves from config.yaml; the dashboard transport is
 * what actually answers on a Hermes box, and it fills NEITHER when the request
 * named no provider. So the tested guarantee never applied to the common case:
 * the customer presses "+", types, and the reply carries a model with no
 * provider beside it.
 *
 * Reproduced on the box three runs out of three — `done` came back
 * `{"model":"gpt-5.6-sol", …}` with no `provider` key, and the persisted row
 * had `provider=None` — while Hermes' own `session_model_usage` table held
 * `billing_provider='openai-codex'` for each of those three session ids. The
 * answer was one read away and nobody asked.
 *
 * The fixtures are that shape: a real `state.db` with the columns the box
 * declared, and the route driven end to end over its own SSE stream. Usage rows
 * are written by the FAKE TURN rather than by the setup, because the rule under
 * test is "which rows did this turn write" — a fixture that seeded them before
 * the turn would be asserting a different function, and is what case 5 pins.
 */

const openTurnMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const appendMock = vi.hoisted(() => vi.fn());
const modelOptionsMock = vi.hoisted(() => vi.fn());

// Only the OPENING of the turn is faked; the rest of the transport module is
// the real thing, so the guard that refuses to invent a provider is the real
// guard and not a stand-in that always agrees.
vi.mock("@/lib/hermes-dashboard-turn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-dashboard-turn")>()),
  openDashboardTurn: openTurnMock,
}));
vi.mock("child_process", () => ({ spawn: spawnMock, execFile: vi.fn() }));
vi.mock("@/lib/harness", () => ({ HERMES_BIN: "/home/clawbox/.local/bin/hermes" }));
vi.mock("@/lib/harness/transcript-store", () => ({ appendTranscript: appendMock }));
vi.mock("@/lib/harness/media-root", () => ({
  resolveInMediaRoot: vi.fn(async (p: string) => p),
  chatMediaRoot: vi.fn(async () => "/tmp/clawbox-served-model-dashboard-media"),
}));
// `cachedModelOptions` is what the settle path reads, and the pure judges around
// it (`shouldEnforcePairing` / `isPairAllowed`) stay real — a hand-written
// stand-in for those would prove nothing.
vi.mock("@/lib/hermes-model-options", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hermes-model-options")>();
  return {
    ...actual,
    cachedModelOptions: modelOptionsMock,
    getModelOptions: vi.fn(async () => {
      throw new Error("the settle path must not fetch the catalogue");
    }),
    readCurrentFromCli: vi.fn(async () => ({ provider: "", model: "", reasoning: "" })),
  };
});

import { POST } from "@/app/setup-api/hermes/chat/route";

/** The session the box's step-4b run actually produced. */
const SESSION_ID = "20260902_205829_99ac3f";

/** Variable specifier: `@types/node` here has no declaration for the builtin. */
const SQLITE = "node:sqlite";

/**
 * Whether this runtime has `node:sqlite` at all. Resolved once, at collection
 * time, so an environment without it SKIPS these cases loudly instead of
 * running them to a green that asserted nothing.
 */
const sqliteAvailable = await (async () => {
  try {
    await import(SQLITE);
    return true;
  } catch {
    return false;
  }
})();

/** Bill `count` calls of `model` to `provider` in `~/.hermes/state.db`. */
async function bill(home: string, model: string, provider: string, count: number, seen: number) {
  const { DatabaseSync } = await import(SQLITE);
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.prepare(
    "INSERT INTO session_model_usage (session_id, model, billing_provider, billing_mode, task,"
    + " api_call_count, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?)"
    + " ON CONFLICT(session_id, model, billing_provider, billing_base_url, billing_mode, task)"
    + " DO UPDATE SET api_call_count = excluded.api_call_count, last_seen = excluded.last_seen",
  ).run(SESSION_ID, model, provider, "subscription_included", "chat", count, 1, seen);
  db.close();
}

/**
 * A turn handle that streams one fragment, bills what it was told to bill, and
 * then settles on the given pair.
 *
 * `provider: ""` is the shape under test, not an oversight: the transport
 * answers a model with NO provider whenever it cannot name one honestly.
 */
function fakeTurn(opts: {
  home: string;
  model?: string;
  provider?: string;
  /** What the completion frame reports, when it differs from the session's. */
  finalModel?: string;
  /** What Hermes bills WHILE the turn runs, as it does on a box. */
  bills?: Array<{ model: string; provider: string; count?: number; seen?: number }>;
}) {
  return {
    sessionId: SESSION_ID,
    model: opts.model ?? "",
    provider: opts.provider ?? "",
    async run(onDelta: (chunk: string) => void) {
      for (const entry of opts.bills ?? []) {
        await bill(opts.home, entry.model, entry.provider, entry.count ?? 1, entry.seen ?? 20);
      }
      onDelta("I am a model.");
      const finalModel = opts.finalModel ?? opts.model;
      return {
        text: "I am a model.",
        reasoning: "",
        status: "complete",
        ...(finalModel ? { model: finalModel } : {}),
        ...(opts.provider ? { provider: opts.provider } : {}),
      };
    },
    close() {},
  };
}

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/setup-api/hermes/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
}

/** The last SSE frame's payload — the `done` the bubble is built from. */
async function doneEvent(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const frames = text.split("\n\n").filter((frame) => frame.trim());
  const last = frames[frames.length - 1];
  const data = last
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  return JSON.parse(data) as Record<string, unknown>;
}

/** The assistant record this turn wrote to the customer's durable transcript. */
function persistedAssistant(): Record<string, unknown> | undefined {
  return appendMock.mock.calls
    .map(([record]) => record as Record<string, unknown>)
    .find((record) => record.role === "assistant");
}

/**
 * A catalogue payload. `authenticated` with a non-empty model list is what
 * makes `shouldEnforcePairing` willing to judge a pairing at all, and
 * `isUserDefined === false` is what makes the list an ENUMERATION rather than
 * one this repo may have seeded.
 */
function catalogue(provider: string, models: string[], isUserDefined: boolean | null = false) {
  return {
    providers: [{
      id: provider,
      name: provider,
      authenticated: true,
      verified: null,
      models: models.map((id) => ({ id })),
      total: models.length,
      source: "dashboard",
      isUserDefined,
    }],
    current: { provider, model: models[0] ?? "" },
    reasoning: "medium",
    fetchedAt: Date.now(),
    source: "dashboard",
    stale: false,
  };
}

/**
 * `~/.hermes/state.db` as the box declared it, trimmed to the columns these
 * paths read. `session_model_usage`'s primary key really is that six-column
 * one — a session can bill the same model id under more than one provider over
 * its life, which is the case the picker has to refuse rather than guess at.
 */
async function writeStateDb(home: string): Promise<void> {
  const { DatabaseSync } = await import(SQLITE);
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    timestamp REAL NOT NULL,
    finish_reason TEXT,
    reasoning TEXT,
    reasoning_content TEXT
  )`);
  db.exec(`CREATE TABLE session_model_usage (
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    billing_provider TEXT NOT NULL,
    billing_base_url TEXT NOT NULL DEFAULT '',
    billing_mode TEXT NOT NULL DEFAULT '',
    task TEXT NOT NULL DEFAULT '',
    api_call_count INTEGER NOT NULL DEFAULT 0,
    first_seen REAL,
    last_seen REAL,
    PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
  )`);
  const message = db.prepare(
    "INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?,?,?,?,?)",
  );
  message.run(SESSION_ID, "user", "which model are you", 1, null);
  message.run(SESSION_ID, "assistant", "I am a model.", 2, "stop");
  db.close();
}

describe.skipIf(!sqliteAvailable)(
  "/setup-api/hermes/chat — what the DASHBOARD transport records as the served provider",
  () => {
    let home: string;

    beforeEach(async () => {
      vi.clearAllMocks();
      home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-served-provider-"));
      process.env.HERMES_HOME = home;
      appendMock.mockResolvedValue(true);
      // No catalogue unless a case supplies one: the unpinned turn never warms
      // it on the way in, so this is the shape the settle path really meets.
      modelOptionsMock.mockReturnValue(null);
      await writeStateDb(home);
    });

    afterEach(() => {
      delete process.env.HERMES_HOME;
      fs.rmSync(home, { recursive: true, force: true });
    });

    it("names the provider Hermes itself billed, when the frame gave a model and the request pinned nothing", async () => {
      openTurnMock.mockResolvedValue(fakeTurn({
        home,
        model: "gpt-5.6-sol",
        bills: [{ model: "gpt-5.6-sol", provider: "openai-codex" }],
      }));

      const done = await doneEvent(await POST(post({ message: "which model are you" })));

      expect(done).toMatchObject({ model: "gpt-5.6-sol", provider: "openai-codex" });
      // ...and the same into the durable transcript, which is what a refreshed
      // page replays. A bubble that loses its provider on reload is the same
      // defect one layer down.
      expect(persistedAssistant()).toMatchObject({ model: "gpt-5.6-sol", provider: "openai-codex" });
    });

    it("still says nothing when the harness recorded no usage for that turn", async () => {
      openTurnMock.mockResolvedValue(fakeTurn({ home, model: "gpt-5.6-sol" }));

      const done = await doneEvent(await POST(post({ message: "which model are you" })));

      expect(done).toMatchObject({ model: "gpt-5.6-sol" });
      expect(done).not.toHaveProperty("provider");
      expect(persistedAssistant()).not.toHaveProperty("provider");
    });

    it("does not let an EARLIER turn's row label this one", async () => {
      // The box moves to another provider serving the same model id, and this
      // turn's row has not landed when the label is decided. The old row is
      // still there and must not answer — that would be a wrong provider
      // written durably, which is worse than the blank this replaces.
      await bill(home, "glm-5", "zai", 1, 20);
      openTurnMock.mockResolvedValue(fakeTurn({ home, model: "glm-5" }));

      const done = await doneEvent(await POST(post({ message: "which model are you" })));

      expect(done).toMatchObject({ model: "glm-5" });
      expect(done).not.toHaveProperty("provider");
      expect(persistedAssistant()).not.toHaveProperty("provider");
    });

    it("says nothing when the recorded provider cannot serve the model the frame named", async () => {
      // A contradiction is not an answer. The catalogue here enumerates
      // anthropic's models, and `gpt-5.6-sol` is not among them, so the
      // recorded pairing describes something other than this turn.
      modelOptionsMock.mockReturnValue(catalogue("anthropic", ["claude-fable-5"]));
      openTurnMock.mockResolvedValue(fakeTurn({
        home,
        model: "gpt-5.6-sol",
        bills: [{ model: "gpt-5.6-sol", provider: "anthropic" }],
      }));

      const done = await doneEvent(await POST(post({ message: "which model are you" })));

      expect(done).toMatchObject({ model: "gpt-5.6-sol" });
      expect(done).not.toHaveProperty("provider");
      expect(persistedAssistant()).not.toHaveProperty("provider");
    });

    it("keeps the provider when the catalogue's list is one this repo may have seeded", async () => {
      // A user-defined provider's models are whatever config declares, and
      // `normalizeRow` pads the box's own provider from a single configured id.
      // Vetoing the harness's own billing record against a list we padded
      // ourselves would blank the label on the commonest provider on the fleet.
      modelOptionsMock.mockReturnValue(catalogue("clawai", ["deepseek-v4-flash"], true));
      openTurnMock.mockResolvedValue(fakeTurn({
        home,
        model: "deepseek-v4-reasoner",
        bills: [{ model: "deepseek-v4-reasoner", provider: "clawai" }],
      }));

      const done = await doneEvent(await POST(post({ message: "which model are you" })));

      expect(done).toMatchObject({ model: "deepseek-v4-reasoner", provider: "clawai" });
    });

    it("keeps the provider when a live catalogue agrees the pair is real", async () => {
      // The only shape that runs on a warm box: the chat header warms the
      // catalogue, so the veto is consulted and must not fire on a good pair.
      modelOptionsMock.mockReturnValue(catalogue("openai-codex", ["gpt-5.6-sol"]));
      openTurnMock.mockResolvedValue(fakeTurn({
        home,
        model: "gpt-5.6-sol",
        bills: [{ model: "gpt-5.6-sol", provider: "openai-codex" }],
      }));

      const done = await doneEvent(await POST(post({ message: "which model are you" })));

      expect(done).toMatchObject({ model: "gpt-5.6-sol", provider: "openai-codex" });
      expect(persistedAssistant()).toMatchObject({ provider: "openai-codex" });
    });

    it("answers for the model the COMPLETION frame named, not the one the session settled on", async () => {
      // The frame changed the model, so the transport records that model with no
      // provider — the settled provider belongs to the settled model. The
      // billing record is keyed on the frame's model, so it speaks for the pair
      // that actually ran rather than reinstating the session's.
      openTurnMock.mockResolvedValue(fakeTurn({
        home,
        model: "deepseek-v4-flash",
        finalModel: "gpt-5.6-sol",
        bills: [{ model: "gpt-5.6-sol", provider: "openai-codex" }],
      }));

      const done = await doneEvent(await POST(post({ message: "which model are you" })));

      expect(done).toMatchObject({ model: "gpt-5.6-sol", provider: "openai-codex" });
    });

    it("says nothing when the harness recorded the ambiguous word `custom`", async () => {
      // `custom` is the dashboard's KIND for a user-defined provider AND a real
      // CLI slug for a generic OpenAI-compatible endpoint. Nothing here can tell
      // them apart, so it is never asserted — the same refusal the transport's
      // `servedProviderSlug` makes about the same word.
      openTurnMock.mockResolvedValue(fakeTurn({
        home,
        model: "gpt-5.6-sol",
        bills: [{ model: "gpt-5.6-sol", provider: "custom" }],
      }));

      const done = await doneEvent(await POST(post({ message: "which model are you" })));

      expect(done).toMatchObject({ model: "gpt-5.6-sol" });
      expect(done).not.toHaveProperty("provider");
    });

    it("says nothing for a recorded id that could not be a provider id", async () => {
      // It is about to be persisted and rendered, so it is charset-checked like
      // any other provider id even though it came from the box's own store.
      openTurnMock.mockResolvedValue(fakeTurn({
        home,
        model: "gpt-5.6-sol",
        bills: [{ model: "gpt-5.6-sol", provider: "--provider=evil" }],
      }));

      const done = await doneEvent(await POST(post({ message: "which model are you" })));

      expect(done).toMatchObject({ model: "gpt-5.6-sol" });
      expect(done).not.toHaveProperty("provider");
    });

    it("leaves a request that DID name a provider alone, so the transport's refusal still stands", async () => {
      // The transport declines to confirm a provider the turn did not establish
      // — a canonical request against a session reporting the KIND `custom`. That
      // silence is deliberate and the billing record must not talk over it: this
      // fix answers only where nobody asked for a provider at all.
      modelOptionsMock.mockReturnValue(catalogue("anthropic", ["claude-fable-5"]));
      openTurnMock.mockResolvedValue(fakeTurn({
        home,
        model: "claude-fable-5",
        bills: [{ model: "claude-fable-5", provider: "openai-codex" }],
      }));

      const done = await doneEvent(
        await POST(post({ message: "hi", provider: "anthropic", model: "claude-fable-5" })),
      );

      expect(done).toMatchObject({ model: "claude-fable-5" });
      expect(done).not.toHaveProperty("provider");
    });
  },
);
