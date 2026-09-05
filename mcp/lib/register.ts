// The registration wrapper every ClawBox tool goes through.
//
// It does four things no individual tool should have to remember:
//   1. EDITION GATING. A tool whose backing surface does not exist on this
//      edition is never registered. Hermes runs a per-server circuit breaker —
//      one chronically-404ing tool takes ALL ClawBox tools offline for the
//      agent — so hiding is an availability requirement, not politeness.
//   2. ANNOTATIONS. readOnlyHint is exactly what exempts a tool from an MCP
//      host's approval gate (Hermes' `trust: untrusted` fails CLOSED on a
//      missing annotation), and it is free on OpenClaw. Note what this does NOT
//      mean on a ClawBox: scripts/register-mcp.sh registers this server with
//      `trust: full`, because the appliance agent is headless and one-shot and a
//      prompt would hang the turn. So no gate runs here — the annotations are
//      for hosts that do enforce one, and the containment that actually applies
//      to a write tool on this device is its own per-tool guard.
//   3. OUTPUT CAPS, so a 10 MB stdout cannot be dumped into a small model's
//      context window.
//   4. THE ERROR ENVELOPE. Every throw becomes { error, code, message, next } —
//      no stack, no upstream body, no absolute path.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { capText } from "./guard";
import { ToolError, toolErrorResult } from "./errors";
import { PARAM_NAME_RE, TOOL_NAME_RE, type Shape } from "./schema";

export type Ed = "openclaw" | "hermes";
// What the SERVER runs as. `browser` is the coding-agent run profile: only
// tools declaring `family: "browser"` register, so a delegated run drives
// Chromium to verify its work without inheriting the assistant's device-wide
// tool set (email, power, files, …). Distinct from the per-tool declarations
// below — one axis is the server's mode, the other is what a tool claims.
export type Profile = "core" | "full" | "browser";

export interface ToolOpts {
  /** Editions this tool is registered on. Default: both. */
  editions?: Ed[];
  /** No state changes anywhere. */
  readOnly?: boolean;
  /** Removes or overwrites something the user cares about. */
  destructive?: boolean;
  /** Reaches the public internet. */
  openWorld?: boolean;
  /** "core" tools survive CLAWBOX_MCP_PROFILE=core. Default "full". */
  profile?: "core" | "full";
  /**
   * Tools declaring "browser" are the ONLY ones a `browser`-profile server
   * registers. A declaration, not a naming convention: a future tool that
   * happens to be named browser_something stays out of delegated runs unless
   * its author states it belongs there.
   */
  family?: "browser";
  /** Output cap in characters. Default 4000. */
  maxChars?: number;
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ContentPart[];
  isError?: boolean;
}

export interface RegisteredToolInfo {
  name: string;
  description: string;
  params: string[];
  /** Kept so mcp/check-tools.ts can measure the real tools/list payload. */
  shape: Shape;
  opts: ToolOpts;
}

export const DEFAULT_MAX_CHARS = 4_000;

/**
 * The cap for a tool whose answer is a LIST of what is on the device.
 *
 * 12,000 rather than the 6,000 `skill_list` and `ui_list_apps` carried since
 * they were written: measured against a real Hermes box (90 installed rows —
 * 82 bundled, 3 from the store, 5 made on the device — emitting 3,165
 * characters), the old cap left room for only 46 further store installs,
 * because #582 grew every store row by a third (the lock id leads and a
 * differing card name is spelled out). This covers a device with well over a
 * hundred, and matches the budget coding_agent_status already takes for a
 * comparable list. Both tools still bound their own rows against it (fitRows)
 * rather than letting capText slice the answer.
 */
export const LIST_MAX_CHARS = 12_000;
// An image bigger than this eats a small model's whole context window.
const MAX_IMAGE_BASE64 = 1024 * 1024;

