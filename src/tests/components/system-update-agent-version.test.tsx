import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@/tests/helpers/test-utils";
import SystemUpdateApp from "@/components/SystemUpdateApp";

/**
 * TASK-548 — the System Update screen never named the agent the box runs.
 *
 * `/setup-api/update/versions` carries a `hermes` component on every SKU that
 * ships Hermes, and Settings -> About already renders it per edition. The
 * dedicated update screen — the one place an owner goes to ask "what version am
 * I on" — showed only ClawBox, so a Hermes owner could not read their agent's
 * version anywhere on it.
 */

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const clawbox = { current: "4.0.0", target: null, updateAvailable: false };

/** What `getVersionInfo()` really answers, per SKU. */
const payloads = {
  openclaw: {
    clawbox,
    openclaw: { current: "2026.8.1", target: "2026.8.1", updateAvailable: false },
    edition: "openclaw",
  },
  hermes: {
    clawbox,
    openclaw: { current: null, target: "2026.8.1", updateAvailable: false },
    hermes: { current: "0.20.5", target: null, updateAvailable: false },
    edition: "hermes",
  },
  dual: {
    clawbox,
    openclaw: { current: "2026.8.1", target: "2026.8.1", updateAvailable: false },
    hermes: { current: "0.20.5", target: null, updateAvailable: false },
    edition: "dual",
  },
  // A device that has not been updated yet still answers with the old
  // two-key shape: no `edition`, no `hermes`.
  legacy: { clawbox, openclaw: { current: "2026.7.1", target: "2026.7.1", updateAvailable: false } },
};

async function openUpdateScreen(versions: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/setup-api/update/versions")) return jsonResponse(versions);
      if (url.includes("/setup-api/update/status")) return jsonResponse({ phase: "idle", steps: [] });
      if (url.includes("/setup-api/system/update-branch")) return jsonResponse({ branch: null });
      return jsonResponse({});
    }),
  );

  render(<SystemUpdateApp />);
  await screen.findByText("You're up to date");

  // Scoped to the agent block: "OpenClaw" appears in the Advanced options prose
  // too, and an unscoped query there would pass on the wrong element.
  const heading = await screen.findByText("Agent");
  const block = heading.closest("[data-testid='agent-versions']");
  if (!block) throw new Error("agent version block not found");
  return within(block as HTMLElement);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("SystemUpdateApp — the agent version the box actually runs", () => {
  it("names Hermes and its version on the Hermes SKU", async () => {
    const block = await openUpdateScreen(payloads.hermes);

    expect(block.getByText("Hermes")).toBeTruthy();
    expect(block.getByText("0.20.5")).toBeTruthy();
  });

  it("does not offer an OpenClaw row on a device that ships no OpenClaw", async () => {
    const block = await openUpdateScreen(payloads.hermes);

    expect(block.queryByText("OpenClaw")).toBeNull();
  });

  it("names OpenClaw and its version on the OpenClaw SKU", async () => {
    const block = await openUpdateScreen(payloads.openclaw);

    expect(block.getByText("OpenClaw")).toBeTruthy();
    expect(block.getByText("2026.8.1")).toBeTruthy();
    expect(block.queryByText("Hermes")).toBeNull();
  });

  it("names both on the dual SKU, which really runs both", async () => {
    const block = await openUpdateScreen(payloads.dual);

    expect(block.getByText("OpenClaw")).toBeTruthy();
    expect(block.getByText("Hermes")).toBeTruthy();
  });

  it("falls through to the OpenClaw row on a payload that predates the edition field", async () => {
    const block = await openUpdateScreen(payloads.legacy);

    expect(block.getByText("OpenClaw")).toBeTruthy();
    expect(block.getByText("2026.7.1")).toBeTruthy();
  });
});

describe("SystemUpdateApp — the hero never offers an OpenClaw update on Hermes", () => {
  it("keeps OpenClaw out of the update headline there", async () => {
    // Guard, not a live defect: `updateAvailable` is false on that SKU today
    // only because `openclaw.current` is null. The headline must not depend on
    // that staying true.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/setup-api/update/versions")) {
          return jsonResponse({
            clawbox: { current: "4.0.0", target: "4.1.0", updateAvailable: true },
            openclaw: { current: "2026.7.1", target: "2026.8.1", updateAvailable: true },
            hermes: { current: "0.20.5", target: null, updateAvailable: false },
            edition: "hermes",
          });
        }
        if (url.includes("/setup-api/update/status")) return jsonResponse({ phase: "idle", steps: [] });
        if (url.includes("/setup-api/system/update-branch")) return jsonResponse({ branch: null });
        return jsonResponse({});
      }),
    );

    render(<SystemUpdateApp />);

    const subhead = await screen.findByText(/^New version available for /);
    expect(subhead.textContent).toBe("New version available for ClawBox.");
  });
});
