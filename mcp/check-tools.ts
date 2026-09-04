#!/usr/bin/env bun
/**
 * Tool-surface checker. Run it after any change to mcp/**:
 *
 *   bun run mcp/check-tools.ts
 *
 * It builds the server ONCE PER EDITION without connecting a transport, and:
 *   1. asserts the tool contract (name regex, description length and banned
 *      phrases, parameter-name regex, readOnly/destructive coherence);
 *   2. prints the registration matrix — which tools each edition gets — and
 *      fails if a Hermes device would be offered an OpenClaw-only tool or the
 *      other way round;
 *   3. reports the approximate tools/list schema size, which is the budget that
 *      matters on a device running a 4-8B local model.
 *
 * It is a script rather than a vitest file because the vitest projects only
 * include src/tests/**, and because building the server needs the real device
 * probes, which belong in a deliberate command and not in the unit suite.
 */

process.env.CLAWBOX_MCP_NO_AUTOSTART = "1";

import { z } from "zod";
import { contractViolations, type RegisteredToolInfo } from "./lib/register";

const HERMES_ONLY = ["skill_search", "skill_list", "skill_info", "skill_install", "skill_uninstall", "ai_list_models", "ai_set_provider", "ai_set_model"];
// backup_list / backup_now are here because ClawKeep archives the OpenClaw
// agent through the openclaw CLI: on Hermes the feature reports
// supportedOnEdition:false and there is nothing to list or write.
const OPENCLAW_ONLY = ["app_search", "app_install", "bash", "job_status", "job_stop", "read_file", "write_file", "edit_file", "list_directory", "glob", "grep", "notebook_edit", "web_fetch", "web_search", "browser_click", "browser_type", "browser_keypress", "browser_scroll", "backup_list", "backup_now"];

/** The real tools/list payload: what the model actually pays for. */
function schemaBytes(tools: RegisteredToolInfo[]): number {
  const listing = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(z.object(t.shape), { io: "input" }),
    annotations: {
      readOnlyHint: t.opts.readOnly === true,
      destructiveHint: t.opts.destructive === true,
      openWorldHint: t.opts.openWorld === true,
    },
  }));
  return JSON.stringify({ tools: listing }).length;
}

/** Emitted JSON Schema must stay flat: no $ref, no anyOf, no oneOf/allOf. */
function schemaShapeViolations(tool: RegisteredToolInfo): string[] {
  const emitted = JSON.stringify(z.toJSONSchema(z.object(tool.shape), { io: "input" }));
  return ["$ref", "anyOf", "oneOf", "allOf", "definitions", "$defs"]
    .filter((bad) => emitted.includes(`"${bad}"`))
    .map((bad) => `${tool.name}: emitted JSON Schema contains ${bad}`);
}

/**
 * Every capability on.
 *
 * The registrars gate whole tool families on a device probe — `du`,
 * `journalctl`, a screen grabber, a readable mailbox, the coding harness, an
 * image backend, the Hermes provider list. Off a real box every probe answers
 * false (mcp/lib/guard.ts spawns in CLAWBOX_ROOT, which exists on a device and
 * nowhere else), so building the server the ordinary way here would examine a
 * FRACTION of the surface and print "Tool contract OK" over the rest: measured
 * on the dev PC, `du` is installed and none of disk_usage, disk_cleanup,
 * logs_tail or screen_capture appeared in this checker's own matrix. That is a
 * false success, and the reason CI could not run this job as it stood.
 *
 * So the contract is checked over BOTH postures — what this host can actually
 * probe, and the full surface a real box registers — exactly as the unit guard
 * in src/tests/unit/mcp-tool-honesty.test.ts does.
 */
const ALL_CAPABILITIES = {
  capabilities: { screenGrabber: "scrot", imageConvert: true, journal: true, du: true },
  emailCanRead: true,
  codingAgent: true,
  canGenerateImages: true,
  providers: ["anthropic", "openai"],
};

