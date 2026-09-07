// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useLlamaCppModels } from "@/hooks/useLlamaCppModels";

/**
 * The wizard's "Skip — I'll use only local AI" configures local AI through
 * `activateLocalOnly`, and what makes that work is the REQUEST it sends, not
 * the fact that it sends one.
 *
 * A box configured through the wizard's ambient scope ("primary") comes out
 * with the provider registered but no `local_ai_model`, which leaves Settings →
 * Local AI showing Gemma as unconfigured and the Local-only switch refusing
 * with "Local AI is not configured". Only `scope: "local"` reaches the branch
 * that writes those keys and starts the runtime
 * (src/app/setup-api/ai-models/configure/route.ts:2229).
 *
 * So these assert the exact body Settings → Local AI → "Make primary" sends
 * (src/components/LocalAiPanel.tsx:445) — `{scope:"local", activate:true}` with
 * NO model, so the server picks the alias.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
});

/** A streamed NDJSON install response, one JSON object per line. */
function ndjsonResponse(lines: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function setup(configureScope: "primary" | "local" = "primary") {
  const onSaveSuccess = vi.fn();
  const onSaveError = vi.fn();
  const onClearStatus = vi.fn();
  const hook = renderHook(() =>
    useLlamaCppModels({ onSaveSuccess, onSaveError, onClearStatus }, configureScope),
  );
  return { hook, onSaveSuccess, onSaveError, onClearStatus };
}

/** The parsed JSON body of the Nth fetch call. */
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call][1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe("useLlamaCppModels — activateLocalOnly", () => {
  it("sends the local scope with activate, and no model, whatever the ambient scope is", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/setup-api/llamacpp/status")) {
        return new Response(JSON.stringify({ running: true, installed: true, models: [] }), { status: 200 });
      }
      return ndjsonResponse([
        { status: "llama.cpp is already running. Applying configuration..." },
        { success: true, model: "gemma4-e2b-it-q4_0" },
      ]);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // The wizard's ambient scope is "primary" — the point is that the local-only
    // action does NOT inherit it.
    const { hook, onSaveSuccess, onSaveError } = setup("primary");
    await hook.result.current.activateLocalOnly();

    const installCall = fetchMock.mock.calls.findIndex(
      ([url]) => String(url) === "/setup-api/llamacpp/install",
    );
    expect(installCall).toBeGreaterThanOrEqual(0);
    expect(bodyOf(fetchMock, installCall)).toEqual({ scope: "local", activate: true });
    // Explicitly: the server, not the browser, chooses the alias.
    expect(bodyOf(fetchMock, installCall)).not.toHaveProperty("model");

    await waitFor(() => expect(onSaveSuccess).toHaveBeenCalledWith("gemma4-e2b-it-q4_0"));
    expect(onSaveError).not.toHaveBeenCalled();
  });

  it("reports an error line from the stream as a failure, not a success", async () => {
    const fetchMock = vi.fn(async () =>
      ndjsonResponse([
        { status: "Installing llama.cpp and Gemma 4 for offline use..." },
        { error: "Failed to provision the local Gemma 4 runtime" },
      ]),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { hook, onSaveSuccess, onSaveError } = setup("primary");
    await hook.result.current.activateLocalOnly();

    // The route reports install failures in the BODY with a 200, so a caller
    // that only checked the status would call this a configured box.
    expect(onSaveError).toHaveBeenCalledWith("Failed to provision the local Gemma 4 runtime");
    expect(onSaveSuccess).not.toHaveBeenCalled();
  });

  it("reports a stream that ends before the server is ready as a failure", async () => {
    const fetchMock = vi.fn(async () => ndjsonResponse([{ status: "Preparing llama.cpp..." }]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { hook, onSaveSuccess, onSaveError } = setup("primary");
    await hook.result.current.activateLocalOnly();

    expect(onSaveError).toHaveBeenCalledWith("llama.cpp install ended before the server became ready.");
    expect(onSaveSuccess).not.toHaveBeenCalled();
  });

  it("still sends the ambient scope and the named model for a plain save", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/setup-api/llamacpp/status")) {
        return new Response(JSON.stringify({ running: true, installed: true, models: [] }), { status: 200 });
      }
      return ndjsonResponse([{ success: true, model: "gemma4-e2b-it-q4_0" }]);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // The existing "Switch to Gemma 4" contract is unchanged by the refactor:
    // same scope it always used, same explicit model, same activate flag.
    const { hook } = setup("local");
    await hook.result.current.saveLlamaCppConfig("gemma4-e2b-it-q4_0", { activate: true });

    const installCall = fetchMock.mock.calls.findIndex(
      ([url]) => String(url) === "/setup-api/llamacpp/install",
    );
    expect(bodyOf(fetchMock, installCall)).toEqual({
      model: "gemma4-e2b-it-q4_0",
      scope: "local",
      activate: true,
    });
  });

  it("refuses an empty model without calling the route", async () => {
    const fetchMock = vi.fn(async () => ndjsonResponse([{ success: true }]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { hook, onSaveError } = setup("primary");
    await hook.result.current.saveLlamaCppConfig("   ");

    expect(onSaveError).toHaveBeenCalledWith("Enter the llama.cpp model ID first.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
