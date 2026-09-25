import { beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";

// TASK-1196, bug #3: the desktop chat on a local-model box asked this route for
// `?provider=llamacpp` (or `ollama`) on every open and drew a 400 "Unknown
// provider" each time. The chat no longer asks (useProviderCatalog, pinned in
// src/tests/components/chat-local-provider-catalog.test.tsx); this pins the
// route's half — a deliberate, successful EMPTY answer for the box's own
// providers, so a tab still running the previous bundle stops failing too —
// without loosening the 400 for an id the route genuinely does not know.

vi.mock("child_process", () => ({ spawn: vi.fn() }));

vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => false,
}));

// Per-process, for the reason catalog-live-vs-fallback.test.ts gives.
const DATA_DIR = `/tmp/clawbox-catalog-local-providers-test-${process.pid}`;
vi.mock("@/lib/config-store", () => ({ DATA_DIR: `/tmp/clawbox-catalog-local-providers-test-${process.pid}` }));

import { GET } from "@/app/setup-api/ai-models/catalog/route";
import { LOCAL_ONLY_PROVIDERS, isCatalogProvider, isLocalOnlyProvider } from "@/lib/provider-models";

const mockSpawn = vi.mocked(childProcess.spawn);

async function get(provider: string, params = "") {
  const url = `http://clawbox.local/setup-api/ai-models/catalog?provider=${provider}${params}`;
  return GET(new NextRequest(url));
}

beforeEach(() => {
  mockSpawn.mockReset();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("GET /setup-api/ai-models/catalog for a provider on this box", () => {
  it.each(LOCAL_ONLY_PROVIDERS)("answers %s with a successful empty catalogue", async (provider) => {
    const res = await get(provider);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ provider, models: [], defaultModelId: "", allowCustom: false });
    // Not the box's enumeration, and nothing to wait for: a client must neither
    // treat it as a device answer nor poll it.
    expect(body.source).toBeUndefined();
    expect(body.warming).toBeUndefined();
    expect(body.error).toBeUndefined();
  });

  it("starts no enumeration and caches nothing for it — even when asked to refresh", async () => {
    await get("llamacpp", "&refresh=1");
    await get("ollama");
    // Past the boot warm-up's first slot, which a regression that reached
    // `bootWarmup()` from this branch would have filled.
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(DATA_DIR, "catalog-cache", "llamacpp.json"))).toBe(false);
    expect(fs.existsSync(path.join(DATA_DIR, "catalog-cache", "ollama.json"))).toBe(false);
  });

  it("is case- and space-tolerant the way every other provider id is", async () => {
    const res = await get("%20LlamaCpp%20");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { provider: string }).provider).toBe("llamacpp");
  });

  it("still refuses an id it does not know, and a missing one", async () => {
    const unknown = await get("not-a-provider");
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain("Unknown provider: not-a-provider");

    const missing = await GET(new NextRequest("http://clawbox.local/setup-api/ai-models/catalog"));
    expect(missing.status).toBe(400);
  });

  it("keeps the local and the enumerable providers apart", () => {
    // A provider in both lists would take the empty answer and lose its
    // catalogue, fallback list included.
    for (const provider of LOCAL_ONLY_PROVIDERS) {
      expect(isLocalOnlyProvider(provider)).toBe(true);
      expect(isCatalogProvider(provider)).toBe(false);
    }
    expect(isLocalOnlyProvider("anthropic")).toBe(false);
    expect(isLocalOnlyProvider(null)).toBe(false);
  });
});