async function main(): Promise<void> {
  const { buildServer } = await import("./clawbox-mcp");
  const problems: string[] = [];
  const byEdition: Record<string, RegisteredToolInfo[]> = {};
  let probedAnything = false;

  for (const edition of ["openclaw", "hermes"] as const) {
    // The app harness is the edition being simulated: this walks each
    // edition's tool list, so an app gate resolving to anything else would
    // describe a box that does not exist.
    const { reg: probedReg, ctx } = await buildServer(edition, "full", edition);
    const probed = probedReg.list();
    const caps = ctx.capabilities;
    if (caps.du || caps.journal || caps.screenGrabber || ctx.emailCanRead || ctx.codingAgent) {
      probedAnything = true;
    }

    const { reg: fullReg } = await buildServer(edition, "full", edition, { ...ALL_CAPABILITIES });
    const enabled = fullReg.list();

    // The UNION, not either posture. A capability gate can point either way:
    // most families register only when the box CAN do the thing, while
    // `image_generate` registers only where it cannot (it exists to tell the
    // model why, and would contradict the harness's own image tool on a linked
    // box). Both halves ship, so both halves are checked.
    const tools = [...enabled];
    for (const tool of probed) {
      if (!tools.some((t) => t.name === tool.name)) tools.push(tool);
    }
    byEdition[edition] = tools;
    for (const tool of tools) problems.push(...contractViolations(tool), ...schemaShapeViolations(tool));

    // The posture switch has to be doing something, or this narrows back to
    // whatever the host could probe and the two runs are the same run.
    if (enabled.length <= probed.length && !probedAnything) {
      problems.push(
        `${edition}: the all-capabilities posture registered ${enabled.length} tools against `
        + `${probed.length} probed — the capability overrides are not reaching the registrars`,
      );
    }

    const names = new Set(tools.map((t) => t.name));
    const forbidden = edition === "hermes" ? OPENCLAW_ONLY : HERMES_ONLY;
    for (const name of forbidden) {
      if (names.has(name)) problems.push(`${edition}: "${name}" must not be registered on this edition`);
    }
    const required = edition === "hermes" ? HERMES_ONLY : OPENCLAW_ONLY;
    for (const name of required) {
      if (!names.has(name)) problems.push(`${edition}: "${name}" should be registered here but is missing`);
    }
    if (new Set(tools.map((t) => t.name)).size !== tools.length) {
      problems.push(`${edition}: duplicate tool name registered`);
    }
  }

  for (const [edition, tools] of Object.entries(byEdition)) {
    const bytes = schemaBytes(tools);
    console.log(`\n${edition}: ${tools.length} tools, ${(bytes / 1024).toFixed(1)} KB of tools/list payload`);
    for (const t of tools) {
      const flags = [
        t.opts.readOnly ? "read-only" : "writes",
        t.opts.destructive ? "destructive" : "",
        t.opts.profile === "core" ? "core" : "",
      ].filter(Boolean).join(" ");
      console.log(`  ${t.name.padEnd(22)} ${flags}`);
    }
  }

  const onlyOpenclaw = byEdition.openclaw.filter((t) => !byEdition.hermes.some((h) => h.name === t.name)).map((t) => t.name);
  const onlyHermes = byEdition.hermes.filter((t) => !byEdition.openclaw.some((o) => o.name === t.name)).map((t) => t.name);
  console.log(`\nOpenClaw only: ${onlyOpenclaw.join(", ")}`);
  console.log(`Hermes only:   ${onlyHermes.join(", ")}`);

  if (!probedAnything) {
    // Said out loud, every time, because the alternative is the shape this
    // checker exists to catch: a run that examined a third of the surface and
    // printed OK. The contract above WAS checked over the full posture; what
    // this host could not do is tell you whether the probes themselves work.
    console.log(
      "\nnote: no device capability probed true on this host"
      + ` (CLAWBOX_ROOT=${process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox"} is where probes are spawned).`
      + "\n      The contract and the matrix above are the ALL-CAPABILITIES posture, which is the"
      + "\n      surface a real box registers. Run this on a device to exercise the probes too.",
    );
  }

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("\nTool contract OK.");
}

main().catch((err) => {
  console.error("check-tools failed:", err);
  process.exit(1);
});
