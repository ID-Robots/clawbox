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

// Left unmocked, `findInstalledSkill` walks the REAL ~/.hermes/skills: it passes
// here and in CI because that directory is absent, and would flip the second
// case below to the installed branch on a Hermes DEVICE — which is where the
// working rules say to run the suites. The whole point of this PR is that the
// device is the authority, so its own test must not depend on the host's skill
// directory.
vi.mock("@/lib/hermes-skills-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hermes-skills-server")>();
  return { ...actual, findInstalledSkill: vi.fn(async () => null) };
});

import { getCatalogRecord, type CatalogRecord } from "@/lib/hermes-skill-index";
import { runSkillsCli } from "@/lib/hermes-skills-cli";

const mockRecord = vi.mocked(getCatalogRecord);
const mockCli = vi.mocked(runSkillsCli);

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
      code?: string;
      ambiguous?: boolean;
      candidates?: { id: string }[];
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

/**
 * "Exit 0 and no skill panel" is a CLASS of outcomes, not one.
 *
 * This repo's own `parseInstallOutcome` already names them: a disambiguation
 * table, a "did you mean" list, "No skill named 'x' found in any source", "no
 * source adapter for 'x'", "Could not fetch 'x' from any source" and the rate
 * limit behind it — and the module header states the rule plainly: it fails to
 * download and exits 0. Only ONE of those means the skill does not exist.
 *
 * Answering the whole class `404 not_found` is what lets both consumers say so
 * out loud: the agent is told "Hermes does not have it. Do not guess ids." and
 * the owner is told the skill "isn't on this device or in the skill store".
 * Over a real `github/*` row opened while the unauthenticated GitHub API is
 * rate-limited — a state this codebase models explicitly — both are false, and
 * the second is a claim about the store the device never asked about.
 */
describe("GET …/inspect?docs=1 — what the CLI actually said", () => {
  function cliSaid(stdout: string) {
    mockCli.mockResolvedValue({ code: 0, stdout, stderr: "" } as Awaited<ReturnType<typeof runSkillsCli>>);
  }

  it("does not call a skill nonexistent because its source could not be reached", async () => {
    mockRecord.mockResolvedValue(undefined);
    cliSaid("Resolving 'github/acme/thing'...\nCould not fetch 'github/acme/thing' from any source.\n");

    const { status, body } = await inspect("id=github%2Facme%2Fthing&docs=1");

    expect(status).not.toBe(404);
    expect(body.code).not.toBe("not_found");
  });

  it("does not call a skill nonexistent when the registry rate limit is exhausted", async () => {
    mockRecord.mockResolvedValue(undefined);
    cliSaid("Resolving 'github/acme/thing'...\nCould not fetch 'github/acme/thing' from any source. GitHub API rate limit exhausted.\n");

    const { status, body } = await inspect("id=github%2Facme%2Fthing&docs=1");

    expect(status).not.toBe(404);
    expect(body.code).not.toBe("not_found");
  });

  it("still answers not_found for the sentences that mean it", async () => {
    // Both measured on the Hermes box, and both in the CLI's own source
    // (`hermes_cli/skills_hub.py`): a BARE NAME the short-name resolver could
    // not match (:94), and a PREFIXED id whose source returned no metadata
    // (:864). One word — find versus fetch — separates the second from the
    // download failure above, which means the opposite.
    mockRecord.mockResolvedValue(undefined);

    cliSaid("Resolving 'definitely-not-a-real-skill-xyz-42'...\nError: No skill named 'definitely-not-a-real-skill-xyz-42' found in any source.\n");
    const bare = await inspect("id=definitely-not-a-real-skill-xyz-42&docs=1");
    expect(bare.status).toBe(404);
    expect(bare.body.code).toBe("not_found");

    cliSaid("Resolving 'github/nonexistent-owner-xyz/nope'...\nError: Could not find 'github/nonexistent-owner-xyz/nope' in any source.\n");
    const prefixed = await inspect("id=github%2Fnonexistent-owner-xyz%2Fnope&docs=1");
    expect(prefixed.status).toBe(404);
    expect(prefixed.body.code).toBe("not_found");
  });

  it("does not call a skill nonexistent when the source prefix has no adapter", async () => {
    mockRecord.mockResolvedValue(undefined);
    cliSaid("Resolving 'weird/thing'...\nError: no source adapter for 'weird'.\n");

    const { status, body } = await inspect("id=weird%2Fthing&docs=1");

    expect(status).not.toBe(404);
    expect(body.code).not.toBe("not_found");
  });

  it("offers the candidates of a \"did you mean\" list instead of dead-ending", async () => {
    // Measured on the box for `hermes skills inspect pdf` — and `pdf` is the
    // id `skill_info`'s own schema gives as an example, so a model that
    // shortens `official/pdf` lands here. The suggestions are printed on
    // stdout; refusing with "do not guess ids" throws them away.
    mockRecord.mockResolvedValue(undefined);
    cliSaid(
      "Resolving 'pdf'...\nNo exact match for 'pdf'. Did you mean one of these?\n"
      + "  Extract Document Data — browse-sh/reducto.ai/extract-document-data\n"
      + "  Search Patents — browse-sh/uspto.gov/search-patents-nwh84a\n",
    );

    const { status, body } = await inspect("id=pdf&docs=1");

    expect(status).toBe(200);
    expect(body.ambiguous).toBe(true);
    expect((body.candidates ?? []).map((c) => c.id)).toContain("browse-sh/reducto.ai/extract-document-data");
  });
});
