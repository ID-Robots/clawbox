import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/build-identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/build-identity")>();
  return { ...actual, collectBuildIdentity: vi.fn() };
});

import { collectBuildIdentity, computeDrift, type BuildIdentity } from "@/lib/build-identity";

const mockCollect = vi.mocked(collectBuildIdentity);

function identity(over: Partial<BuildIdentity> = {}): BuildIdentity {
  const build = {
    commit: "1b21187aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    shortCommit: "1b21187",
    branch: "beta",
    dirty: false,
    committedAt: "2026-08-21T20:00:00Z",
    builtAt: "2026-08-21T20:09:03Z",
    buildId: "f2aojibqYGT2Dg7DvAtYb",
    node: "v22.0.0",
    bun: "1.2.10",
    packageVersion: "3.9.0",
    hermesPin: null,
    openclawPin: null,
  };
  const checkout = {
    commit: "d285cfdbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    shortCommit: "d285cfd",
    branch: "beta",
    dirty: false,
    committedAt: "2026-08-22T03:00:00Z",
  };
  const pin = { branch: "beta", source: "pin-file" as const, commit: checkout.commit, pinned: true };
  return {
    build,
    deployedBuildId: build.buildId,
    checkout,
    pin,
    drift: computeDrift({
      build,
      deployedBuildId: build.buildId,
      buildTimestampMs: Date.parse(build.builtAt),
      checkout,
      pin,
      stamperInCheckout: true,
    }),
    ...over,
  };
}

describe("/setup-api/system/build-identity", () => {
  let GET: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("@/app/setup-api/system/build-identity/route");
    GET = mod.GET;
  });

  it("returns the deployed build, the checkout, the pin and the drift verdict", async () => {
    mockCollect.mockResolvedValue(identity());
    const res = await GET(new Request("http://localhost/setup-api/system/build-identity"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.build.commit).toBe("1b21187aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(body.build.builtAt).toBe("2026-08-21T20:09:03Z");
    expect(body.checkout.commit).toBe("d285cfdbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(body.checkout.branch).toBe("beta");
    expect(body.pin).toMatchObject({ branch: "beta", pinned: true });
    expect(body.drift.buildVsCheckout).toBe("drift");
    expect(body.drift.checkoutVsPin).toBe("match");
    expect(body.drift.detected).toBe(true);
    expect(body.drift.codes).toContain("build-from-other-commit");
  });

  it("serves repeat reads from cache and re-reads on ?force=1", async () => {
    mockCollect.mockResolvedValue(identity());
    await GET(new Request("http://localhost/setup-api/system/build-identity"));
    await GET(new Request("http://localhost/setup-api/system/build-identity"));
    expect(mockCollect).toHaveBeenCalledTimes(1);

    await GET(new Request("http://localhost/setup-api/system/build-identity?force=1"));
    expect(mockCollect).toHaveBeenCalledTimes(2);
  });

  it("reports a healthy box as drift-free", async () => {
    const clean = identity();
    clean.checkout = { ...clean.checkout, commit: clean.build!.commit, shortCommit: clean.build!.shortCommit };
    clean.pin = { ...clean.pin, commit: clean.build!.commit };
    clean.drift = computeDrift({
      build: clean.build,
      deployedBuildId: clean.deployedBuildId,
      buildTimestampMs: Date.parse(clean.build!.builtAt!),
      checkout: clean.checkout,
      pin: clean.pin,
      stamperInCheckout: true,
    });
    mockCollect.mockResolvedValue(clean);

    const res = await GET(new Request("http://localhost/setup-api/system/build-identity"));
    const body = await res.json();
    expect(body.drift.detected).toBe(false);
    expect(body.drift.reasons).toEqual([]);
  });

  it("returns 500 with a message when the device cannot be inspected", async () => {
    mockCollect.mockRejectedValue(new Error("git exploded"));
    const res = await GET(new Request("http://localhost/setup-api/system/build-identity"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("git exploded");
  });
});
