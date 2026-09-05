import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TASK-543 — `update_check` handed the agent an OpenClaw version block on a
 * device that ships no OpenClaw.
 *
 * `/setup-api/update/versions` always carries an `openclaw` component, and
 * `getVersionInfo()` fills its `target` from the ClawBox pin even when
 * `current` is null — so on the Hermes SKU the raw payload reads
 * `openclaw: { current: null, target: "<pin>" }`: a version to converge on for
 * a harness the box does not have. `device_status`, reading the SAME payload in
 * the same MCP server, drops that key on purpose. Two tools, one payload,
 * opposite honesty.
 *
 * The property pinned here is the agreement, not one tool's shape: whichever
 * tool the agent calls, the OpenClaw block is present exactly when the device
 * really ships OpenClaw.
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

type Install = "openclaw" | "hermes" | "dual";

const ctx = (edition: "openclaw" | "hermes", install: Install = edition): McpContext => ({
  edition,
  install,
  appHarness: edition,
  profile: "full",
  capabilities: { screenGrabber: null, imageConvert: false, journal: false, du: false },
  providers: [],
  emailCanRead: false,
  codingAgent: false,
  canGenerateImages: true,
});

/** The shape `getVersionInfo()` really returns, per SKU. */
const payload = (edition: Install) => ({
  clawbox: { current: "v4.0.0", target: null, updateAvailable: false },
  openclaw: { current: edition === "hermes" ? null : "2026.8.1", target: "2026.8.1", updateAvailable: false },
  ...(edition === "openclaw" ? {} : { hermes: { current: "0.20.5", target: null, updateAvailable: false } }),
  edition,
});

async function updateCheck(edition: "openclaw" | "hermes", install: Install = edition) {
  const h = captureRegistrar(edition);
  registerSystemTools(h.reg, ctx(edition, install));
  const out = await h.call("update_check", {});
  if (out.isError) throw new Error(`update_check failed: ${JSON.stringify(out.error)}`);
  return JSON.parse(out.text) as Record<string, unknown>;
}

async function deviceStatus(edition: "openclaw" | "hermes", install: Install = edition) {
  const h = captureRegistrar(edition);
  registerOrientationTools(h.reg, ctx(edition, install));
  const out = await h.call("device_status", {});
  if (out.isError) throw new Error("device_status failed");
  return JSON.parse(out.text) as { update: Record<string, unknown> | string };
}

beforeEach(() => {
  apiGet.mockReset();
  apiTry.mockReset().mockResolvedValue(null);
});

describe("update_check — no OpenClaw block on a device that ships no OpenClaw", () => {
  it("drops the openclaw component on the Hermes SKU", async () => {
    apiGet.mockResolvedValue(payload("hermes"));

    const body = await updateCheck("hermes");

    expect(body).not.toHaveProperty("openclaw");
  });

  it("still reports the ClawBox and Hermes components there", async () => {
    apiGet.mockResolvedValue(payload("hermes"));

    const body = await updateCheck("hermes");

    expect(body.clawbox).toEqual({ current: "v4.0.0", target: null, updateAvailable: false });
    expect(body.hermes).toEqual({ current: "0.20.5", target: null, updateAvailable: false });
  });

  it("keeps the openclaw component on the OpenClaw SKU", async () => {
    apiGet.mockResolvedValue(payload("openclaw"));

    const body = await updateCheck("openclaw");

    expect(body.openclaw).toEqual({ current: "2026.8.1", target: "2026.8.1", updateAvailable: false });
  });

  it("keeps it on the dual SKU, where OpenClaw is installed even while Hermes answers", async () => {
    apiGet.mockResolvedValue(payload("dual"));

    const body = await updateCheck("hermes", "dual");

    expect(body).toHaveProperty("openclaw");
  });

  it("believes the payload's own edition over a stale startup snapshot", async () => {
    // ctx.install is resolved once when the MCP child spawns. The payload's
    // `edition` is read per call from the root-owned edition lock, so it is the
    // one that decides.
    apiGet.mockResolvedValue(payload("hermes"));

    const body = await updateCheck("openclaw", "openclaw");

    expect(body).not.toHaveProperty("openclaw");
  });
});

describe("update_check and device_status agree about the OpenClaw block", () => {
  const versionsOnly = (edition: Install) =>
    apiTry.mockImplementation(async (route: unknown) =>
      route === "/setup-api/update/versions" ? payload(edition) : null,
    );

  it("both omit it on Hermes", async () => {
    apiGet.mockResolvedValue(payload("hermes"));
    versionsOnly("hermes");

    expect(await updateCheck("hermes")).not.toHaveProperty("openclaw");
    expect((await deviceStatus("hermes")).update).not.toHaveProperty("openclaw");
  });

  it("both carry it on dual, where the device really has an OpenClaw to update", async () => {
    apiGet.mockResolvedValue(payload("dual"));
    versionsOnly("dual");

    expect(await updateCheck("hermes", "dual")).toHaveProperty("openclaw");
    expect((await deviceStatus("hermes", "dual")).update).toHaveProperty("openclaw");
  });
});
