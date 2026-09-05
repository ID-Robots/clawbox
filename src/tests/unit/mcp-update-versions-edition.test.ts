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

/**
 * The shape `getVersionInfo()` really returns, per SKU — including the detail
 * this card is about: `openclaw.target` is the ClawBox pin even where
 * `openclaw.current` is null, because the producer only nulls the target when a
 * current version exists and already contains it.
 */
const payload = (edition: Install) =>
  edition === "hermes"
    ? {
        clawbox: { current: "v4.0.0", target: null, updateAvailable: false },
        openclaw: { current: null, target: "2026.8.1", updateAvailable: false },
        hermes: { current: "0.20.5", target: null, updateAvailable: false },
        edition,
      }
    : {
        clawbox: { current: "v4.0.0", target: null, updateAvailable: false },
        openclaw: { current: "2026.8.1", target: null, updateAvailable: false },
        ...(edition === "dual" ? { hermes: { current: "0.20.5", target: null, updateAvailable: false } } : {}),
        edition,
      };

/** A box where only the OpenClaw pin moved — ClawBox itself is current. */
const openclawDeltaOnly = (edition: Install) => ({
  clawbox: { current: "v4.0.0", target: null, updateAvailable: false },
  openclaw: { current: "2026.7.1", target: "2026.8.1", updateAvailable: true },
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

    expect(body.openclaw).toEqual({ current: "2026.8.1", target: null, updateAvailable: false });
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
    const { update } = await deviceStatus("hermes");
    // Positively, first: when the versions leg returns null `update` degrades to
    // the string "unknown", and every `not.toHaveProperty` below would pass over
    // a mock that answered nothing at all.
    expect(update).toHaveProperty("clawbox");
    expect(update).not.toHaveProperty("openclaw");
  });

  it("both carry it on dual, where the device really has an OpenClaw to update", async () => {
    apiGet.mockResolvedValue(payload("dual"));
    versionsOnly("dual");

    expect(await updateCheck("hermes", "dual")).toHaveProperty("openclaw");
    expect((await deviceStatus("hermes", "dual")).update).toHaveProperty("openclaw");
  });
});

describe("device_status names the harness this box actually runs", () => {
  const versions = (edition: Install) =>
    apiTry.mockImplementation(async (route: unknown) =>
      route === "/setup-api/update/versions" ? payload(edition) : null,
    );

  async function update(edition: "openclaw" | "hermes", install: Install) {
    versions(install);
    const { update: block } = await deviceStatus(edition, install);
    if (typeof block === "string") throw new Error("versions leg returned nothing");
    return block;
  }

  it("reports the Hermes version on the Hermes SKU", async () => {
    // The tool the server's instructions tell every model to call FIRST. With
    // no answer here, "what version of Hermes am I running" is answered from
    // training memory.
    expect(await update("hermes", "hermes")).toMatchObject({
      hermes: { current: "0.20.5", target: null, updateAvailable: false },
    });
  });

  it("reports it on dual too, beside the OpenClaw block", async () => {
    const block = await update("hermes", "dual");
    expect(block).toHaveProperty("hermes");
    expect(block).toHaveProperty("openclaw");
  });

  it("says nothing about Hermes on a SKU that does not ship it", async () => {
    expect(await update("openclaw", "openclaw")).not.toHaveProperty("hermes");
  });
});

describe("device_status — an OpenClaw pin delta is an update waiting on the SKUs that have one", () => {
  const versions = (edition: Install) =>
    apiTry.mockImplementation(async (route: unknown) =>
      route === "/setup-api/update/versions" ? openclawDeltaOnly(edition) : null,
    );

  async function waiting(edition: "openclaw" | "hermes", install: Install) {
    versions(install);
    const { update } = await deviceStatus(edition, install);
    if (typeof update === "string") throw new Error("versions leg returned nothing");
    return update.waiting;
  }

  it("reports it on dual, where Hermes may be the harness answering but OpenClaw is installed", async () => {
    expect(await waiting("hermes", "dual")).toBe(true);
  });

  it("still reports it on the OpenClaw SKU", async () => {
    expect(await waiting("openclaw", "openclaw")).toBe(true);
  });

  it("does not report it on Hermes, where there is no OpenClaw to install", async () => {
    expect(await waiting("hermes", "hermes")).toBe(false);
  });
});

describe("shipsOpenclaw fails closed when the edition lock cannot be read", () => {
  it("keeps the block off on a Hermes box whose lock resolved to the openclaw default", async () => {
    // `mcp/lib/edition.ts` resolves an unreadable /etc/clawbox/edition.env to
    // the SMALLER hermes tool set while `readEdition()` — behind both
    // `payload.edition` and `ctx.install` — defaults to "openclaw". Trusting
    // either of those alone would hand the block back on exactly the box this
    // card is about.
    apiGet.mockResolvedValue(payload("openclaw"));

    const body = await updateCheck("hermes", "openclaw");

    expect(body).not.toHaveProperty("openclaw");
  });
});
