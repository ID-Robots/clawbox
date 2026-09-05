/**
 * A Registrar that captures tool handlers instead of wiring them to an MCP
 * transport, so a unit test can call a tool the way the agent does.
 *
 * `call()` reproduces exactly what mcp/lib/register.ts does around a handler —
 * a throw becomes the { error, code, message, next } envelope with isError set
 * — because "what does the agent actually see" is the property these tests are
 * about. A handler that throws and a handler that returns cheerful prose are
 * indistinguishable if you only inspect the return value.
 */

import type { ToolErrorEnvelope } from "../../../mcp/lib/errors";
import { toolErrorResult } from "../../../mcp/lib/errors";
import { capResult, DEFAULT_MAX_CHARS } from "../../../mcp/lib/register";
import type { Registrar, ToolHandler, ToolOpts, ToolResult } from "../../../mcp/lib/register";
import type { Shape } from "../../../mcp/lib/schema";

export interface CapturedTool {
  name: string;
  description: string;
  shape: Shape;
  opts: ToolOpts;
  handler: ToolHandler;
}

export type CallOutcome =
  | { isError: false; text: string; result: ToolResult }
  | { isError: true; error: ToolErrorEnvelope };

export interface CaptureHarness {
  reg: Registrar;
  tools: Map<string, CapturedTool>;
  names(): string[];
  has(name: string): boolean;
  get(name: string): CapturedTool;
  call(name: string, args?: Record<string, unknown>): Promise<CallOutcome>;
}

/**
 * @param edition which edition's registrations to keep, mirroring the real
 *                registrar's edition gate. Anything registered for the other
 *                edition is dropped, exactly as it is on a device.
 */
export function captureRegistrar(edition: "openclaw" | "hermes" = "hermes"): CaptureHarness {
  const tools = new Map<string, CapturedTool>();

  const reg: Registrar = {
    tool(name, description, shape, opts, handler) {
      if (opts.editions && !opts.editions.includes(edition)) return;
      tools.set(name, { name, description, shape, opts, handler });
    },
    list() {
      return [...tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        params: Object.keys(t.shape),
        shape: t.shape,
        opts: t.opts,
      }));
    },
    finalize() {
      /* no transport to install a dispatcher on */
    },
  };

  const get = (name: string): CapturedTool => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool "${name}" is not registered on the ${edition} edition`);
    return tool;
  };

  return {
    reg,
    tools,
    names: () => [...tools.keys()],
    has: (name) => tools.has(name),
    get,
    async call(name, args = {}) {
      try {
        const tool = get(name);
        // Through the SAME output cap the dispatcher applies. Without it a
        // result that outgrew its maxChars looked whole here and was
        // hard-sliced on the device, which is how two list tools came to sit
        // over their cap with a green suite.
        const result = capResult(await tool.handler(args), tool.opts.maxChars ?? DEFAULT_MAX_CHARS);
        const text = result.content
          .map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType}]`))
          .join("\n");
        return { isError: false, text, result };
      } catch (err) {
        const rendered = toolErrorResult(err, name);
        const first = rendered.content[0];
        return {
          isError: true,
          error: JSON.parse(first.type === "text" ? first.text : "{}") as ToolErrorEnvelope,
        };
      }
    },
  };
}
