import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HERMES-04, the server half. The install route names its every refusal with a
 * machine `code`; the browse route's CLI fallback answered `{ error: err.message }`
 * and nothing else, so the only thing the store could put on the red empty state
 * was runHermesCli's own word for its SIGKILL — "hermes timed out" — or the
 * index module's "Browse failed". A client cannot translate a sentence; it can
 * translate a code.
 *
 * These fakes reject exactly as runHermesCli does (a sanitised message, never
 * the binary path), with no offline index so the handler takes the CLI path.
 */
vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(async () => "hermes"),
  HERMES_BIN: "/home/clawbox/.local/bin/hermes",
}));
vi.mock("@/lib/hermes-cli", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hermes-cli")>("@/lib/hermes-cli");
  return { ...actual, runHermesCli: vi.fn() };
});
vi.mock("@/lib/hermes-skill-index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hermes-skill-index")>();
  return {
    ...actual,
    loadCatalog: vi.fn(async () => null),
    warmIndex: vi.fn(),
    isWarming: vi.fn(() => false),
  };
});

import { runHermesCli } from "@/lib/hermes-cli";

const mockCli = vi.mocked(runHermesCli);

async function browse(query = "page=1&size=24", init?: RequestInit) {
  const { GET } = await import("@/app/setup-api/hermes/skills/browse/route");
  const res = await GET(new Request(`http://localhost/setup-api/hermes/skills/browse?${query}`, init));
  return { status: res.status, body: (await res.json()) as { error?: string; code?: string } };
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /setup-api/hermes/skills/browse — a CLI failure carries a code", () => {
  it("names a timeout `cli_timeout` and never echoes 'hermes timed out'", async () => {
    mockCli.mockRejectedValue(new Error("hermes timed out"));

    const { status, body } = await browse();

    expect(status).toBe(502);
    expect(body.code).toBe("cli_timeout");
    expect(body.error).not.toMatch(/hermes timed out/i);
  });

  it("names a missing binary `cli_missing`", async () => {
    mockCli.mockRejectedValue(new Error("Hermes is not installed on this device"));

    const { status, body } = await browse();

    expect(status).toBe(502);
    expect(body.code).toBe("cli_missing");
  });

  it("names a non-zero exit `cli_failed`", async () => {
    mockCli.mockResolvedValue({ code: 1, stdout: "", stderr: "Traceback (most recent call last):" });

    const { status, body } = await browse();

    expect(status).toBe(502);
    expect(body.code).toBe("cli_failed");
    // The rule the non-zero-exit branch of every skills route follows: the
    // traceback is logged, never sent.
    expect(body.error).not.toMatch(/Traceback/);
  });

  it("names an over-long answer `too_large`", async () => {
    mockCli.mockRejectedValue(new Error("hermes output exceeded the size limit"));

    const { body } = await browse();

    expect(body.code).toBe("too_large");
  });

  it("names a search the route will not run `bad_query`, without spawning anything", async () => {
    // The one refusal on this route the OWNER caused: the search box accepts a
    // leading "-", `isValidQuery` refuses it, and a 400 with no code read on
    // the card as "couldn't load the catalogue, retry" — the wrong story under
    // a button that re-sends the same rejected text.
    mockCli.mockRejectedValue(new Error("should not spawn"));

    const { status, body } = await browse("q=-rf&page=1&size=24");

    expect(status).toBe(400);
    expect(body.code).toBe("bad_query");
    expect(mockCli).not.toHaveBeenCalled();
  });

  it("names a request the client gave up on `cancelled`", async () => {
    // The gate drops a queued call whose signal is already aborted before it
    // ever spawns — so the CLI fake must not be reached at all.
    mockCli.mockRejectedValue(new Error("should not spawn"));
    const controller = new AbortController();
    controller.abort();

    const { body } = await browse("page=1&size=24", { signal: controller.signal });

    expect(body.code).toBe("cancelled");
    expect(mockCli).not.toHaveBeenCalled();
  });
});
