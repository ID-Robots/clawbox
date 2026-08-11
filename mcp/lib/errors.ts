// The ClawBox MCP error vocabulary.
//
// WHY a fixed, tiny code set: the agent branches on `code`, not on English.
// A 4-8B local model cannot reliably decode "API 502: {\"error\":\"Install
// failed\"}", but it can follow "CONFLICT / do not retry / tell the user".
//
// WHY no `details` field and no stack: this process reads untrusted web and
// email content, and its errors are rendered straight back into the model's
// context. A stack frame or an upstream body leaks absolute paths, the hermes
// binary location, and occasionally a token echoed back by an upstream error.
// Every string that leaves this module passes through scrubPaths() + redact().

const CLAWBOX_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const HOME_DIR = process.env.HOME || "/home/clawbox";

export type ToolErrorCode =
  | "AUTH_FAILED"
  | "BAD_ARGUMENT"
  | "BLOCKED_PATH"
  | "NOT_FOUND"
  | "NOT_SUPPORTED_HERE"
  | "ENDPOINT_DOWN"
  | "TIMEOUT"
  | "CONFLICT"
  | "TOO_LARGE"
  | "DANGEROUS_COMMAND"
  | "INTERNAL";

/** The only error type a tool handler should throw deliberately. */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly next: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * A non-2xx from /setup-api/*. INTERNAL to the MCP: it never reaches the agent
 * unmapped — api() converts it via the caller's per-route rules, and anything
 * unmapped falls through to the generic status mapping in classifyError().
 */
export class ApiError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`API ${status}`);
    this.name = "ApiError";
  }
}

/** A shell command the pre-flight denylist refused. */
export class DangerousCommandError extends Error {
  constructor(readonly blocked: string[]) {
    super(`Command blocked: ${blocked.join("; ")}`);
    this.name = "DangerousCommandError";
  }
}

// ── Scrubbing ────────────────────────────────────────────────────────────────

/** Replace on-device absolute paths with stable placeholders. */
export function scrubPaths(text: string): string {
  let out = text;
  // Longest first: CLAWBOX_ROOT is under HOME_DIR.
  out = out.split(CLAWBOX_ROOT).join("<clawbox>");
  out = out.split(HOME_DIR).join("~");
  out = out.replace(/\/home\/[A-Za-z0-9._-]+/g, "~");
  // Interpreter/library internals (python tracebacks, node stacks) say nothing
  // useful to the agent and reveal the install layout.
  out = out.replace(/\S*\/(?:site-packages|dist-packages|node_modules)\/\S*/g, "<internal>");
  return out;
}

// `token: abc`, `api_key=abc`, `Authorization: Bearer abc`.
const LABELLED_SECRET_RE =
  /((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|bearer|authorization)["'\s]*[:=]["'\s]*)(\S+)/gi;
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi;
// The MCP bearer and the ClawBox AI device token are long hex/base64 blobs.
const LONG_HEX_RE = /\b[0-9a-f]{32,}\b/gi;

/** Blank out anything that looks like a credential. */
export function redact(text: string): string {
  return text
    .replace(LABELLED_SECRET_RE, (_m, label: string) => `${label}[REDACTED]`)
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(LONG_HEX_RE, "[REDACTED]");
}

/** The one sanitiser every outbound string goes through. */
export function sanitize(text: string): string {
  return redact(scrubPaths(text));
}

// ── Per-route mapping ────────────────────────────────────────────────────────

/**
 * A rule turning one known upstream failure into an instruction. `match` is
 * tested against the response body, so two 502s with different bodies (a
 * resolver miss vs a failed security scan) can give the agent different advice.
 */
export interface ErrorRule {
  status?: number;
  match?: RegExp;
  code: ToolErrorCode;
  message: string;
  next: string;
}

/** Apply the caller's rules to an ApiError; returns null when none matched. */
export function matchRule(err: ApiError, rules: ErrorRule[] | undefined): ToolError | null {
  if (!rules) return null;
  for (const rule of rules) {
    if (rule.status !== undefined && rule.status !== err.status) continue;
    if (rule.match && !rule.match.test(err.body)) continue;
    return new ToolError(rule.code, rule.message, rule.next);
  }
  return null;
}

// ── Classification ───────────────────────────────────────────────────────────

function fromApiError(err: ApiError): ToolError {
  if (err.status === 401 || err.status === 403) {
    return new ToolError(
      "AUTH_FAILED",
      "The ClawBox API rejected this request.",
      "Call clawbox_health; if it reports the token missing, tell the user the device needs a restart.",
    );
  }
  if (err.status === 404) {
    return new ToolError(
      "NOT_FOUND",
      "That ClawBox endpoint is not available on this device.",
      "Call device_status to see which edition this device runs, then use a tool that exists there.",
    );
  }
  if (err.status === 409) {
    return new ToolError(
      "CONFLICT",
      "The device refused this change in its current state.",
      "Do not retry. Tell the user what you tried and ask them to finish the setup in Settings.",
    );
  }
  if (err.status === 400 || err.status === 422) {
    return new ToolError(
      "BAD_ARGUMENT",
      "The device rejected one of the arguments.",
      "Re-read this tool's parameter descriptions and call it once more with a valid value.",
    );
  }
  if (err.status === 413) {
    return new ToolError("TOO_LARGE", "The request was too large.", "Send less data.");
  }
  return new ToolError(
    "ENDPOINT_DOWN",
    "The ClawBox service did not complete this request.",
    "Call clawbox_health, then retry once. If it fails again, tell the user.",
  );
}

/** Normalise anything thrown inside a tool into a ToolError. */
export function classifyError(err: unknown, toolName: string): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof ApiError) return fromApiError(err);
  if (err instanceof DangerousCommandError) {
    return new ToolError(
      "DANGEROUS_COMMAND",
      `This command is blocked: ${err.blocked.join("; ")}.`,
      "Do not retry it. Ask the user to confirm exactly what they want removed or changed.",
    );
  }
  if (err instanceof Error) {
    const m = err.message.toLowerCase();
    if (m.includes("abort") || m.includes("timed out") || m.includes("timeout")) {
      return new ToolError(
        "TIMEOUT",
        "The operation took too long and was stopped.",
        "Retry once with a narrower request. If it times out again, tell the user.",
      );
    }
    if (m.includes("econnrefused") || m.includes("enotfound") || m.includes("fetch failed")) {
      return new ToolError(
        "ENDPOINT_DOWN",
        "The ClawBox service is not answering.",
        "Call clawbox_health to see what is down, then tell the user.",
      );
    }
  }
  // Terminal state: whatever this was, the agent cannot fix it by retrying.
  return new ToolError(
    "INTERNAL",
    `Internal error in ${toolName}.`,
    "Call clawbox_health; if it reports healthy, report this to the user and do not retry.",
  );
}

export interface ToolErrorEnvelope {
  error: true;
  code: ToolErrorCode;
  message: string;
  next: string;
}

/** The single text block an errored tool returns. */
export function toolErrorResult(err: unknown, toolName: string) {
  const e = classifyError(err, toolName);
  const envelope: ToolErrorEnvelope = {
    error: true,
    code: e.code,
    message: sanitize(e.message),
    next: sanitize(e.next),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
    isError: true as const,
  };
}
