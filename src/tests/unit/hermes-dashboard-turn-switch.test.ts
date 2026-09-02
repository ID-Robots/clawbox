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
  let settled = false;
  const opening = openDashboardTurn({
    text: "Hey",
    model: "deepseek-v4-flash",
    provider: "clawai",
    ...overrides,
  }).then((handle) => {
    settled = true;
    return handle;
  });
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
  // Answer the RPCs the open makes after the session reply, the way the box
  // answers them: a mid-conversation model switch, and the `config.set` that
  // puts the reasoning level back afterwards. BOTH are awaited by
  // `openDashboardTurn`, so a helper that left either unanswered would park the
  // open on its own timeout rather than testing anything.
  //
  // Stops the moment the open settles rather than spinning a fixed count. The
  // module's own waits carry REAL deadlines (15s for a session call, 20s for a
  // switch), so every needless turn of this loop is another chance for a
  // loaded machine to reach one of them and fail a test for a reason that has
  // nothing to do with what it asserts.
  const answered = new Set<unknown>();
  for (let i = 0; i < 200 && !settled; i++) {
    await Promise.resolve();
    for (const sent of socket.sent) {
      if (answered.has(sent.id)) continue;
      if (sent.method === "slash.exec") {
        answered.add(sent.id);
        if (switchReply === "ok") {
          socket.deliver({ jsonrpc: "2.0", id: sent.id, result: { output: "  ✓ Model switched" } });
        } else if (switchReply === "refused") {
          socket.deliver({ jsonrpc: "2.0", id: sent.id, error: { message: "session busy" } });
        } else {
          // Verbatim from the box: a reply with no `error` member anywhere that
          // is nonetheless a refusal.
          socket.deliver({
            jsonrpc: "2.0",
            id: sent.id,
            result: {
              output: "  ✗ Model `deepseek-v4-flash` was not found in this provider's model listing.",
              warning:
                "live session sync failed: Model `deepseek-v4-flash` was not found in this provider's model listing.",
            },
          });
        }
      } else if (sent.method === "config.set") {
        answered.add(sent.id);
        socket.deliver({ jsonrpc: "2.0", id: sent.id, result: { ok: true } });
      }
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

describe("putting the reasoning level back after a switch takes it away", () => {
  /**
   * Measured on the live box, one session, three steps with nothing else sent
   * in between: `session.create` with `reasoning_effort: "medium"` reported
   * `medium`; the very next `/model claude-fable-5 --provider anthropic
   * --session` reported `""`.
   *
   * That empty string is the whole of the missing-thinking bug. Anthropic with
   * no effort set returns SIGNATURE-ONLY thinking blocks —
   * `{"type":"thinking","thinking":"","signature":"…"}` — so `state.db` stores
   * a `reasoning_details` blob with no text in it and leaves `reasoning` and
   * `reasoning_content` NULL. The capture was never broken; the LEVEL was
   * being thrown away, on every turn where the customer's pills caused a
   * switch.
   */
  it("re-asserts the level the switch just cleared, AFTER the switch", async () => {
    const { turn, socket } = await connect({
      sessionId: "20260823_185842_1eabd5",
      model: "claude-fable-5",
      provider: "anthropic",
      reasoning: "medium",
    });
    const switchAt = socket.sent.findIndex((f) => f.method === "slash.exec");
    const effortAt = socket.sent.findIndex((f) => f.method === "config.set");
    expect(switchAt).toBeGreaterThanOrEqual(0);
    // Order is the property, not merely presence: sent BEFORE the switch, the
    // rebuild would wipe it again and the turn would run at no effort anyway.
    expect(effortAt).toBeGreaterThan(switchAt);
    expect(socket.sent[effortAt].params).toEqual({
      // The TRANSPORT handle — the live session the prompt is about to go to.
      session_id: "e0719549",
      key: "reasoning",
      value: "medium",
      scope: "session",
    });
    expect(turn).not.toBeNull();
  });

  it("writes it at SESSION scope and never at the box default", async () => {
    // The same safety property `--session` carries for the model. Upstream's
    // own comment on the global branch is that writing there "let every desktop
    // model-menu selection rewrite the user's global agent.reasoning_effort";
    // a chat turn that did it would change the effort for Telegram, for cron,
    // and for the owner's own dashboard tab, and would write config.yaml to do
    // it.
    const { socket } = await connect({
      sessionId: "20260823_185842_1eabd5",
      model: "claude-fable-5",
      provider: "anthropic",
      reasoning: "high",
    });
    const params = socket.method("config.set")?.params as Record<string, unknown>;
    expect(params.scope).toBe("session");
    expect(params.scope).not.toBe("global");
    expect(params).not.toHaveProperty("global");
    expect(params.session_id).toBe("e0719549");
  });

  it("sends nothing when the turn asked for no reasoning at all", async () => {
    // Most providers have no reasoning dial and the picker offers none. Setting
    // a level nobody asked for would be this route inventing a setting.
    const { socket } = await connect({
      sessionId: "20260823_185842_1eabd5",
      model: "claude-fable-5",
      provider: "anthropic",
    });
    expect(socket.method("slash.exec")).toBeDefined();
    expect(socket.method("config.set")).toBeUndefined();
  });

  it("leaves a session that already reports the asked-for level alone", async () => {
    // Nothing was wiped, so there is nothing to repair, and every RPC on the
    // open is latency the customer waits through before the first token.
    const { socket } = await connect(
      { sessionId: "20260823_185842_1eabd5", model: "deepseek-v4-flash", provider: "clawai", reasoning: "medium" },
      { model: "deepseek-v4-flash", provider: "custom", reasoning_effort: "medium" },
    );
    expect(socket.method("slash.exec")).toBeUndefined();
    expect(socket.method("config.set")).toBeUndefined();
  });
});

/**
 * HERMES-05 — what the turn reports as the provider that served it.
 *
 * The dashboard names a user-defined provider by its KIND (`custom`), never
 * its slug — the fixtures above carry exactly that shape for clawai. On a
 * resumed turn that needs no switch the transport used to hand that kind
 * straight through as the served provider, the route persisted it, and the
 * bubble read "custom · deepseek-v4-flash" from the second turn on, for the
 * shipped default provider. A kind is not a provider; only a slug is.
 */
describe("the provider a turn reports as having served it", () => {
  it("is the requested slug on a resumed turn the session was already on, never the dashboard's kind", async () => {
    const { turn, socket } = await connect({ sessionId: "20260823_185842_1eabd5" });
    expect(socket.method("slash.exec")).toBeUndefined();
    expect(turn?.model).toBe("deepseek-v4-flash");
    expect(turn?.provider).toBe("clawai");
  });

  it("is a canonical slug the dashboard reports, as is", async () => {
    const { turn, socket } = await connect(
      { sessionId: "20260823_185842_1eabd5", model: "claude-fable-5", provider: "anthropic" },
      { model: "claude-fable-5", provider: "anthropic" },
    );
    expect(socket.method("slash.exec")).toBeUndefined();
    expect(turn?.provider).toBe("anthropic");
  });

  it("is unknown, not the kind, when nothing was requested and the dashboard names only a kind", async () => {
    const { turn } = await connect({ model: undefined, provider: undefined });
    expect(turn?.model).toBe("deepseek-v4-flash");
    expect(turn?.provider ?? "").toBe("");
  });

  it("is unknown when the request's canonical slug contradicts the session's kind", async () => {
    // Same model id, different provider: the switch is skipped on the model id
    // alone (see the transport), so the session is still on whatever
    // user-defined provider `custom` stands for — not on the one requested.
    const { turn, socket } = await connect(
      { sessionId: "20260823_185842_1eabd5", model: "deepseek-v4-flash", provider: "anthropic", providerIsUserDefined: false },
      { model: "deepseek-v4-flash", provider: "custom" },
    );
    expect(socket.method("slash.exec")).toBeUndefined();
    expect(turn?.provider ?? "").toBe("");
  });

  it("resolves the kind to a user-defined slug the allowlist has never heard of", async () => {
    // clawlocal is registered on the box, not in Hermes' captured registry;
    // the catalogue's flag, not the allowlist, is what says it is user-defined.
    const { turn } = await connect(
      { sessionId: "20260823_185842_1eabd5", model: "gemma", provider: "clawlocal", providerIsUserDefined: true },
      { model: "gemma", provider: "custom" },
    );
    expect(turn?.provider).toBe("clawlocal");
  });

  it("keeps `custom` on a session this turn built for Hermes' literal custom provider", async () => {
    // `custom` is a real CLI slug as well as the dashboard's kind for every
    // user-defined provider. A session.create with `provider: custom` is on
    // the literal one by contract.
    const { turn } = await connect(
      { model: "my-model", provider: "custom" },
      { model: "my-model", provider: "custom" },
    );
    expect(turn?.provider).toBe("custom");
  });

  it("never asserts the literal `custom` provider on a resumed session the dashboard calls `custom`", async () => {
    // The session may be on clawai (kind `custom`) serving the same model id;
    // a request for the literal `custom` provider skips the switch on the
    // model id alone, and nothing can tell the two apart. Unknown, not wrong.
    const { turn, socket } = await connect(
      { sessionId: "20260823_185842_1eabd5", model: "my-model", provider: "custom" },
      { model: "my-model", provider: "custom" },
    );
    expect(socket.method("slash.exec")).toBeUndefined();
    expect(turn?.provider ?? "").toBe("");
  });

  it("does not let a completion that names no provider reinstate a request the session contradicted", async () => {
    const { turn, socket } = await connect(
      { sessionId: "20260823_185842_1eabd5", model: "deepseek-v4-flash", provider: "anthropic", providerIsUserDefined: false },
      { model: "deepseek-v4-flash", provider: "custom" },
    );
    expect(turn?.provider ?? "").toBe("");
    const running = turn!.run(() => {});
    await Promise.resolve();
    socket.event("message.complete", { text: "one", status: "complete" });
    const final = await running;
    expect(final.provider ?? "").toBe("");
  });

  it("does not let a completion's own kind overwrite the resolved slug", async () => {
    const { turn, socket } = await connect({ sessionId: "20260823_185842_1eabd5" });
    const running = turn!.run(() => {});
    await Promise.resolve();
    socket.event("message.complete", { text: "one", status: "complete", provider: "custom" });
    const final = await running;
    expect(final.provider).toBe("clawai");
    expect(final.model).toBe("deepseek-v4-flash");
  });
});
