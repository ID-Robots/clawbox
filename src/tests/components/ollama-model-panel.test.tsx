/**
 * OllamaModelPanel (src/components/OllamaModelPanel.tsx): the model picker the
 * AI step mounts for Ollama — presets, search, pull with progress, delete.
 *
 * Pinned: a download in flight can be cancelled from the panel, and the size
 * cap in the search copy is the figure the search route filters by, never a
 * number of the panel's own.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import OllamaModelPanel from "@/components/OllamaModelPanel";
import { OLLAMA_MAX_MODEL_PARAM_B } from "@/lib/resource-limits";

function renderPanel(over: Partial<ComponentProps<typeof OllamaModelPanel>> = {}) {
  // The provider reads the saved UI language; a 404 leaves it on English.
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ error: "unexpected" }), { status: 404, headers: { "content-type": "application/json" } }),
  ));
  const props: ComponentProps<typeof OllamaModelPanel> = {
    ollamaRunning: true,
    ollamaModels: [],
    ollamaSaving: false,
    ollamaSearch: "",
    ollamaSearching: false,
    ollamaSearchResults: [],
    ollamaPulling: false,
    ollamaPullProgress: null,
    selectedOllamaModel: "llama3.2:3b",
    setSelectedOllamaModel: vi.fn(),
    saveOllamaConfig: vi.fn(),
    deleteOllamaModel: vi.fn(),
    handleOllamaSearchChange: vi.fn(),
    clearSearch: vi.fn(),
    pullOllamaModel: vi.fn(),
    formatOllamaBytes: (bytes: number) => `${bytes} B`,
    ...over,
  };
  return render(<I18nProvider><OllamaModelPanel {...props} /></I18nProvider>);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OllamaModelPanel", () => {
  it("offers Cancel while a download is in flight, and it calls the hook's cancel", async () => {
    const cancelOllamaPull = vi.fn();
    renderPanel({ ollamaPulling: true, ollamaPullProgress: { status: "pulling", completed: 1, total: 4 }, cancelOllamaPull });
    fireEvent.click(await screen.findByTestId("ollama-pull-cancel"));
    expect(cancelOllamaPull).toHaveBeenCalledTimes(1);
  });

  it("has no Cancel when nothing is downloading, or when the caller cannot cancel", () => {
    renderPanel({ ollamaPulling: false, cancelOllamaPull: vi.fn() });
    expect(screen.queryByTestId("ollama-pull-cancel")).not.toBeInTheDocument();
    renderPanel({ ollamaPulling: true });
    expect(screen.queryByTestId("ollama-pull-cancel")).not.toBeInTheDocument();
  });

  it("names the size cap the search route filters by, and the route's own figure when it has answered", async () => {
    renderPanel({ ollamaSearch: "zzz-nothing" });
    // The catalogue loads async, so the first paint can still carry the raw key.
    expect(await screen.findByText(`Or search for more models (sizes up to ${OLLAMA_MAX_MODEL_PARAM_B}B fit this box)`)).toBeInTheDocument();
    expect(screen.getByText(`No models found matching "zzz-nothing" at ${OLLAMA_MAX_MODEL_PARAM_B}B or smaller`)).toBeInTheDocument();
    renderPanel({ ollamaSearch: "zzz-nothing", maxParamBillions: 3 });
    expect(await screen.findByText("Or search for more models (sizes up to 3B fit this box)")).toBeInTheDocument();
    expect(screen.getByText('No models found matching "zzz-nothing" at 3B or smaller')).toBeInTheDocument();
  });
});
