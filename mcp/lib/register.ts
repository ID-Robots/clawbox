// The registration wrapper every ClawBox tool goes through.
//
// It does four things no individual tool should have to remember:
//   1. EDITION GATING. A tool whose backing surface does not exist on this
//      edition is never registered. Hermes runs a per-server circuit breaker —
//      one chronically-404ing tool takes ALL ClawBox tools offline for the
//      agent — so hiding is an availability requirement, not politeness.
//   2. ANNOTATIONS. readOnlyHint is exactly what exempts a tool from Hermes'
//      `trust: untrusted` approval gate (which fails CLOSED on a missing
//      annotation), and it is free on OpenClaw. Getting these right is what
//      makes `trust: untrusted` a usable containment for the write tools.
//   3. OUTPUT CAPS, so a 10 MB stdout cannot be dumped into a small model's
//      context window.
//   4. THE ERROR ENVELOPE. Every throw becomes { error, code, message, next } —
//      no stack, no upstream body, no absolute path.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { capText } from "./guard";
import { toolErrorResult } from "./errors";
import { PARAM_NAME_RE, TOOL_NAME_RE, type Shape } from "./schema";

export type Ed = "openclaw" | "hermes";
export type Profile = "core" | "full";

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
  profile?: Profile;
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
  opts: ToolOpts;
}

const DEFAULT_MAX_CHARS = 4_000;
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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- one wrapper
// cannot express every tool's parsed-arg type; the zod shape validates at
// runtime and each handler narrows its own destructure.
export type ToolHandler = (args: any) => Promise<ToolResult> | ToolResult;

function capResult(result: ToolResult, maxChars: number): ToolResult {
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

/**
 * Build the registrar for one server instance. Every registration decision —
 * edition, profile — is made HERE, once, before server.connect(); never per
 * call, so tools/list is stable for the life of the process.
 */
export function createRegistrar(server: McpServer, edition: Ed, profile: Profile): Registrar {
  const registered: RegisteredToolInfo[] = [];

  return {
    tool(name, description, shape, opts, handler) {
      if (opts.editions && !opts.editions.includes(edition)) return;
      if (profile === "core" && opts.profile !== "core") return;

      const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
      const info: RegisteredToolInfo = {
        name,
        description,
        params: Object.keys(shape),
        opts,
      };
      for (const violation of contractViolations(info)) {
        // Loud, but never fatal: a description that grew past the cap must not
        // take the agent's whole tool surface down on a customer device.
        console.error(`[clawbox-mcp] TOOL CONTRACT: ${violation}`);
      }
      registered.push(info);

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
