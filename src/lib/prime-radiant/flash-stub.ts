/**
 * A deterministic stand-in for the Flash writer's model, for the end-to-end
 * harness: a browser test cannot mock a call the SERVER makes, so a box
 * started with `CLAWBOX_TEST_MODE=1` and `PRIME_RADIANT_FLASH_STUB=1` answers
 * every writer call from the documents themselves — the title from the first
 * heading (or the file name), the summary from the first sentences, a fact
 * per further sentence. Never selected outside test mode (see flash-client).
 *
 * Pure apart from the interface it implements.
 */

import type { FlashClient } from "./flash-client";
import { readWriterItems } from "./writer";

export const STUB_MODEL = "stub-flash";

function sentences(text: string): string[] {
  return text
    .replace(/^#+\s.*$/gm, " ")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

function titleOf(path: string, text: string): string {
  const heading = /^#\s+(.+)$/m.exec(text);
  if (heading) return heading[1].trim();
  const base = path.split("/").pop() ?? "Document";
  return base.replace(/\.[A-Za-z0-9]+$/, "").replace(/[-_]+/g, " ").trim() || "Document";
}

export function createStubFlashClient(): FlashClient {
  return {
    model: STUB_MODEL,
    async complete(request) {
      const items = readWriterItems(request.user) ?? [];
      const cards = items.map((item) => {
        const all = sentences(item.text);
        return {
          i: item.i,
          useful: all.length > 0,
          type: "concept",
          title: titleOf(item.path, item.text),
          domain: "general",
          summary: all.slice(0, 2).join(" ").slice(0, 280) || "No summary.",
          details: "",
          facts: all.slice(0, 3).map((fact) => ({ fact, quote: fact.split(" ").slice(0, 6).join(" "), confidence: 0.7 })),
          sensitivity: "internal",
          confidence: 0.7,
        };
      });
      const text = JSON.stringify(cards);
      return {
        text,
        model: STUB_MODEL,
        usage: {
          promptTokens: Math.ceil((request.system.length + request.user.length) / 4),
          completionTokens: Math.ceil(text.length / 4),
          cacheHitTokens: 0,
        },
      };
    },
  };
}
