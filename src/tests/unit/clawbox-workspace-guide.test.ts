import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The guide ClawBox seeds into the OpenClaw workspace as `CLAWBOX.md`
 * (scripts/gateway-pre-start.sh) is the agent's only source of ClawBox-specific
 * conventions, so what it forbids is as load-bearing as what it offers.
 *
 * TASK-612: asked "restart the gateway", the agent reached for OpenClaw's
 * operator-approval path — the native `approval.request` RPC behind the
 * `operator.approvals` scope, which is the right mechanism on a box whose
 * operator surface renders it. ClawBox's chat renders nothing of the kind
 * today, so the proposal sat unanswered until the run ended or a gateway
 * restart cancelled it (`operator_approval_cancelled_gateway_restart`), and
 * the owner was told the restart was waiting for an approval they had nowhere
 * to give. Until that card exists (follow-up under TASK-604), the guide has to
 * name the owner's real path — Settings -> System — and forbid the queue.
 *
 * Asserted against the section, not the whole file, so a failure prints the
 * paragraph that is wrong rather than the entire guide.
 */

const GUIDE_PATH = path.join(process.cwd(), "config/clawbox-workspace-guide.md");
const GUIDE = readFileSync(GUIDE_PATH, "utf-8");

/** The `## System actions and restarts` section, without its neighbours. */
function systemActionsSection(): string {
  const start = GUIDE.search(/^## .*\bSystem actions\b/im);
  if (start < 0) return "";
  const rest = GUIDE.slice(start);
  const next = rest.slice(1).search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("the ClawBox workspace guide (CLAWBOX.md)", () => {
  it("carries a section on system actions and restarts", () => {
    expect(systemActionsSection().slice(0, 80)).toMatch(/^## .*System actions/);
  });

  it("separates the gateway restart it refuses from the device restart it owns", () => {
    const section = systemActionsSection();
    // The gateway restart, by name and with a reason the agent can act on.
    expect(section.toLowerCase()).toContain("gateway");
    expect(section).toMatch(/not yours|is not yours to do/i);
    // And the capability the device actually ships, which an earlier draft of
    // this section denied outright ("you have no tool for any of them") — the
    // guide would then have talked a confirm-gated, owner-consented tool out
    // of existence. mcp/tools/system.ts registers it on both editions.
    expect(section).toContain("system_power");
  });

  it("names controls that exist: the tray power menu, and Settings -> System for what is there", () => {
    const section = systemActionsSection();
    // Settings -> System carries the harness picker, the performance mode, the
    // read-only stats and the password — no power control (SettingsApp.tsx).
    // Sending the owner there for a restart is the wrong screen.
    expect(section).toMatch(/power menu/i);
    expect(section).toMatch(/Settings\s*→\s*System/);
    // And it must tell the agent to SAY where the control is, not just decline.
    expect(section).toMatch(/say that|answer with|tell (?:the owner|them)|point (?:the owner|them)/i);
  });

  it("forbids queueing an operator-approval proposal, and names the way to answer a parked one", () => {
    const section = systemActionsSection();
    // The native id, so the instruction names what the agent would actually
    // reach for rather than a paraphrase of it.
    expect(section).toContain("operator_approval");
    expect(section).toMatch(/never\s+(?:queue|propose|raise|open)|do not\s+queue|don't\s+queue/i);
    // "nowhere to answer it" would be false: the CLI resolves one, and the
    // desktop ships a Terminal app.
    expect(section).toContain("openclaw approvals");
  });
});
