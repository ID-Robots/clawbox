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
