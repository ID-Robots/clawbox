import { splitAssistantMedia } from "@/lib/chat-media";
import { HERMES_AUTO_PROVIDER, hermesProviderLabel } from "@/lib/hermes-providers";
import {
  asHarnessError,
  HarnessError,
  type FetchLike,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessStatus,
  type HistoryPage,
  type TurnEvent,
  type TurnRequest,
  type TurnResult,
} from "./transport";

/**
 * The Hermes side of the transport: one HTTP turn per message, threaded by a
 * session id the box echoes back.
 *
 * This adapter OWNS the three refs that used to sit in the chat component —
 * the resumed session id and the provider/model the last turn actually ran on.
 * All three describe "what the transport did last", which is why keeping them
 * in the component is what made the new-chat reset a component-level patch in
 * the first place: the button had to reach into transport state to clear it.
 * Here, "start a new chat" is one method call.
 */

/** What the chat header knows that a turn needs, read at send time. */
export interface HermesTurnContext {
  /**
   * The device's own configured pairing (`config.yaml` model.provider /
   * model.default). It is the floor: the only pairing that may be assumed
   * without a live model list.
   */
  devicePairing: { provider: string; model: string };
  /** Whether the selected provider's model list has arrived yet. */
  modelsReady: boolean;
}

const CHAT_ROUTE = "/setup-api/hermes/chat";

export class HermesAdapter implements HarnessAdapter {
  readonly id = "hermes" as const;

  /**
   * The Hermes session this chat is threaded through. Empty until the first
   * reply reports one; every later turn resumes it, which is what gives the
   * conversation memory.
   */
  private sessionId = "";
  /**
   * What the LAST turn actually ran on. A resumed session keeps the system
   * prompt it was created with, so after a switch the agent would still answer
   * "What model are you?" with the old one (and echo its earlier claims from
   * the transcript) even though the turn is genuinely routed to the new
   * provider. Comparing against these lets the next turn state the change
   * rather than discarding the conversation to get a fresh system prompt.
   */
  private sentProvider = "";
  private sentModel = "";
  /** The in-flight turn, so Stop can abort it. */
  private inFlight: AbortController | null = null;
  private readonly statusListeners = new Set<(s: HarnessStatus, detail?: string) => void>();

