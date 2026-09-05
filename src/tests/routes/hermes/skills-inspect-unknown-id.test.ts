import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-547, the inspect half.
 *
 * Phase 1 of the inspect route builds its whole answer from `record?.…`, so an
 * id the catalogue has never heard of produced a complete-looking
 * HermesSkillDetail whose `name` was the request echoed back. Measured on the
 * Hermes box at beta head:
 *
 *   GET …/inspect?id=totally-made-up-skill-xyz-42
 *   HTTP 200 {"skill":{"id":"totally-made-up-skill-xyz-42",
 *             "name":"totally-made-up-skill-xyz-42","bodySource":"none",
 *             "needsRemoteDocs":true, …}}
 *
 * Nothing downstream could tell that apart from a real, sparse catalogue skill:
 * the Settings detail view rendered it, and the MCP `skill_info` tool had to
 * guess from empty fields.
 *
 * The fix is a FLAG, not a 404, and the flag is the whole point: this device
 * cannot refuse an id. Its catalogue is a snapshot the browse route builds once
 * and never rebuilds, and the store opens details by publisher-written bare NAME
 * as well (the related-skill chips), which is not a key of that snapshot at all.
 * `hermes skills inspect` — phase 2 — resolves both, and already answers a real
 * 404 when Hermes does not have the id.
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

import { getCatalogRecord, type CatalogRecord } from "@/lib/hermes-skill-index";

const mockRecord = vi.mocked(getCatalogRecord);

const KNOWN: CatalogRecord = {
  id: "clawhub/expense-report",
  name: "Expense Report",
  description: "Turn receipts into an expense report.",
  source: "clawhub",
  trust: "community",
  tags: ["finance"],
  hay: "expense report clawhub/expense-report",
};

async function inspect(query: string) {
  const { GET } = await import("@/app/setup-api/hermes/skills/inspect/route");
  const res = await GET(new Request(`http://localhost/setup-api/hermes/skills/inspect?${query}`));
  return {
    status: res.status,
    body: (await res.json()) as {
      skill?: { id?: string; name?: string; needsRemoteDocs?: boolean; catalogMiss?: boolean };
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /setup-api/hermes/skills/inspect — a record nothing on the device backs", () => {
  it("marks the placeholder as unbacked instead of passing it off as a skill", async () => {
    mockRecord.mockResolvedValue(undefined);

    const { status, body } = await inspect("id=totally-made-up-skill-xyz-42");

    expect(status).toBe(200);
    expect(body.skill?.catalogMiss).toBe(true);
    // Still asks phase 2, which is where Hermes gets to refuse it.
    expect(body.skill?.needsRemoteDocs).toBe(true);
  });

  it("does not mark a skill the catalogue actually has", async () => {
    // The legitimate phase-1 answer must survive untouched: real metadata, no
    // body, and `needsRemoteDocs` so the detail view fetches the documentation.
    mockRecord.mockResolvedValue(KNOWN);

    const { status, body } = await inspect(`id=${encodeURIComponent(KNOWN.id)}`);

    expect(status).toBe(200);
    expect(body.skill?.name).toBe("Expense Report");
    expect(body.skill?.needsRemoteDocs).toBe(true);
    expect(body.skill?.catalogMiss).toBeUndefined();
  });

  it("keeps answering a bare name so the related-skill chips still resolve", async () => {
    // A `related_skills` entry is a publisher-written NAME, not an identifier,
    // so it is never a key of the catalogue index. Refusing it here would
    // dead-end the chips on "not found" and phase 2 — which resolves on the
    // catalogue NAME — would never be asked.
    mockRecord.mockResolvedValue(undefined);

    const { status, body } = await inspect("id=vault");

    expect(status).toBe(200);
    expect(body.skill?.id).toBe("vault");
    expect(body.skill?.catalogMiss).toBe(true);
    expect(body.skill?.needsRemoteDocs).toBe(true);
  });
});
