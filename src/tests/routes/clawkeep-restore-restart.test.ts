import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a ClawKeep restore does AFTER the files are back.
 *
 * A restored directory is swapped in atomically, so a process that was already
 * running keeps reading the OLD inodes through the handles it holds. Unless the
 * process is bounced, the restore succeeds and the box keeps serving
 * pre-restore state — the false-success shape this codebase has shipped before.
 *
 * The bug this file locks down: on Hermes the route reached for
 * `sudo systemctl restart clawbox-hermes-dashboard.service`, and there is
 * deliberately no sudoers grant for any Hermes unit (a `restart` grant STARTS a
 * stopped unit, which is exactly how an OpenClaw box could resurrect the
 * dashboard its foreign-edition teardown had just disabled —
 * install-foreign-edition-teardown.test.ts owns that invariant). So the call
 * could only ever fail. On the owner's box the restore put every file back and
 * then reported it could not restart the agent.
 *
 * The fix is not a new grant. `bounceHermesDashboard()` stops the dashboard as
 * the clawbox user that already owns the process and lets the unit's
 * `Restart=always` bring it back: no privilege, and a stop can never resurrect
 * a unit that is down. These tests assert BOTH halves — that the Hermes path
 * bounces and never shells out to sudo, and that a failure is still reported
 * rather than swallowed.
 */

const h = vi.hoisted(() => ({
  edition: "openclaw" as string,
  bounce: "restarted" as "restarted" | "pending" | "failed",
  bounceCalls: 0,
  execCalls: [] as { file: string; args: string[] }[],
  execFailure: null as string | null,
  gatewayUp: true,
  ownerSession: true,
  sameOrigin: true,
  restoreCalls: 0,
}));

// A restore is OWNER-ONLY and same-origin: middleware admits the MCP bearer to
// every /setup-api route, and there is deliberately no MCP tool for a restore,
// so the route re-checks. These cases are about what the OWNER gets, so both
// answer yes; the refusal itself is asserted in its own block below.
vi.mock("@/lib/owner-session", () => ({
  hasOwnerSession: vi.fn(async () => h.ownerSession),
}));
vi.mock("@/lib/same-origin", () => ({
  isSameOriginRequest: vi.fn(() => h.sameOrigin),
}));

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void,
  ) => {
    h.execCalls.push({ file, args });
    if (h.execFailure) cb(new Error(h.execFailure));
    else cb(null, { stdout: "", stderr: "" });
  },
}));

vi.mock("@/lib/harness", () => ({ getEdition: () => h.edition }));

// The gateway's readiness after the restart, as a single answer.
vi.mock("@/lib/port-probe", async (orig) => ({
  ...(await orig<typeof import("@/lib/port-probe")>()),
  waitForPortOpen: async () => h.gatewayUp,
}));

vi.mock("@/lib/hermes-dashboard-control", () => ({
  bounceHermesDashboard: async () => {
    h.bounceCalls += 1;
    return h.bounce;
  },
}));

vi.mock("@/lib/clawkeep", () => ({
  ClawKeepError: class ClawKeepError extends Error {
    status = 500;
  },
  RestoreNeedsPassphraseError: class RestoreNeedsPassphraseError extends Error {
    status = 401;
    kind = "passphrase_missing";
  },
  runRestore: async () => {
    h.restoreCalls += 1;
    return {
      archive: "2026-08-28T00-00-00.000Z-openclaw-backup.tar.gz",
      archiveBytes: 4096,
      assets: [],
      skippedMembers: [],
    };
  },
}));

import type { NextRequest } from "next/server";

import { POST } from "@/app/setup-api/clawkeep/restore/route";
import { HERMES_DASHBOARD_UNIT } from "@/lib/hermes-dashboard-auth";

const post = () =>
  POST(
    new Request("http://localhost/setup-api/clawkeep/restore", {
      method: "POST",
      body: JSON.stringify({ name: "2026-08-28T00-00-00.000Z-openclaw-backup.tar.gz" }),
    }) as unknown as NextRequest,
  );

beforeEach(() => {
  h.edition = "openclaw";
  h.bounce = "restarted";
  h.bounceCalls = 0;
  h.execCalls.length = 0;
  h.execFailure = null;
  h.gatewayUp = true;
  h.ownerSession = true;
  h.sameOrigin = true;
  h.restoreCalls = 0;
});

describe("POST /setup-api/clawkeep/restore — who may ask", () => {
  // The MCP bearer is a valid credential to middleware and no credential at
  // all here: a restore swaps the agent's whole state for a snapshot that
  // anyone paired to the account could have uploaded, and mcp/tools/system.ts
  // says out loud that restoring is not a tool. The route used to take
  // middleware's word for it.
  it("refuses the MCP bearer (no session cookie) with 403 owner_only and never restores", async () => {
    h.ownerSession = false;
    const res = await post();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("owner_only");
    // `kind` too: the field every other clawkeep refusal is keyed on.
    expect(body.kind).toBe("owner_only");
    expect(h.restoreCalls).toBe(0);
    // Nothing downstream either: no restart of a state holder that did not
    // change.
    expect(h.execCalls).toEqual([]);
    expect(h.bounceCalls).toBe(0);
  });

  it("refuses a cookie-bearing POST from another origin, before reading the body", async () => {
    // The browser attaches the owner's cookie to a POST any page fires at the
    // box, and `request.json()` here does not care about Content-Type, so a
    // cookie-only gate would still do that page's bidding.
    h.sameOrigin = false;
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("owner_only");
    expect(h.restoreCalls).toBe(0);
  });

  it("lets the owner's own page through", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(h.restoreCalls).toBe(1);
  });
});

