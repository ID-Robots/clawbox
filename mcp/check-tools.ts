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

async function main(): Promise<void> {
  const { buildServer } = await import("./clawbox-mcp");
  const problems: string[] = [];
  const byEdition: Record<string, RegisteredToolInfo[]> = {};

  for (const edition of ["openclaw", "hermes"] as const) {
    const { reg } = await buildServer(edition, "full");
    const tools = reg.list();
    byEdition[edition] = tools;
    for (const tool of tools) problems.push(...contractViolations(tool), ...schemaShapeViolations(tool));

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
