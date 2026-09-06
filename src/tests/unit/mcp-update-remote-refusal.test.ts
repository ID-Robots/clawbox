import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TASK-655. The same "up to date" claim, told to the model instead of the owner.
 *
 * GitHub refuses anonymous `git-upload-pack` POSTs from an address that has
 * made too many, so the device compares HEAD against the STALE refs its last
 * successful fetch left and finds no delta. `device_status` — the tool the MCP
 * server's own instructions tell every model to call FIRST for anything about
 * this device — turned that into `update.waiting: false`, and the owner asking
 * the assistant "am I on the latest version?" was told yes by a box that never
 * managed to ask.
 */

const { apiGet, apiTry } = vi.hoisted(() => ({ apiGet: vi.fn(), apiTry: vi.fn() }));

vi.mock("../../../mcp/lib/api", () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: vi.fn(),
  apiTry: (...a: unknown[]) => apiTry(...a),
  API_BASE: "http://127.0.0.1:80",
  CLAWBOX_ROOT: "/home/clawbox/clawbox",
}));

import type { McpContext } from "../../../mcp/lib/context";
import { captureRegistrar } from "../helpers/mcp-registrar";
import { registerOrientationTools } from "../../../mcp/tools/orientation";
import { registerSystemTools } from "../../../mcp/tools/system";

const REFUSAL_REASON =
  "GitHub refused this ClawBox's anonymous request for the update repository. "
  + "The repository is public and the device needs no password — GitHub answers 401 to anonymous git "
  + "requests from an address that has made too many. Try again in a few minutes.";

const ctx = (edition: "openclaw" | "hermes"): McpContext => ({
  edition,
  install: edition,
  appHarness: edition,
  profile: "full",
  capabilities: { screenGrabber: null, imageConvert: false, journal: false, du: false },
  providers: [],
  emailCanRead: false,
  codingAgent: false,
  canGenerateImages: true,
});

/** What a refused box's /update/versions really answers: no delta anywhere. */
const refusedPayload = (edition: "openclaw" | "hermes") => ({
  clawbox: { current: "v4.0.0", target: null, updateAvailable: false },
  openclaw: { current: "2026.8.1", target: null, updateAvailable: false },
  ...(edition === "hermes" ? { hermes: { current: "0.20.5", target: null, updateAvailable: false } } : {}),
  edition,
  remote: { reachable: false, refusedAnonymously: true, reason: REFUSAL_REASON },
});

async function deviceStatus(edition: "openclaw" | "hermes", payload: unknown) {
  apiTry.mockImplementation(async (path: string) =>
    path.includes("/setup-api/update/versions") ? payload : null,
  );
  const h = captureRegistrar(edition);
  registerOrientationTools(h.reg, ctx(edition));
  const out = await h.call("device_status", {});
  if (out.isError) throw new Error("device_status failed");
  return JSON.parse(out.text) as { update: Record<string, unknown> | string };
}

beforeEach(() => {
  apiGet.mockReset();
  apiTry.mockReset().mockResolvedValue(null);
});

describe("device_status does not tell the model an unreachable box is current", () => {
  for (const edition of ["openclaw", "hermes"] as const) {
    it(`answers "unknown", not false, on the ${edition} edition`, async () => {
      const body = await deviceStatus(edition, refusedPayload(edition));
      const update = body.update as Record<string, unknown>;

      expect(update.waiting).toBe("unknown");
      expect(String(update.check_failed)).toContain("anonymous");
    });
  }

  it("still answers false on a box that reached GitHub and is current", async () => {
    const body = await deviceStatus("openclaw", {
      ...refusedPayload("openclaw"),
      remote: { reachable: true },
    });
    const update = body.update as Record<string, unknown>;

    expect(update.waiting).toBe(false);
    expect(update).not.toHaveProperty("check_failed");
  });

  it("still answers false for a device whose software predates the field", async () => {
    // Absent is "not known", never "unreachable" — a mid-fleet update must not
    // make every older box start reporting a failed check.
    const payload = { ...refusedPayload("openclaw") } as Record<string, unknown>;
    delete payload.remote;

    const body = await deviceStatus("openclaw", payload);
    const update = body.update as Record<string, unknown>;

    expect(update.waiting).toBe(false);
  });
});

describe("update_check names the field so the model cannot ignore it", () => {
  it("passes remote through and tells the model what to do with it", async () => {
    apiGet.mockResolvedValue(refusedPayload("openclaw"));
    const h = captureRegistrar("openclaw");
    registerSystemTools(h.reg, ctx("openclaw"));

    const out = await h.call("update_check", {});
    if (out.isError) throw new Error(`update_check failed: ${JSON.stringify(out.error)}`);
    const body = JSON.parse(out.text) as Record<string, unknown>;

    expect(body.remote).toEqual({ reachable: false, refusedAnonymously: true, reason: REFUSAL_REASON });
    const described = h.tools.get("update_check")?.description ?? "";
    expect(described).toMatch(/remote\.reachable/);
  });
});
