/**
 * /setup-api/clawkeep/memory/provider — where the memory index is embedded,
 * and the owner's switch between the ClawBox AI cloud and the model on this box
 * (2026-09-15).
 *
 * Pinned: the GET's "on offer" means what the cloud-defaults resolver means by
 * it (linked, paid, answered), on BOTH editions since 2026-09-18 — the one
 * where ClawBox itself indexes included; a box nobody has pinned reads as the
 * cloud wherever the subscription covers it (the owner's ruling, same day); a
 * POST with no body is still the model on this box; the cloud is refused where
 * it cannot work rather than written and left to find nothing; and every
 * refusal lands before anything is written.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  owner: true,
  absent: false,
  placement: { source: "local", recorded: true } as { source: string; recorded: boolean },
  /** What an unpinned box was told the default is, as the route passed it. */
  placementFallback: undefined as unknown,
  choiceThrows: false,
  routeReady: true,
  factsThrow: false,
  token: "claw_test_token" as string | null,
  installed: false,
  /** The model the box is set to, as data/config.json holds it (TASK-2411). */
  active: { id: "qwen3-embedding-0.6b", quant: "Q8_0" } as { id: string; quant: string },
  /** What the gate says about the 4B on this box. */
  gate4b: { available: true, quant: "Q8_0", reason: null, detail: null } as { available: boolean; quant: string | null; reason: string | null; detail: string | null },
  /** The 4B quant on disk, or null when it is not downloaded. */
  installed4b: null as string | null,
  switchLocal: vi.fn(async (..._a: unknown[]) => {}),
  switchCloud: vi.fn(async (..._a: unknown[]) => {}),
  note: vi.fn(async (..._a: unknown[]) => {}),
  invalidate: vi.fn(() => {}),
  facts: vi.fn(),
}));

vi.mock("@/lib/owner-session", () => ({ hasPersonSession: async () => h.owner }));
vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-config")>()),
  openclawIsAbsent: () => h.absent,
}));
vi.mock("@/lib/memory-shard", () => ({
  switchToLocalEmbeddings: (...a: unknown[]) => {
    const selection = a[0] as { id: string; quant: string } | undefined;
    if (selection) h.active = selection;
    return h.switchLocal(...a);
  },
  switchToCloudEmbeddings: (...a: unknown[]) => h.switchCloud(...a),
  readEmbeddingPlacement: async (fallback?: unknown) => {
    if (h.choiceThrows) throw new Error("EACCES: permission denied, open 'openclaw.json'");
    h.placementFallback = fallback;
    return h.placement;
  },
}));
vi.mock("@/lib/clawai-cloud-choice", () => ({ noteOwnerChoice: (...a: unknown[]) => h.note(...a) }));
vi.mock("@/lib/clawkeep-memory", () => ({ invalidateMemoryStatusCache: () => h.invalidate() }));
vi.mock("@/lib/embed-server", () => ({
  getEmbedProvisioningStatus: async () => ({ installed: h.installed }),
  readActiveLocalEmbeddingModel: async () => h.active,
}));
vi.mock("@/lib/local-embedding-model", () => ({
  gateLocalModel: async (id: string) =>
    id === "qwen3-embedding-0.6b" ? { available: true, quant: "Q8_0", reason: null, detail: null } : h.gate4b,
  selectionForSwitch: async (id: string) => (h.installed4b ? { id, quant: h.installed4b } : null),
  localEmbeddingModelOptions: async () => [
    { id: "qwen3-embedding-0.6b", label: "Qwen3-Embedding-0.6B", dimensions: 1024, active: h.active.id === "qwen3-embedding-0.6b", installed: h.installed, bytes: 639150592, quant: "Q8_0", available: true, reason: null, detail: null },
    { id: "qwen3-embedding-4b", label: "Qwen3-Embedding-4B", dimensions: 2560, active: h.active.id === "qwen3-embedding-4b", installed: h.installed4b !== null, bytes: 4279660224, ...h.gate4b, quant: h.installed4b ?? h.gate4b.quant },
  ],
}));
vi.mock("@/lib/clawai-cloud-defaults", () => ({ readCloudDefaultsFacts: () => h.facts() }));
vi.mock("@/lib/harness/credentials", () => ({ resolveClawaiToken: async () => h.token }));
vi.mock("@/lib/clawai-cloud-embeddings", () => ({
  cloudEmbeddingsUrl: () => "https://ai.clawbox.com/v1/embeddings",
  CLOUD_EMBEDDING_PROVIDER: "openai-compatible",
  CLOUD_EMBEDDING_MODEL: "text-embedding-3-large",
  OPENCLAW_CLOUD_EMBEDDING_MODEL: "text-embedding-3-small",
  CLOUD_EMBEDDING_ENGINE: "ClawBox AI",
}));