describe("POST /setup-api/clawkeep/restore — bringing the state holder back", () => {
  it("restarts clawbox-gateway.service through the grant that exists for it", async () => {
    const body = await (await post()).json();
    expect(body.ok).toBe(true);
    expect(body.restartErrors).toEqual([]);
    expect(body.restartPending).toEqual([]);
    expect(h.execCalls).toEqual([
      {
        file: "/usr/bin/sudo",
        args: ["/usr/bin/systemctl", "restart", "clawbox-gateway.service"],
      },
    ]);
    // The .service spelling is load-bearing: sudoers Cmnd_Spec is exact-string,
    // so a bare "clawbox-gateway" would not match the granted rule.
    expect(h.execCalls[0].args[2]).toBe("clawbox-gateway.service");
  });

  it("reports an OpenClaw restart failure instead of swallowing it", async () => {
    h.execFailure = "Command failed: sudo: a password is required";
    const body = await (await post()).json();
    expect(body.ok).toBe(true);
    expect(body.restartErrors).toHaveLength(1);
    expect(body.restartErrors[0]).toMatch(/^clawbox-gateway\.service: /);
    expect(body.restartErrors[0]).toContain("a password is required");
    expect(body.restartPending).toEqual([]);
  });

  it("does not call the OpenClaw restore done until the gateway is serving again", async () => {
    // `systemctl restart` on a Type=simple unit returns when the process is
    // forked. Reporting no restart errors there told the owner the restored
    // state was being served while the gateway was still starting — and the
    // Hermes half of this same function no longer does that.
    h.gatewayUp = false;
    const body = await (await post()).json();
    expect(body.ok).toBe(true);
    expect(body.restartPending).toHaveLength(1);
    expect(body.restartPending[0].startsWith("clawbox-gateway.service: ")).toBe(true);
  });

  it("does not call a gateway that is still binding a FAILED restart", async () => {
    // The restart happened — `systemctl restart` exited 0 — and the gateway is
    // re-reading the state files the restore just replaced, which is the
    // slowest start this box performs. `restartErrors` is the array the result
    // card turns into "Could not auto-restart 1 service(s). Run
    // `sudo systemctl restart clawbox-gateway.service` manually", so putting a
    // still-binding gateway in it tells the owner to kill a service mid-boot
    // and, on a couple of repeats, to trip StartLimitBurst. A pending restart
    // travels in its own field precisely so it cannot be rendered as a failure.
    h.gatewayUp = false;
    const body = await (await post()).json();
    expect(body.restartErrors).toEqual([]);
  });

  // THE REGRESSION. This used to be a sudo call that could not succeed.
  it("bounces the Hermes dashboard without sudo, and never shells out", async () => {
    h.edition = "hermes";
    const body = await (await post()).json();
    expect(body.ok).toBe(true);
    expect(h.bounceCalls).toBe(1);
    expect(body.restartErrors).toEqual([]);
    expect(body.restartPending).toEqual([]);
    // Not "did not call sudo on the dashboard" — did not call sudo AT ALL.
    // A Hermes box has no clawbox-gateway either, so any exec here is wrong.
    expect(h.execCalls).toEqual([]);
  });

  it("still tells the owner when the Hermes bounce did not take", async () => {
    h.edition = "hermes";
    h.bounce = "failed";
    const body = await (await post()).json();
    expect(body.ok).toBe(true);
    expect(h.execCalls).toEqual([]);
    expect(body.restartErrors).toHaveLength(1);
    // The result card parses the unit off the front of this string to print
    // `sudo systemctl restart <unit>`, so the prefix has to stay a unit name.
    expect(body.restartErrors[0].startsWith(`${HERMES_DASHBOARD_UNIT}: `)).toBe(true);
    expect(body.restartPending).toEqual([]);
  });

  it("does not call a Hermes dashboard that is still coming back a failed bounce", async () => {
    // `bounceHermesDashboard()` answers "pending" when the stop TOOK and
    // `Restart=always` has not finished bringing the dashboard back inside the
    // budget. Nothing is wrong there and there is nothing for the owner to do
    // — and the manual command the card prints for a failure is `systemctl
    // restart` over a unit systemd is already restarting.
    h.edition = "hermes";
    h.bounce = "pending";
    const body = await (await post()).json();
    expect(body.ok).toBe(true);
    expect(h.execCalls).toEqual([]);
    expect(body.restartErrors).toEqual([]);
    expect(body.restartPending).toHaveLength(1);
    expect(body.restartPending[0].startsWith(`${HERMES_DASHBOARD_UNIT}: `)).toBe(true);
  });

  it("never restarts the OpenClaw gateway on a Hermes box", async () => {
    // install.sh removes AND masks clawbox-gateway on Hermes, so restarting it
    // there fails twice over — and reporting that failure to the owner points
    // them at a unit that does not exist on their device.
    h.edition = "hermes";
    await post();
    expect(h.execCalls.some((c) => c.args.join(" ").includes("clawbox-gateway"))).toBe(false);
  });
});
