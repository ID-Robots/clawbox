import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two things the streaming transport got wrong for every model but the default.
 *
 * ── The pills stopped working after the first message ──────────────────────
 *
 * `session.create` takes model/provider/reasoning_effort as PER-SESSION
 * overrides, so the FIRST turn of a chat lands on the picked model.
 * `session.resume` takes none of them — upstream reads only `session_id`,
 * `cols`, `profile`, `defer_history`, `omit_messages` and the
 * `lazy`/`eager_build` flags out of its params — so every LATER turn ran on
 * whatever the conversation had been opened with, silently.
 *
 * Reproduced on the bench box before the fix: one session, three turns asking
 * "which exact model and provider is serving this turn?", with the pills moved
 * claude-fable-5 → gpt-5.6-sol → deepseek-v4-flash between them. All three
 * answered claude-fable-5 / anthropic, the third adding "same as before".
 *
 * The fix is upstream's own mechanism: `/model <id> --provider <slug> --session`,
 * the command the dashboard's own Chat tab runs when its picker changes.
 *
 * ── The spinner was being shown as the model's reasoning ────────────────────
 *
 * `thinking.delta` is the animated STATUS LINE. Upstream composes it as
 * `f"{face} {verb}..."` from a fixed kaomoji list and a fixed verb list
 * (agent/conversation_loop.py; vocabularies in agent/display.py), hands it to
 * `thinking_callback` — documented in run_agent.py as the live spinner/status
 * line — and the gateway bridges that callback straight to the event. It fires
 * for EVERY model, including ones that return no monologue at all, which is how
 * a kaomoji ended up in a customer's Reasoning disclosure.
 */

const ticketMock = vi.hoisted(() => vi.fn());

const fake = vi.hoisted(() => {
  const made: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    sent: Array<Record<string, unknown>> = [];
    closed = false;
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(readonly url: string) {
      made.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void) {
      const list = this.listeners.get(event) || [];
      list.push(cb);
      this.listeners.set(event, list);
      return this;
    }
    once(event: string, cb: (...args: unknown[]) => void) {
      const wrapped = (...args: unknown[]) => {
        this.off(event, wrapped);
        cb(...args);
      };
      return this.on(event, wrapped);
    }
    off(event: string, cb: (...args: unknown[]) => void) {
      const list = (this.listeners.get(event) || []).filter((f) => f !== cb);
      this.listeners.set(event, list);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const cb of [...(this.listeners.get(event) || [])]) cb(...args);
    }
    send(raw: string) {
      this.sent.push(JSON.parse(raw) as Record<string, unknown>);
    }
    close() {
      this.closed = true;
    }
    open() {
      this.readyState = FakeSocket.OPEN;
      this.emit("open");
    }
    deliver(frame: unknown) {
      this.emit("message", JSON.stringify(frame));
    }
    event(type: string, payload: unknown) {
      this.deliver({ jsonrpc: "2.0", method: "event", params: { type, payload } });
    }
    method(name: string) {
      return this.sent.find((f) => f.method === name);
    }
  }
  return { made, FakeSocket };
});

type FakeSocket = InstanceType<typeof fake.FakeSocket>;

vi.mock("ws", () => ({ WebSocket: fake.FakeSocket }));
vi.mock("@/lib/hermes-dashboard-auth", () => ({
  dashboardWsTicket: ticketMock,
  DASHBOARD_WS_ORIGIN: "ws://127.0.0.2:9119",
}));

import { openDashboardTurn, resetHermesStreamProbe } from "@/lib/hermes-dashboard-turn";

/** The kaomoji faces upstream picks from, as they reach the wire. */
const STATUS_FRAMES = [
  "(⌐■_■) computing...",
  "(°ロ°) cogitating...",
  "( ˘⌣˘)♡ cogitating...",
  "(◔_◔) musing...",
];

async function latest(): Promise<FakeSocket> {
  for (let i = 0; i < 50 && fake.made.length === 0; i++) await Promise.resolve();
  return fake.made[fake.made.length - 1];
}

/**
 * Open a turn, answering the handshake and the session RPC as the box does.
 *
 * `info` is part of the box's real answer — a live `session.resume` returns
 * `{model, provider, reasoning_effort, …}` — and defaults to the model the
 * request asks for, so an ordinary turn needs no switch. A test that wants the
 * switch passes an `info` naming a DIFFERENT model, which is exactly what a
 * session opened on one model and re-pointed at another looks like from here.
 */