  constructor(
    readonly capabilities: HarnessCapabilities,
    private readonly context: () => HermesTurnContext,
    /** See the note on the gateway adapter: the narrow call, not `typeof fetch`. */
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  /**
   * There is nothing to hold open, so this reports connected and resolves.
   *
   * The chat used to do exactly this inline, and it read as a lie: a component
   * that says "connected" with no socket behind it. It is the same answer here,
   * but it is now the adapter's answer and it comes with
   * `capabilities.hasLiveConnection === false`, which tells the UI not to
   * render a connection banner at all rather than to render a green one about
   * a wire that does not exist.
   */
  async connect(): Promise<void> {
    this.emit("connected");
  }

  disconnect(): void {
    this.inFlight?.abort();
    this.inFlight = null;
  }

  onStatus(cb: (status: HarnessStatus, detail?: string) => void): () => void {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  private emit(status: HarnessStatus, detail?: string) {
    for (const cb of this.statusListeners) cb(status, detail);
  }

  async sendTurn(req: TurnRequest, _onEvent?: (event: TurnEvent) => void): Promise<TurnResult> {
    // Nothing to stream: the route runs `hermes chat -q … -Q` and hands back
    // the whole reply. `capabilities.streamsTurns` says so, so a caller that
    // wants deltas has already been told it will not get any.
    void _onEvent;
    const controller = new AbortController();
    this.inFlight = controller;
    const abortFromCaller = () => controller.abort();
    // A signal that is ALREADY aborted never fires its event again, so a Stop
    // that landed between building the turn and sending it would otherwise be
    // ignored and the request would go out anyway.
    if (req.signal?.aborted) controller.abort();
    else req.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const provider = req.provider ?? "";
    const model = req.model ?? "";
    const reasoning = req.reasoning ?? "";
    const ctx = this.context();
    try {
      if (provider && provider !== HERMES_AUTO_PROVIDER && !model && provider !== ctx.devicePairing.provider) {
        // Sending --provider without -m makes hermes fall back to config.yaml's
        // model.default, which belongs to the CONFIGURED provider — i.e. it
        // would run this provider against another one's model id. The route
        // rejects that too (409); catching it here turns a raw error into an
        // actionable one instead of burning a turn.
        throw new HarnessError(
          "invalid-input",
          ctx.modelsReady
            ? `No models are available for ${hermesProviderLabel(provider)} on this device. ` +
              "Add credentials for it in Settings, or pick another provider."
            : `Still loading ${hermesProviderLabel(provider)}'s models — try again in a moment.`,
        );
      }
      // Announce a mid-conversation switch. Only when we are RESUMING (a fresh
      // session already gets a correct system prompt) and only when something
      // actually changed, so a normal turn carries no extra text.
      const switched =
        Boolean(this.sessionId) &&
        (this.sentProvider !== provider || this.sentModel !== model) &&
        Boolean(this.sentProvider || this.sentModel);
      const outbound = switched
        ? `[System note: this conversation has just been switched to model "${model || "the provider default"}" ` +
          `via provider "${hermesProviderLabel(provider)}". You are now that model — disregard any earlier ` +
          `statement in this conversation about which model you are. Keep the conversation and its context.]\n\n` +
          req.text
        : req.text;
      const res = await this.fetchImpl(CHAT_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: outbound,
          ...(model ? { model } : {}),
          ...(provider ? { provider } : {}),
          ...(reasoning ? { reasoning } : {}),
          // Continue this conversation instead of starting a fresh agent every
          // turn — otherwise a follow-up like "is it removed now?" reaches an
          // agent with no idea what "it" is.
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new HarnessError(
          res.status === 409 || res.status === 400 ? "invalid-input" : "upstream",
          typeof data?.error === "string" && data.error ? data.error : "Hermes chat failed",
        );
      }
      if (typeof data.sessionId === "string" && data.sessionId) {
        this.sessionId = data.sessionId;
      }
      // Record what this turn ran on, so the NEXT one only announces a switch
      // if something really changed. Set after success: a failed turn didn't
      // establish anything, and the announcement should survive to be made.
      this.sentProvider = provider;
      this.sentModel = model;
      // Same MEDIA: split as the gateway path, so a picture renders the same
      // way whichever edition answered.
      const reply = splitAssistantMedia(typeof data.text === "string" ? data.text : "");
      return { text: reply.text, media: reply.images, audio: reply.audio };
    } catch (err) {
      throw asHarnessError(err, "upstream");
    } finally {
      req.signal?.removeEventListener("abort", abortFromCaller);
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  /** Aborting the fetch makes the route see `request.signal` fire, which kills
   *  the child process and answers 499. Already wired end to end. */
  async abortTurn(): Promise<void> {
    this.inFlight?.abort();
  }

  /**
   * Forgetting the resumed session id IS the reset.
   *
   * The next message goes out with no `--resume`, so `hermes chat -q` opens a
   * fresh session on the box and the agent genuinely does not have the old
   * conversation. The provider/model the last turn ran on go with it: they
   * describe the conversation that just ended, and a stale pair would make the
   * first turn of the new one announce a "switch" that never happened.
   *
   * Idempotent, and never rejects — the (+) button is double-clickable, and
   * there is no request here that could fail.
   */
  async resetSession(): Promise<void> {
    this.sessionId = "";
    this.sentProvider = "";
    this.sentModel = "";
  }

  async loadHistory(): Promise<HistoryPage> {
    throw new HarnessError(
      "unsupported",
      "This box does not keep a chat transcript across refreshes yet.",
    );
  }

  async patchSessionDefaults(_patch: { thinkingLevel?: string | null }): Promise<void> {
    void _patch;
    // Hermes carries its reasoning level on the turn itself
    // (`capabilities.reasoningScope === 'per-turn'`), so there is nothing
    // sticky to patch. Never called: `canPatchSessionDefaults` is false and
    // `shouldPatchSessionDefaults` checks it first.
    throw new HarnessError("unsupported", "This harness has no sticky session defaults.");
  }

  /** Test seam: the session id this chat is currently threaded through. */
  get threadedSessionId(): string {
    return this.sessionId;
  }
}
