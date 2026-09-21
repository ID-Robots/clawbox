/**
 * Can this Ollama model chat? — the rule behind the chat picker's local row.
 *
 * The UI sweep of 2026-09-07 found the picker offering "Ollama Local" backed
 * by qwen3-embedding:0.6b, the retired ollama-hosted embedder. Ollama's own
 * `/api/show` is the ruling where it answers; the tag's name is the fallback
 * where it does not — and only Ollama's own verdict may be remembered, because
 * on this box most asks land on a port its idle standby has closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/local-ai-runtime", () => ({
  getOllamaBaseUrl: () => "http://127.0.0.1:11434",
}));

import { _resetOllamaCapabilityCacheForTests, ollamaModelCanChat } from "@/lib/ollama-capabilities";

const fetchMock = vi.fn();

function ollamaAnswers(body: Record<string, unknown>) {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
}

function ollamaRefuses() {
  fetchMock.mockRejectedValue(new TypeError("fetch failed"));
}

beforeEach(() => {
  _resetOllamaCapabilityCacheForTests();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ollamaModelCanChat", () => {
  it("trusts Ollama's capabilities over the name", async () => {
    // A tag that carries "embed" but that Ollama reports as generating: the
    // name is the fallback, never the ruling, once Ollama has answered.
    ollamaAnswers({ capabilities: ["completion", "embedding"] });
    await expect(ollamaModelCanChat("qwen3-embedding:0.6b")).resolves.toBe(true);
  });

  it("refuses a model Ollama says only embeds, whatever its name", async () => {
    ollamaAnswers({ capabilities: ["embedding"] });
    await expect(ollamaModelCanChat("bge-m3")).resolves.toBe(false);
  });

  it("falls back to the name when Ollama cannot be asked", async () => {
    ollamaRefuses();
    await expect(ollamaModelCanChat("qwen3-embedding:0.6b")).resolves.toBe(false);
    await expect(ollamaModelCanChat("qwen2.5:0.5b")).resolves.toBe(true);
  });

  it("falls back to the name for an Ollama too old to report capabilities", async () => {
    ollamaAnswers({ license: "…" });
    await expect(ollamaModelCanChat("nomic-embed-text")).resolves.toBe(false);
    await expect(ollamaModelCanChat("qwen2.5:0.5b")).resolves.toBe(true);
  });

  it("remembers Ollama's own verdict, so a poll does not pay for the probe twice", async () => {
    ollamaAnswers({ capabilities: ["embedding"] });
    await ollamaModelCanChat("bge-m3");
    await expect(ollamaModelCanChat("bge-m3")).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not remember a guess from the name — the next ask gets Ollama's answer", async () => {
    // The header polls this while Ollama sleeps, and a chat turn then wakes
    // it: a name verdict kept for a minute would keep offering an embedding-
    // only tag with no "embed" in its name for exactly that window.
    ollamaRefuses();
    await expect(ollamaModelCanChat("bge-m3")).resolves.toBe(true);
    ollamaAnswers({ capabilities: ["embedding"] });
    await expect(ollamaModelCanChat("bge-m3")).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("answers no for an empty id without asking", async () => {
    await expect(ollamaModelCanChat("  ")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