async function connect(
  overrides: Record<string, unknown> = {},
  info: Record<string, unknown> | null = { model: "deepseek-v4-flash", provider: "custom" },
  switchReply: "ok" | "refused" | "soft-refused" = "ok",
) {
  const opening = openDashboardTurn({ text: "Hey", model: "deepseek-v4-flash", provider: "clawai", ...overrides });
  const socket = await latest();
  socket.open();
  await Promise.resolve();
  socket.event("gateway.ready", {});
  await Promise.resolve();
  socket.deliver({
    jsonrpc: "2.0",
    id: 1,
    result: {
      session_id: "e0719549",
      stored_session_id: (overrides.sessionId as string) || "20260823_190319_3e9e35",
      ...(info ? { info } : {}),
    },
  });
  // Answer a mid-conversation switch the way the dashboard answers it.
  for (let i = 0; i < 60; i++) {
    await Promise.resolve();
    const sw = socket.sent.find((f) => f.method === "slash.exec");
    if (sw) {
      if (switchReply === "ok") {
        socket.deliver({ jsonrpc: "2.0", id: sw.id, result: { output: "  ✓ Model switched" } });
      } else if (switchReply === "refused") {
        socket.deliver({ jsonrpc: "2.0", id: sw.id, error: { message: "session busy" } });
      } else {
        // Verbatim from the box: a reply with no `error` member anywhere that
        // is nonetheless a refusal.
        socket.deliver({
          jsonrpc: "2.0",
          id: sw.id,
          result: {
            output: "  ✗ Model `deepseek-v4-flash` was not found in this provider's model listing.",
            warning:
              "live session sync failed: Model `deepseek-v4-flash` was not found in this provider's model listing.",
          },
        });
      }
      break;
    }
  }
  return { turn: await opening, socket };
}

beforeEach(() => {
  fake.made.length = 0;
  ticketMock.mockReset();
  ticketMock.mockResolvedValue("a-ticket");
  resetHermesStreamProbe();
});

describe("carrying the picked model onto a conversation already in progress", () => {
  it("re-points a resumed session at the newly picked model", async () => {
    const { turn, socket } = await connect({
      sessionId: "20260823_185842_1eabd5",
      model: "claude-fable-5",
      provider: "anthropic",
    });
    const switched = socket.method("slash.exec");
    expect(switched).toBeDefined();
    expect(switched?.params).toMatchObject({
      // The TRANSPORT handle, not the durable id — the switch acts on the live
      // session the prompt is about to be submitted to.
      session_id: "e0719549",
      command: "/model claude-fable-5 --provider anthropic --session",
    });
    expect(turn?.model).toBe("claude-fable-5");
    expect(turn?.provider).toBe("anthropic");
  });

  it("scopes the switch to the session and never to the box default", async () => {
    // `--session` is the whole safety property: `resolve_persist_behavior`
    // returns false for it, so config.yaml is untouched and — upstream's own
    // words — the choice cannot leak "into every OTHER live session's next
    // agent rebuild". A chat turn that changed the device default would change
    // the model for Telegram, for cron, and for the owner's dashboard tab.
    const { socket } = await connect({
      sessionId: "20260823_185842_1eabd5",
      model: "claude-fable-5",
      provider: "anthropic",
    });
    const command = String((socket.method("slash.exec")?.params as Record<string, unknown>).command);
    expect(command).toContain("--session");
    expect(command).not.toContain("--global");
    expect(command).not.toContain("--once");
  });

  it("does not pay for a switch when the session already runs that model", async () => {
    // The switch rebuilds the agent's client — ~3.3s measured on the bench box,
    // most of a fast turn. Re-asserting it every turn would hand back the whole
    // speed win this transport exists for.
    const { socket } = await connect({
      sessionId: "20260823_185842_1eabd5",
      model: "deepseek-v4-flash",
      provider: "clawai",
    });
    expect(socket.method("slash.exec")).toBeUndefined();
  });

  it("switches rather than assumes when the dashboard did not say", async () => {
    // Silence is not proof. Without a reported model we cannot show the session
    // is already right, and answering on the wrong one is the failure being
    // fixed — so the switch is made.
    const { socket } = await connect(
      { sessionId: "20260823_185842_1eabd5", model: "claude-fable-5", provider: "anthropic" },
      null,
    );
    expect(socket.method("slash.exec")).toBeDefined();
  });

  it("gives this transport up when the switch is refused outright", async () => {
    // Null is the caller's signal to spawn the CLI, which passes -m/--provider
    // as argv to a fresh process and is proven to run both correctly. Slower and
    // unstreamed beats answering as a model the customer did not pick.
    const { turn, socket } = await connect(
      { sessionId: "20260823_185842_1eabd5", model: "claude-fable-5", provider: "anthropic" },
      { model: "deepseek-v4-flash", provider: "custom" },
      "refused",
    );
    expect(socket.method("slash.exec")).toBeDefined();
    expect(turn).toBeNull();
  });

  it("reads a refusal that arrives inside a SUCCESSFUL reply", async () => {
    // The shape that actually occurs on the box, and the bug this had: no
    // `error` member anywhere, the refusal carried in `warning` with an output
    // opening on the failure marker. Reading only the JSON-RPC envelope counted
    // that as a switch and reported a model the session was never running.
    //
    // The real case is switching TO a user-defined provider: the switch
    // validates the model against the target provider's listing, and a
    // `providers.<slug>` entry in config.yaml carries none. On this device that
    // is `clawai` — the box default — so customers do reach it.
    const { turn } = await connect(
      { sessionId: "20260823_185842_1eabd5", model: "deepseek-v4-flash", provider: "clawai" },
      { model: "gpt-5.6-sol", provider: "openai-codex" },
      "soft-refused",
    );
    expect(turn).toBeNull();
  });

  it("refuses to put an unsafe id on the command line", async () => {
    // The switch is a command STRING the gateway parses into flags, so a value
    // carrying whitespace could add its own -- and the one it would reach for
    // is `--global`, which writes config.yaml and changes the model for every
    // other session, for Telegram and for cron. The route charset-checks both
    // values already; this module must not rely on that.
    const { turn, socket } = await connect({
      sessionId: "20260823_185842_1eabd5",
      model: "claude-fable-5 --global",
      provider: "anthropic",
    });
    expect(socket.method("slash.exec")).toBeUndefined();
    expect(turn).toBeNull();
  });

  it("leaves a FRESH session to the create call, which already takes the override", async () => {
    // Nothing to re-point: `session.create` builds the agent with the model in
    // its own params, so a switch here would be another 3.3s for no change.
    const { turn, socket } = await connect({ model: "claude-fable-5", provider: "anthropic" });
    expect(socket.method("slash.exec")).toBeUndefined();
    expect(socket.method("session.create")?.params).toMatchObject({
      model: "claude-fable-5",
      provider: "anthropic",
    });
    expect(turn?.model).toBe("claude-fable-5");
  });

  it("still carries the override on the create call for every provider", async () => {
    // The regression guard for the original complaint: whatever the pills say,
    // the handshake carries it. A provider that never reached the socket was a
    // provider whose turns quietly ran on the box default.
    for (const [model, provider] of [
      ["claude-fable-5", "anthropic"],
      ["gpt-5.6-sol", "openai-codex"],
      ["hy3-free", "opencode-free"],
      ["deepseek-v4-flash", "clawai"],
    ]) {
      fake.made.length = 0;
      const { socket } = await connect({ model, provider });
      expect(socket.method("session.create")?.params).toMatchObject({ model, provider });
    }
  });
});

