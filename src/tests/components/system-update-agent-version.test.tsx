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

/**
 * What `getVersionInfo()` really answers, per SKU — the SHAPES, not tidied
 * ones. `openclaw.current` is `openclaw --version` stdout, banner and all (the
 * same fixture the About suite uses); `hermes.current` has already been through
 * `parseHermesVersion` server-side, which is why it must not be parsed again
 * here.
 */
const OPENCLAW_BANNER = "OpenClaw 2026.7.1 (3e72c03)";
const payloads = {
  openclaw: {
    clawbox,
    openclaw: { current: OPENCLAW_BANNER, target: null, updateAvailable: false },
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
    openclaw: { current: OPENCLAW_BANNER, target: null, updateAvailable: false },
    hermes: { current: "0.20.5", target: null, updateAvailable: false },
    edition: "dual",
  },
  // A `hermes` block with no version: the probe failed. It is NOT "Hermes is
  // absent" — the key is only spread in on a box that ships Hermes.
  unprobed: {
    clawbox,
    openclaw: { current: null, target: "2026.8.1", updateAvailable: false },
    hermes: { current: null, target: null, updateAvailable: false },
    edition: "hermes",
  },
  // An unreleased Hermes build: `parseHermesVersion` found no semver-ish token
  // and returned the banner line as-is.
  devBuild: {
    clawbox,
    openclaw: { current: null, target: "2026.8.1", updateAvailable: false },
    hermes: { current: "Hermes Agent (dev build)", target: null, updateAvailable: false },
    edition: "hermes",
  },
  // Defensive only: the route always sets `edition` (updater.ts), and page and
  // route ship together — but the response is cast, not validated, so the
  // component still has to render something for a body without it.
  legacy: { clawbox, openclaw: { current: "2026.7.1", target: null, updateAvailable: false } },
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
    // The banner is cleaned for OpenClaw, whose grammar cleanVersion is for.
    expect(block.getByText("2026.7.1")).toBeTruthy();
    expect(block.queryByText("Hermes")).toBeNull();
  });

  it("does not re-parse a Hermes version the server already parsed", async () => {
    const block = await openUpdateScreen(payloads.devBuild);

    // cleanVersion would strip the trailing "(dev build)" — a grammar meant for
    // git-describe output, applied to a string parseHermesVersion owns. About
    // renders this field raw, and the desktop can show both windows at once.
    expect(block.getByText("Hermes Agent (dev build)")).toBeTruthy();
  });

  it("says nothing rather than 'not installed' when the version could not be read", async () => {
    const block = await openUpdateScreen(payloads.unprobed);

    // The payload only carries a `hermes` block on a box that HAS Hermes, so
    // null is a failed probe — which is what `hermes --version` does while the
    // update is moving the checkout aside.
    expect(block.getByText("Hermes")).toBeTruthy();
    expect(block.queryByText(/not installed/i)).toBeNull();
    expect(block.getByText("—")).toBeTruthy();
  });

  it("tells the owner both harnesses ride the ClawBox update", async () => {
    // HERMES_PIN_COMMIT (install.sh) is re-checked by step_hermes_install on
    // every update, exactly as config/openclaw-target.txt is for OpenClaw.
    // There is no way to update either one on its own, and saying otherwise
    // sends the owner looking for a button that does not exist.
    const block = await openUpdateScreen(payloads.dual);

    expect(block.getAllByText("Pinned by ClawBox — updated with it")).toHaveLength(2);
  });

  it("names both on the dual SKU, which really runs both", async () => {
    const block = await openUpdateScreen(payloads.dual);

    expect(block.getByText("OpenClaw")).toBeTruthy();
    expect(block.getByText("Hermes")).toBeTruthy();
  });

  it("renders an OpenClaw row for a body with no edition field at all", async () => {
    // Defensive, not a supported server shape: the response is cast rather than
    // validated, so the component still has to draw something.
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