// Both harnesses rewrite or flag these, and every one of them reads as an
// injected instruction when a tool description is spliced into a system prompt.
export const BANNED_DESCRIPTION_RE =
  /ignore (?:previous|prior) instructions|disregard|system prompt|<system>|do not tell|do not reveal|curl https:\/\/|exec\(|eval\(|import subprocess/i;

export const MAX_DESCRIPTION_CHARS = 1000;

export interface Registrar {
  tool(name: string, description: string, shape: Shape, opts: ToolOpts, handler: ToolHandler): void;
  list(): RegisteredToolInfo[];
  /** Must be called once, after every tool is registered. See installCallHandler(). */
  finalize(): void;
}

// One wrapper cannot express every tool's parsed-arg type; the zod shape
// validates at runtime and each handler narrows its own destructure.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolHandler = (args: any) => Promise<ToolResult> | ToolResult;

/**
 * Apply a tool's output cap, exactly as the dispatcher does before the result
 * reaches the agent. Exported so the test registrar can put a handler's return
 * value through the same gate — a suite that inspects the UNCAPPED string is
 * not looking at what the agent sees, and an output that outgrew its cap then
 * passes every assertion about it.
 */
export function capResult(result: ToolResult, maxChars: number): ToolResult {
  const content = result.content.map((part): ContentPart => {
    if (part.type === "text") return { type: "text", text: capText(part.text, maxChars) };
    if (part.data.length > MAX_IMAGE_BASE64) {
      // Dropping it beats truncating base64 (which decodes to garbage) and
      // beats blowing the context window.
      return {
        type: "text",
        text: "[image omitted: too large to return. Ask for a smaller region or a lower-resolution capture.]",
      };
    }
    return part;
  });
  return { ...result, content };
}

/**
 * Contract violations that must never ship. Returned rather than thrown so the
 * standalone checker (mcp/check-tools.ts) can report all of them at once.
 */
export function contractViolations(info: RegisteredToolInfo): string[] {
  const out: string[] = [];
  if (!TOOL_NAME_RE.test(info.name)) out.push(`name "${info.name}" fails ${TOOL_NAME_RE}`);
  if (info.description.length > MAX_DESCRIPTION_CHARS) {
    out.push(`${info.name}: description is ${info.description.length} chars (max ${MAX_DESCRIPTION_CHARS})`);
  }
  if (BANNED_DESCRIPTION_RE.test(info.description)) {
    out.push(`${info.name}: description contains a banned phrase`);
  }
  for (const p of info.params) {
    if (!PARAM_NAME_RE.test(p)) out.push(`${info.name}: parameter "${p}" fails ${PARAM_NAME_RE}`);
  }
  if (info.opts.readOnly && info.opts.destructive) {
    out.push(`${info.name}: cannot be both readOnly and destructive`);
  }
  return out;
}

// ── Argument validation ──────────────────────────────────────────────────────

/** Unwrap .default()/.optional() until an enum's options are visible. */
function optionsOf(schema: unknown): string[] | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- walking zod internals
  let s: any = schema;
  for (let depth = 0; depth < 6 && s; depth++) {
    if (Array.isArray(s.options)) return s.options.map((o: unknown) => String(o));
    s = s.def?.innerType ?? s._def?.innerType;
  }
  return null;
}

/**
 * Render a schema rejection as the same { error, code, message, next } envelope
 * every other failure uses.
 *
 * Without this the SDK renders zod's own issue array — 40 lines of nested JSON
 * with "origin"/"inclusive"/"path" keys — for the single most common mistake a
 * small model makes. The allowed values are technically in there, but the shape
 * is the opposite of the contract the rest of this server keeps.
 */
function badArgumentResult(name: string, shape: Shape, error: z.ZodError) {
  const issues = error.issues.slice(0, 3).map((issue) => {
    const param = issue.path.map(String).join(".") || "(arguments)";
    const options = optionsOf(shape[String(issue.path[0] ?? "")]);
    return `${param}: ${issue.message}${options ? ` (allowed: ${options.join(", ")})` : ""}`;
  });
  const params = [...new Set(error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
  return toolErrorResult(
    new ToolError(
      "BAD_ARGUMENT",
      `${name} rejected its arguments — ${issues.join("; ")}.`,
      params.length
        ? `Call ${name} once more, changing only ${params.join(" and ")}.`
        : `Re-read this tool's parameters and call ${name} once more.`,
    ),
    name,
  );
}

interface CallEntry {
  shape: Shape;
  handler: ToolHandler;
  maxChars: number;
}

/**
 * Own the tools/call path so ARGUMENT validation goes through the envelope too.
 *
 * The SDK validates before it reaches the handler, so a wrapper around the
 * handler can never see a schema rejection. Registration still goes through
 * server.registerTool() — that is what builds tools/list, its JSON Schema and
 * the annotations — and this replaces only the dispatch, after every tool is
 * registered (McpServer installs its own handler on the FIRST registerTool
 * call, so finalize() must run last).
 */
function installCallHandler(server: McpServer, entries: Map<string, CallEntry>): void {
  server.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const entry = entries.get(name);
    if (!entry) {
      return toolErrorResult(
        new ToolError(
          "NOT_FOUND",
          `This ClawBox has no tool called "${name}".`,
          "Use a tool from this server's tool list; the list depends on which edition this device runs.",
        ),
        name,
      );
    }
    const parsed = z.object(entry.shape).safeParse(request.params.arguments ?? {});
    if (!parsed.success) return badArgumentResult(name, entry.shape, parsed.error);
    try {
      // ToolResult is an interface, so it has no implicit index signature and
      // does not structurally satisfy CallToolResult without the assertion.
      return capResult(await entry.handler(parsed.data), entry.maxChars) as CallToolResult;
    } catch (err) {
      return toolErrorResult(err, name);
    }
  });
}

/**
 * Build the registrar for one server instance. Every registration decision —
 * edition, profile — is made HERE, once, before server.connect(); never per
 * call, so tools/list is stable for the life of the process.
 */
export function createRegistrar(server: McpServer, edition: Ed, profile: Profile): Registrar {
  const registered: RegisteredToolInfo[] = [];
  const entries = new Map<string, CallEntry>();

  return {
    tool(name, description, shape, opts, handler) {
      if (opts.editions && !opts.editions.includes(edition)) return;
      if (profile === "core" && opts.profile !== "core") return;
      if (profile === "browser" && opts.family !== "browser") return;

      const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
      const info: RegisteredToolInfo = {
        name,
        description,
        params: Object.keys(shape),
        shape,
        opts,
      };
      for (const violation of contractViolations(info)) {
        // Loud, but never fatal: a description that grew past the cap must not
        // take the agent's whole tool surface down on a customer device.
        console.error(`[clawbox-mcp] TOOL CONTRACT: ${violation}`);
      }
      registered.push(info);
      entries.set(name, { shape, handler, maxChars });

      const wrapped = async (args: unknown) => {
        try {
          const result = await handler(args);
          return capResult(result, maxChars);
        } catch (err) {
          return toolErrorResult(err, name);
        }
      };

      server.registerTool(
        name,
        {
          description,
          inputSchema: shape,
          annotations: {
            readOnlyHint: opts.readOnly === true,
            destructiveHint: opts.destructive === true,
            openWorldHint: opts.openWorld === true,
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see ToolHandler
        wrapped as any,
      );
    },
    list() {
      return registered;
    },
    finalize() {
      if (entries.size) installCallHandler(server, entries);
    },
  };
}

/** Convenience for the common single-text-block success result. */
export function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}

/** Convenience for returning a JSON payload the agent will read as data. */
export function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