describe("the agent's spinner is not the model's reasoning", () => {
  it("keeps reasoning.delta and drops thinking.delta", async () => {
    const { turn, socket } = await connect();
    const running = turn!.run(() => {});
    await Promise.resolve();
    socket.event("thinking.delta", { text: STATUS_FRAMES[0] });
    socket.event("reasoning.delta", { text: "The user asked for one word." });
    socket.event("thinking.delta", { text: STATUS_FRAMES[1] });
    await Promise.resolve();
    socket.event("message.complete", { text: "one", status: "complete" });
    const final = await running;
    expect(final.reasoning).toBe("The user asked for one word.");
    expect(final.reasoning).not.toContain("computing");
    expect(final.reasoning).not.toContain("cogitating");
  });

  it("ends with NO reasoning when the model did none", async () => {
    // The claude-fable-5 case measured on the box: real reasoning empty, spinner
    // still ticking. The turn must finish with an empty string so the route
    // omits the field entirely — an empty disclosure reads worse than none.
    const { turn, socket } = await connect();
    const running = turn!.run(() => {});
    await Promise.resolve();
    socket.event("thinking.delta", { text: STATUS_FRAMES[2] });
    await Promise.resolve();
    socket.event("message.complete", { text: "one", status: "complete" });
    const final = await running;
    expect(final.reasoning).toBe("");
  });

  it("never forwards either channel onto the answer", async () => {
    const chunks: string[] = [];
    const { turn, socket } = await connect();
    const running = turn!.run((c) => chunks.push(c));
    await Promise.resolve();
    socket.event("thinking.delta", { text: STATUS_FRAMES[3] });
    socket.event("reasoning.delta", { text: "thinking out loud" });
    socket.event("message.delta", { text: "one" });
    await Promise.resolve();
    socket.event("message.complete", { text: "one", status: "complete" });
    await running;
    expect(chunks).toEqual(["one"]);
  });
});
