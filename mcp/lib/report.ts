// What a tool says about a value it could not actually read.
//
// The ClawBox MCP tools promise, in their own descriptions, that "any part that
// cannot be read reports \"unknown\" instead of failing the whole call". That
// promise is only kept if the fallback FIRES, and `??` does not fire for the
// value the device actually sends: /setup-api/hermes/models answers
// `{"provider":"","current":"","reasoning":""}` on a device where nothing has
// been configured yet, and `"" ?? "unknown"` is `""`.
//
// Live on a Hermes box, device_status returned `"provider": "", "model": ""` —
// and device_status is the tool the server's own instructions tell every model
// to call before it says anything about the device. A small model reading two
// blanks fills them in with a plausible-sounding model name; a small model
// reading "unknown" says it does not know.
//
// One helper, shared, so the next surface that reports a model does not have to
// rediscover this.

/** The value, or the literal string "unknown" when nothing was really reported. */
export function reported(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "unknown";
}

/** The `/setup-api/hermes/models` fields that make up the box's saved pairing. */
export interface HermesDefaultSource {
  provider?: string;
  current?: string;
  reasoning?: string;
}

/**
 * The device default as the tools report it: config.yaml's provider, model and
 * reasoning, blanks as "unknown". One place, because two tools emit it and a
 * route rename must not leave them disagreeing.
 */
export function hermesDeviceDefault(source: HermesDefaultSource | null | undefined) {
  return {
    provider: reported(source?.provider),
    model: reported(source?.current),
    thinking: reported(source?.reasoning),
  };
}

/**
 * What a tool says about the model answering the conversation it was called
 * from — which is nothing it can read: this process is one stdio child shared
 * by every Hermes session, started with a filtered environment (see
 * mcp/lib/profile.ts) and called with no session id. It reads config.yaml's
 * default, and the one time it reported that as "in use" the agent answered
 * "which model are you" with it, wrongly. So the default is named for what it
 * is, and the payload points at the record: the label the chat prints under a
 * reply whose model it knows.
 */
export const CURRENT_CHAT_MODEL_NOTE =
  "not visible here. device_default is what a new chat starts on; this chat may be on a per-session override no tool can read. Where the ClawBox chat knows the model that served a reply, it prints it under that reply.";