const URL_ = "http://localhost/setup-api/clawkeep/memory/provider";
function post(body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}
const route = () => import("@/app/setup-api/clawkeep/memory/provider/route");

beforeEach(() => {
  h.owner = true;
  h.absent = false;
  h.placement = { source: "local", recorded: true };
  h.placementFallback = undefined;
  h.choiceThrows = false;
  h.routeReady = true;
  h.factsThrow = false;
  h.token = "claw_test_token";
  h.installed = false;
  h.active = { id: "qwen3-embedding-0.6b", quant: "Q8_0" };
  h.gate4b = { available: true, quant: "Q8_0", reason: null, detail: null };
  h.installed4b = null;
  for (const fn of [h.switchLocal, h.switchCloud, h.note, h.invalidate]) fn.mockClear();
  h.facts.mockReset().mockImplementation(async () => {
    if (h.factsThrow) throw new Error("probe failed");
    return { linked: true, entitlement: "flash", embeddingsSupported: true, embeddingsRouteReady: h.routeReady };
  });
});

describe("GET", () => {
  it("answers the model on this box, the cloud on offer, and whether the GGUF is here", async () => {
    const res = await (await route()).GET();
    expect(await res.json()).toMatchObject({ source: "local", recorded: true, cloudSupported: true, cloudAvailable: true, cloudReason: null, localInstalled: false, localModel: "qwen3-embedding-0.6b" });
  });

  it("calls an index pointed off the box the cloud", async () => {
    h.placement = { source: "cloud", recorded: true };
    h.installed = true;
    const body = await (await (await route()).GET()).json();
    expect(body).toMatchObject({ source: "cloud", localInstalled: true });
  });

  it("offers the cloud on the edition that indexes on the box itself too", async () => {
    // It used to answer `cloudSupported: false, cloudReason: "edition"` here,
    // because that index accepted only a loopback endpoint. It now accepts the
    // ClawBox AI one as well, so the switch is the same switch on both SKUs.
    h.absent = true;
    const body = await (await (await route()).GET()).json();
    expect(body).toMatchObject({ source: "local", recorded: true, cloudSupported: true, cloudAvailable: true, cloudReason: null, localInstalled: false });
  });

  it("hands an unpinned box the same verdict as the default, so the card cannot offer what it already uses", async () => {
    // The owner's ruling of 2026-09-18: with no choice made, the cloud IS the
    // embedder wherever the subscription covers it — not a preselection.
    h.absent = true;
    h.placement = { source: "cloud", recorded: false };
    const body = await (await (await route()).GET()).json();
    expect(h.placementFallback).toBe("cloud");
    expect(body).toMatchObject({ source: "cloud", cloudAvailable: true });
  });

  it("leaves an unpinned box on its own model, with the reason, when the cloud cannot serve it", async () => {
    h.absent = true;
    h.facts.mockImplementation(async () => ({ linked: false, entitlement: null, embeddingsSupported: true, embeddingsRouteReady: false }));
    h.placement = { source: "local", recorded: false };
    const body = await (await (await route()).GET()).json();
    expect(h.placementFallback).toBe("local");
    expect(body).toMatchObject({ source: "local", cloudSupported: true, cloudAvailable: false, cloudReason: "not_linked" });
  });

  it("carries WHY the cloud is not on offer, in the resolver's own vocabulary", async () => {
    // Each reason has a different fix, so the switch has to be able to say
    // which one it is rather than "not available on this box right now" — the
    // note an owner whose box was simply not connected read as a fault
    // (2026-09-17). The words are the cloud-defaults resolver's, so the card
    // and the Local AI panel cannot disagree about the same box.
    const cases: [Record<string, unknown>, string][] = [
      [{ linked: false, entitlement: null, embeddingsSupported: true, embeddingsRouteReady: false }, "not_linked"],
      [{ linked: true, entitlement: "free", embeddingsSupported: true, embeddingsRouteReady: false }, "plan"],
      [{ linked: true, entitlement: null, embeddingsSupported: true, embeddingsRouteReady: false }, "plan"],
      [{ linked: true, entitlement: "pro", embeddingsSupported: true, embeddingsRouteReady: false }, "route_unavailable"],
    ];
    for (const [facts, reason] of cases) {
      h.facts.mockImplementation(async () => facts);
      const body = await (await (await route()).GET()).json();
      expect(body, reason).toMatchObject({ cloudAvailable: false, cloudReason: reason });
    }
  });

  it("answers 503, never 'local', when the config cannot be read", async () => {
    h.choiceThrows = true;
    const res = await (await route()).GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.kind).toBe("unreadable");
    expect(body.source).toBeUndefined();
  });

  it("reads a cloud the resolver could not vouch for as not on offer, never as an error", async () => {
    h.factsThrow = true;
    const res = await (await route()).GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cloudAvailable).toBe(false);
    // …and it does not invent a reason it has no facts for.
    expect(body.cloudReason).toBeNull();
  });
});

