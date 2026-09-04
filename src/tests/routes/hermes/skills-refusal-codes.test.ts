import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REQUEST_REFUSAL_CODES } from "@/lib/hermes-skills";

/**
 * TASK-658 — a rejection with no machine-readable code.
 *
 * The #586 pass gave the CLI failures a `code` and stopped there. Measured on a
 * Hermes box at beta 08e7057d, ten refusals still answered a fixed English
 * sentence and nothing else:
 *
 *   browse     Invalid page · Invalid size · Unknown source · Invalid provider
 *              Invalid trust · Invalid category · Invalid sort
 *   inspect    Invalid skill id
 *   uninstall  Invalid skill name · Invalid JSON
 *
 * Only "Invalid query" carried `bad_query`. A store that cannot read a code can
 * only string-match English — so every one of these rendered as the catalogue's
 * "couldn't load, retry", which is the wrong story AND a button that cannot
 * help: retrying sends the same rejected input.
 *
 * The invariant this pins is the one that keeps the next branch honest: EVERY
 * refusal from a skills route carries a code, and one that names a specific
 * input says which input it was.
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
  return { ...actual, loadCatalog: vi.fn(async () => null), warmIndex: vi.fn(), isWarming: vi.fn(() => false) };
});

type Body = { error?: string; code?: string; field?: string };

async function get(route: string, query: string): Promise<{ status: number; body: Body }> {
  const { GET } = await import(`@/app/setup-api/hermes/skills/${route}/route`);
  const res = await GET(new Request(`http://localhost/setup-api/hermes/skills/${route}?${query}`));
  return { status: res.status, body: (await res.json()) as Body };
}

async function post(route: string, payload: string): Promise<{ status: number; body: Body }> {
  const { POST } = await import(`@/app/setup-api/hermes/skills/${route}/route`);
  const res = await POST(
    new Request(`http://localhost/setup-api/hermes/skills/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    }),
  );
  return { status: res.status, body: (await res.json()) as Body };
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every refusal the OWNER's own input can cause, and the input it names. */
const OWNER_INPUT: { what: string; run: () => Promise<{ status: number; body: Body }>; field: string }[] = [
  { what: "browse ?page", run: () => get("browse", "page=notanumber"), field: "page" },
  { what: "browse ?size", run: () => get("browse", "size=999"), field: "size" },
  { what: "browse ?source", run: () => get("browse", "source=nope"), field: "source" },
  { what: "browse ?provider", run: () => get("browse", "provider=%3Bbad"), field: "provider" },
  { what: "browse ?trust", run: () => get("browse", "trust=nope"), field: "trust" },
  { what: "browse ?category", run: () => get("browse", "category=%3Bbad"), field: "category" },
  { what: "browse ?sort", run: () => get("browse", "sort=sideways"), field: "sort" },
  { what: "inspect ?id", run: () => get("inspect", "id=%3Bbad"), field: "id" },
  { what: "install body id", run: () => post("install", JSON.stringify({ id: ";bad" })), field: "id" },
  {
    what: "install body category",
    run: () => post("install", JSON.stringify({ id: "clawhub/pdf", category: ";bad" })),
    field: "category",
  },
  {
    what: "install body name",
    run: () => post("install", JSON.stringify({ id: "clawhub/pdf", name: "not a name" })),
    field: "name",
  },
  { what: "uninstall body id", run: () => post("uninstall", JSON.stringify({})), field: "id" },
  { what: "install malformed JSON", run: () => post("install", "notjson"), field: "body" },
  { what: "uninstall malformed JSON", run: () => post("uninstall", "notjson"), field: "body" },
  { what: "secrets ?keys", run: () => get("secrets", "keys=not-an-env-key"), field: "keys" },
];

describe("Hermes skills routes: every refusal carries a code", () => {
  it.each(OWNER_INPUT)("$what", async ({ run, field }) => {
    const { status, body } = await run();

    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
    expect(body.code).toBe("invalid_argument");
    // Which input was wrong — the whole point of the code. Without it the store
    // can only say "something you typed", which is not a next step.
    expect(body.field).toBe(field);
  });

  it("says too MANY facet values are too many, not that one of them is invalid", async () => {
    // The rail renders up to MAX_FACET_VALUES (24) options per group and had no
    // client cap, so ticking a 13th tripped MAX_FACET_SELECTION and rendered as
    // "couldn't load, retry" — a refusal the owner caused and could undo, told
    // as a device failure.
    const thirteen = Array.from({ length: 13 }, (_, i) => `provider=p${i}`).join("&");
    const { status, body } = await get("browse", thirteen);

    expect(status).toBe(400);
    expect(body.code).toBe("too_many_facets");
    expect(body.field).toBe("provider");
  });

  it("keeps every code it emits inside the shared vocabulary", () => {
    // A code the store's switch has never heard of falls through to the generic
    // line, which is the failure this card is about.
    expect([...REQUEST_REFUSAL_CODES].sort()).toEqual(
      ["invalid_argument", "not_found", "too_many_facets"].sort(),
    );
  });
});

describe("GET /setup-api/hermes/skills/installed — a failed read is not the exception's message", () => {
  it("answers a fixed sentence with a code and logs the reason", async () => {
    vi.doMock("@/lib/hermes-skills-server", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/hermes-skills-server")>();
      return {
        ...actual,
        enumerateInstalledSkills: vi.fn(async () => {
          throw new Error("EACCES: permission denied, scandir '/home/clawbox/.hermes/skills'");
        }),
      };
    });

    const { GET } = await import("@/app/setup-api/hermes/skills/installed/route");
    const res = await GET();
    const body = (await res.json()) as Body;

    expect(res.status).toBe(500);
    expect(body.code).toBe("cli_failed");
    // The browser never gets the device's absolute paths.
    expect(body.error).not.toMatch(/EACCES|\/home\/clawbox/);
    expect(console.error).toHaveBeenCalled();
  });
});
