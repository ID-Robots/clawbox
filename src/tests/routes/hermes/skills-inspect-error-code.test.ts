import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HERMES-04, the fourth surface. The detail panel is fed by the inspect route,
 * whose catch answered `{ error: err.message }` — runHermesCli's own English
 * ("Hermes is not installed on this device", "hermes timed out", "hermes call
 * cancelled", "output exceeded the size limit") — and the panel painted that
 * sentence verbatim in an Alert under a localised header. A client cannot
 * translate a sentence; it can translate a code.
 */
vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(async () => "hermes"),
  HERMES_BIN: "/home/clawbox/.local/bin/hermes",
}));
vi.mock("@/lib/hermes-skills-cli", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hermes-skills-cli")>();
  return { ...actual, runSkillsCli: vi.fn() };
});
vi.mock("@/lib/hermes-skill-index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hermes-skill-index")>();
  return { ...actual, getCatalogRecord: vi.fn(async () => undefined) };
});

import { runSkillsCli } from "@/lib/hermes-skills-cli";
import { CLI_FAILURE_SENTENCES } from "@/lib/hermes-skills";

const mockCli = vi.mocked(runSkillsCli);
const ID = "official/pdf-tools";

async function inspect(query: string) {
  const { GET } = await import("@/app/setup-api/hermes/skills/inspect/route");
  const res = await GET(new Request(`http://localhost/setup-api/hermes/skills/inspect?${query}`));
  return { status: res.status, body: (await res.json()) as { error?: string; code?: string } };
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /setup-api/hermes/skills/inspect — a CLI failure carries a code", () => {
  it("names a missing binary `cli_missing` and never echoes the CLI's sentence", async () => {
    mockCli.mockRejectedValue(new Error("Hermes is not installed on this device"));

    const { status, body } = await inspect(`id=${encodeURIComponent(ID)}&docs=1`);

    expect(status).toBe(502);
    expect(body.code).toBe("cli_missing");
    expect(body.error).toBe(CLI_FAILURE_SENTENCES.cli_missing);
  });

  it("names an over-long answer `too_large`", async () => {
    mockCli.mockRejectedValue(new Error("hermes output exceeded the size limit"));

    const { status, body } = await inspect(`id=${encodeURIComponent(ID)}&docs=1`);

    expect(status).toBe(502);
    expect(body.code).toBe("too_large");
    expect(body.error).not.toMatch(/exceeded the size limit/i);
  });

  it("names the documentation deadline `cli_timeout` on its own 504", async () => {
    // The metadata is already on screen behind this note, so the panel says it
    // lost the documentation — not that the skill could not be loaded.
    mockCli.mockRejectedValue(new Error("hermes timed out"));

    const { status, body } = await inspect(`id=${encodeURIComponent(ID)}&docs=1`);

    expect(status).toBe(504);
    expect(body.code).toBe("cli_timeout");
    expect(body.error).not.toMatch(/hermes timed out/i);
  });

  it("gives the documentation fetch the shared docs cap, so a client can size its own budget", async () => {
    // HERMES-06: this cap and the budget the MCP tool allows the same request
    // are one constant. While the route capped the CLI at 45 s and the tool
    // allowed the request 30 s, the tool always gave up first and the 504
    // above — the answer that says WHICH half failed — could not be delivered.
    mockCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await inspect(`id=${encodeURIComponent(ID)}&docs=1`);

    expect(mockCli).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
  });

  it("names a non-zero exit `cli_failed`, keeping the traceback for the log", async () => {
    mockCli.mockResolvedValue({ code: 1, stdout: "", stderr: "Traceback (most recent call last):" });

    const { status, body } = await inspect(`id=${encodeURIComponent(ID)}&docs=1`);

    expect(status).toBe(502);
    expect(body.code).toBe("cli_failed");
    expect(body.error).not.toMatch(/Traceback/);
  });
});