describe("POST — who may switch", () => {
  // The assistant's bearer is admitted, behind a confirm gate of its own
  // (memory-shard-assistant.test.ts); a caller with neither credential is not.
  it("refuses a caller that is neither a signed-in person nor the assistant before anything is written", async () => {
    h.owner = false;
    const res = await (await route()).POST(post({ source: "cloud" }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
    expect(h.switchCloud).not.toHaveBeenCalled();
    expect(h.note).not.toHaveBeenCalled();
  });

  it("refuses another site's page", async () => {
    const res = await (await route()).POST(post({ source: "cloud" }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(h.switchCloud).not.toHaveBeenCalled();
  });

  it("refuses a source that is neither", async () => {
    for (const body of [{ source: "elsewhere" }, "not json", [1, 2]]) {
      const res = await (await route()).POST(post(body));
      expect(res.status).toBe(400);
      expect((await res.json()).kind).toBe("invalid");
    }
    expect(h.switchLocal).not.toHaveBeenCalled();
  });
});

describe("POST — the model on this box", () => {
  it("is what a body-less call still means", async () => {
    const res = await (await route()).POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: "local", model: "qwen3-embedding-0.6b" });
    expect(h.note).toHaveBeenCalledWith("embeddings");
    expect(h.switchLocal).toHaveBeenCalledTimes(1);
    expect(h.switchCloud).not.toHaveBeenCalled();
  });

  it("is what an explicit local means", async () => {
    const res = await (await route()).POST(post({ source: "local" }));
    expect(res.status).toBe(200);
    expect(h.switchLocal).toHaveBeenCalledTimes(1);
  });
});

describe("POST — which model on this box (TASK-2411)", () => {
  it("GET names the model the box is set to and every model it offers, with why one cannot run", async () => {
    h.gate4b = { available: false, quant: null, reason: "jetson", detail: "Qwen3-Embedding-4B does not fit on a Jetson Orin Nano Super." };
    const body = await (await (await route()).GET()).json();
    expect(body.localModel).toBe("qwen3-embedding-0.6b");
    expect(body.localModels.map((m: { id: string }) => m.id)).toEqual(["qwen3-embedding-0.6b", "qwen3-embedding-4b"]);
    expect(body.localModels[1]).toMatchObject({ available: false, reason: "jetson" });
  });

  it("refuses an id that is not in the catalog, and a local model beside the cloud, before anything is written", async () => {
    for (const body of [{ source: "local", localModel: "qwen3-embedding-8b" }, { localModel: "../../etc/passwd" }, { source: "cloud", localModel: "qwen3-embedding-4b" }]) {
      const res = await (await route()).POST(post(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(h.switchLocal).not.toHaveBeenCalled();
    expect(h.switchCloud).not.toHaveBeenCalled();
    expect(h.note).not.toHaveBeenCalled();
  });

  it("refuses the 4B where this box cannot run it, with the gate's reason, for the owner too", async () => {
    h.gate4b = { available: false, quant: null, reason: "jetson", detail: "Qwen3-Embedding-4B does not fit on a Jetson Orin Nano Super." };
    h.installed4b = "Q8_0";
    const res = await (await route()).POST(post({ source: "local", localModel: "qwen3-embedding-4b" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ kind: "local_model_unavailable", reason: "jetson", error: expect.stringMatching(/Jetson/) });
    expect(h.switchLocal).not.toHaveBeenCalled();
    expect(h.note).not.toHaveBeenCalled();
  });

  it("refuses the 4B while it is not downloaded", async () => {
    const res = await (await route()).POST(post({ source: "local", localModel: "qwen3-embedding-4b" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ kind: "local_not_installed", model: "qwen3-embedding-4b" });
    expect(h.switchLocal).not.toHaveBeenCalled();
  });

  it("switches onto the 4B copy on disk, and names it", async () => {
    h.installed4b = "Q4_K_M";
    const res = await (await route()).POST(post({ source: "local", localModel: "qwen3-embedding-4b" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: "local", model: "qwen3-embedding-4b", provider: "openai-compatible" });
    expect(h.switchLocal).toHaveBeenCalledWith({ id: "qwen3-embedding-4b", quant: "Q4_K_M" });
  });

  it("switches back to the 0.6B, which keeps the name it always had", async () => {
    h.active = { id: "qwen3-embedding-4b", quant: "Q8_0" };
    h.installed = true;
    const res = await (await route()).POST(post({ source: "local", localModel: "qwen3-embedding-0.6b" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ model: "qwen3-embedding-0.6b" });
    expect(h.switchLocal).toHaveBeenCalledWith({ id: "qwen3-embedding-0.6b", quant: "Q8_0" });
  });

  it("keeps the model the box is set to when no model is named", async () => {
    h.active = { id: "qwen3-embedding-4b", quant: "Q8_0" };
    const res = await (await route()).POST(post({ source: "local" }));
    expect(res.status).toBe(200);
    expect(h.switchLocal).toHaveBeenCalledWith(undefined);
    expect(await res.json()).toMatchObject({ model: "qwen3-embedding-4b" });
  });
});

describe("POST — the ClawBox AI cloud", () => {
  it("points the index at the cloud embedder with the box's own credential, pinned as the owner's pick", async () => {
    const res = await (await route()).POST(post({ source: "cloud" }));
    expect(res.status).toBe(200);
    // OpenClaw's index lives in the agent databases, and on the cloud it is
    // embedded with the small model: the answer names what was written.
    expect(await res.json()).toEqual({
      source: "cloud", provider: "openai-compatible", model: "text-embedding-3-small", engine: "ClawBox AI",
    });
    expect(h.switchCloud).toHaveBeenCalledWith("https://ai.clawbox.com/v1/embeddings", "claw_test_token");
    expect(h.note).toHaveBeenCalledWith("embeddings");
    expect(h.invalidate).toHaveBeenCalledTimes(1);
    expect(h.switchLocal).not.toHaveBeenCalled();
  });

  it("is written on the edition that indexes on the box itself, like any other", async () => {
    h.absent = true;
    const res = await (await route()).POST(post({ source: "cloud" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: "cloud", model: "text-embedding-3-large" });
    expect(h.switchCloud).toHaveBeenCalledWith("https://ai.clawbox.com/v1/embeddings", "claw_test_token");
    expect(h.note).toHaveBeenCalledWith("embeddings");
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it("is refused where the cloud embedder is not on offer, before any pin is written", async () => {
    h.routeReady = false;
    const res = await (await route()).POST(post({ source: "cloud" }));
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe("cloud_unavailable");
    expect(h.switchCloud).not.toHaveBeenCalled();
    expect(h.note).not.toHaveBeenCalled();
  });

  it("is refused when the box holds no ClawBox AI credential", async () => {
    h.token = null;
    const res = await (await route()).POST(post({ source: "cloud" }));
    expect(res.status).toBe(409);
    expect(h.switchCloud).not.toHaveBeenCalled();
  });

  it("answers a 500 in the device's words when the config write fails", async () => {
    h.switchCloud.mockRejectedValueOnce(new Error("openclaw config set timed out"));
    const res = await (await route()).POST(post({ source: "cloud" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ kind: "failed", error: "openclaw config set timed out" });
  });
});
