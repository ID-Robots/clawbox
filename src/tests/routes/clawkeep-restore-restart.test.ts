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
  bounce: true,
  bounceCalls: 0,
  execCalls: [] as { file: string; args: string[] }[],
  execFailure: null as string | null,
  gatewayUp: true,
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
  runRestore: async () => ({
    archive: "2026-08-28T00-00-00.000Z-openclaw-backup.tar.gz",
    archiveBytes: 4096,
    assets: [],
    skippedMembers: [],
  }),
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
  h.bounce = true;
  h.bounceCalls = 0;
  h.execCalls.length = 0;
  h.execFailure = null;
  h.gatewayUp = true;
});

describe("POST /setup-api/clawkeep/restore — bringing the state holder back", () => {
  it("restarts clawbox-gateway.service through the grant that exists for it", async () => {
    const body = await (await post()).json();
    expect(body.ok).toBe(true);
    expect(body.restartErrors).toEqual([]);
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
  });

  it("does not call the OpenClaw restore done until the gateway is serving again", async () => {
    // `systemctl restart` on a Type=simple unit returns when the process is
    // forked. Reporting no restart errors there told the owner the restored
    // state was being served while the gateway was still starting — and the
    // Hermes half of this same function no longer does that.
    h.gatewayUp = false;
    const body = await (await post()).json();
    expect(body.ok).toBe(true);
    expect(body.restartErrors).toHaveLength(1);
    expect(body.restartErrors[0].startsWith("clawbox-gateway.service: ")).toBe(true);
  });

  // THE REGRESSION. This used to be a sudo call that could not succeed.
  it("bounces the Hermes dashboard without sudo, and never shells out", async () => {
    h.edition = "hermes";
    const body = await (await post()).json();
    expect(body.ok).toBe(true);
    expect(h.bounceCalls).toBe(1);
    expect(body.restartErrors).toEqual([]);
    // Not "did not call sudo on the dashboard" — did not call sudo AT ALL.
    // A Hermes box has no clawbox-gateway either, so any exec here is wrong.
    expect(h.execCalls).toEqual([]);
  });

  it("still tells the owner when the Hermes bounce did not take", async () => {
    h.edition = "hermes";
    h.bounce = false;
    const body = await (await post()).json();
    expect(body.ok).toBe(true);
    expect(h.execCalls).toEqual([]);
    expect(body.restartErrors).toHaveLength(1);
    // The result card parses the unit off the front of this string to print
    // `sudo systemctl restart <unit>`, so the prefix has to stay a unit name.
    expect(body.restartErrors[0].startsWith(`${HERMES_DASHBOARD_UNIT}: `)).toBe(true);
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
