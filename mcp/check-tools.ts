#!/usr/bin/env bun
/**
 * Tool-surface checker. Run it after any change to mcp/**:
 *
 *   bun run mcp/check-tools.ts
 *
 * It builds the server over FOUR POSTURES per edition, without connecting a
 * transport — what this host can actually probe, every capability on, every
 * capability off, and the profile a delegated coding run gets — and:
 *   1. asserts the tool contract (name regex, description length and banned
 *      phrases, parameter-name regex, readOnly/destructive coherence) over
 *      every distinct tool SHAPE any posture produces;
 *   2. asserts each capability gate against its own posture, in both
 *      directions, and that the set of gated tools is the one this file names
 *      — so a family that loses its gate, or gains one nobody recorded, is a
 *      failure rather than a silent change;
 *   3. prints the registration matrix — which tools each edition gets — and
 *      fails if a Hermes device would be offered an OpenClaw-only tool or the
 *      other way round;
 *   4. reports the approximate tools/list schema size. That figure is the
 *      budget that matters on a device running a 4-8B local model, so it is
 *      printed for the posture a real box registers, with the union — a
 *      maximum that no single box ever pays — named as such.
 *
 * It is a script rather than a vitest file because the vitest projects only
 * include src/tests/**. Its COVERAGE, though, no longer depends on the device
 * probes: that is what let it become a CI step, and the note at the end says
 * out loud which probes this host could not exercise.
 */

process.env.CLAWBOX_MCP_NO_AUTOSTART = "1";

import { z } from "zod";
import { contractViolations, type RegisteredToolInfo } from "./lib/register";
// The directory the probes actually spawn in — imported, not restated: a third
// copy of that path is a third thing to keep in step with the other two.
import { DEFAULT_CWD } from "./lib/guard";
// The TYPE, so the postures below are checked against the interface they
// override. Excess-property checking does not apply through a variable or a
// spread, so without an annotation a renamed or misspelt field type-checks
// clean and the override goes inert; and the annotation is TOTAL rather than
// `Partial`, so the next capability added to the context cannot silently fall
// back to this host's probed value and take its tool family out of the check
// with it — `bun run typecheck:mcp`, which this workflow now runs, fails until
// both postures name it.
import type { McpContext } from "./lib/context";

/** Everything a posture must decide: the context minus the server's identity. */
type Posture = Omit<McpContext, "edition" | "install" | "profile">;

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
const ALL_CAPABILITIES: Posture = {
  capabilities: { screenGrabber: "scrot", imageConvert: true, journal: true, du: true },
  emailCanRead: true,
  codingAgent: true,
  canGenerateImages: true,
  providers: ["anthropic", "openai"],
};

/**
 * Every capability off — the other end of each gate, spelled out rather than
 * inferred from this host.
 *
 * The all-capabilities posture alone cannot tell a working gate from a tool
 * that lost its gate: a family that became unconditional registers in it just
 * the same. And the ordinary probed posture is no substitute, because ON A
 * DEVICE the probes answer TRUE — the checker is meant to be run there too, and
 * a negative assertion that only holds off a box is not an assertion.
 */
const NO_CAPABILITIES: Posture = {
  capabilities: { screenGrabber: null, imageConvert: false, journal: false, du: false },
  emailCanRead: false,
  codingAgent: false,
  canGenerateImages: false,
  providers: [],
};

/**
 * The tools that exist ONLY where a device probe says the box can do the thing.
 *
 * Not a checklist to satisfy — an EQUALITY. The set is computed from the two
 * postures (present with every capability on, absent with every one off) and
 * compared with this list, so a family that quietly loses its gate and a family
 * that gains one nobody recorded both fail here. A hand-maintained "each of
 * these must be present" list could see neither; a count could see less still,
 * measured — with one context field renamed away, three coding_agent tools
 * disappeared and the total went UP.
 */
const PROBE_GATED_TOOLS = [
  "coding_agent_run", "coding_agent_status", "coding_agent_stop",
  "coding_team_run", "coding_team_status", "coding_team_stop",
  "disk_cleanup", "disk_usage", "email_list", "email_read",
  "logs_tail", "screen_capture",
];

/** The gate that points the OTHER way: it exists where the box cannot draw. */
const INVERSE_GATED_TOOLS = ["image_generate"];

/**
 * The tools a delegated coding run gets, and nothing else does.
 *
 * `registerMediaTools` and `browser_view_local` are gated on the RUN CONTEXT —
 * the environment triple the runner sets (`mcp/lib/run-context.ts`) — not on
 * `McpContext`, so no capability posture reaches them and the checker printed
 * "Tool contract OK" over three shipped tools it had never built. They are the
 * ones most in need of the check, too: their descriptions are the longest in
 * the tree and they only ever run on a customer's device, where the registrar's
 * contract complaint goes to a stdio server's stderr that nobody reads.
 */
const RUN_ONLY_TOOLS = ["browser_view_local", "generate_audio", "generate_image"];

/** The environment the coding-agent runner sets around a run's MCP server. */
const RUN_ENV = {
  CLAWBOX_RUN_DIR: "/home/clawbox/projects/example",
  CLAWBOX_RUN_ARTIFACTS_DIR: "/home/clawbox/clawbox/data/coding-agent-artifacts/example",
  CLAWBOX_RUN_MEDIA: "images,audio",
};

/** Names present in `a` and absent from `b`, sorted. */
function only(a: RegisteredToolInfo[], b: RegisteredToolInfo[]): string[] {
  const other = new Set(b.map((t) => t.name));
  return a.filter((t) => !other.has(t.name)).map((t) => t.name).sort();
}

async function main(): Promise<void> {
  const { buildServer } = await import("./clawbox-mcp");
  const problems: string[] = [];
  const byEdition: Record<string, RegisteredToolInfo[]> = {};
  const byEditionReal: Record<string, RegisteredToolInfo[]> = {};
  let probeResults: Record<string, boolean> = {};

  for (const edition of ["openclaw", "hermes"] as const) {
    // The app harness is the edition being simulated: this walks each
    // edition's tool list, so an app gate resolving to anything else would
    // describe a box that does not exist.
    const { reg: probedReg, ctx } = await buildServer(edition, "full", edition);
    const probed = probedReg.list();
    // Each probe SEPARATELY. A single OR let one true answer — `emailCanRead`
    // on a dev PC with the setup API up — silence the note about the other six,
    // and the run then looked like it had exercised the device probes.
    probeResults = {
      du: ctx.capabilities.du,
      journal: ctx.capabilities.journal,
      screen: ctx.capabilities.screenGrabber !== null,
      imageConvert: ctx.capabilities.imageConvert,
      email: ctx.emailCanRead,
      codingAgent: ctx.codingAgent,
      images: ctx.canGenerateImages,
    };

    const { reg: fullReg } = await buildServer(edition, "full", edition, ALL_CAPABILITIES);
    const enabled = fullReg.list();

    // Every gate the other way round. It carries the one tool that registers
    // where the box CANNOT do the thing (`image_generate`), and it is what the
    // negative half of each assertion below is made against.
    const { reg: bareReg } = await buildServer(edition, "full", edition, NO_CAPABILITIES);
    const disabled = bareReg.list();

    // The posture a delegated coding run gets: the `browser` profile, with the
    // runner's environment around the build. Restored immediately — the
    // variables are read at REGISTRATION time, so nothing outside this call
    // may see them.
    const savedEnv = Object.fromEntries(Object.keys(RUN_ENV).map((k) => [k, process.env[k]]));
    Object.assign(process.env, RUN_ENV);
    let inRun: RegisteredToolInfo[];
    try {
      const { reg: runReg } = await buildServer(edition, "browser", edition, ALL_CAPABILITIES);
      inRun = runReg.list();
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    // The CONTRACT check runs over every distinct tool SHAPE any posture
    // produces, not over one entry per name. `ai_set_provider` takes an enum
    // parameter when the Hermes catalogue answered at startup and a free-text
    // one when it did not (mcp/tools/ai.ts) — de-duplicating by name alone
    // examined whichever variant happened to be pushed first and left the one a
    // box with an unreachable dashboard actually ships unchecked.
    const seen = new Set<string>();
    for (const tool of [...enabled, ...disabled, ...probed, ...inRun]) {
      const shape = `${tool.name}(${Object.keys(tool.shape).sort().join(",")})`;
      if (seen.has(shape)) continue;
      seen.add(shape);
      problems.push(...contractViolations(tool), ...schemaShapeViolations(tool));
    }

    // The matrix and the edition gating are about what a BOX gets, so they read
    // the union of the postures a box can be in — a gate can point either way,
    // and both halves ship.
    const tools = [...enabled];
    for (const tool of [...probed, ...disabled]) {
      if (!tools.some((t) => t.name === tool.name)) tools.push(tool);
    }
    byEdition[edition] = tools;
    byEditionReal[edition] = enabled;

    // Each gate against ITS OWN posture, and as an EQUALITY. The union cannot
    // tell a working gate from a tool that lost it — a family that became
    // unconditional is in the union just the same — and a "these must all be
    // present" list cannot see a family that gained a gate nobody recorded.
    const gated = only(enabled, disabled);
    const inverse = only(disabled, enabled);
    if (gated.join(",") !== PROBE_GATED_TOOLS.join(",")) {
      problems.push(
        `${edition}: the capability-gated tools are [${gated.join(", ")}], not the recorded `
        + `[${PROBE_GATED_TOOLS.join(", ")}] — a family changed its gate; check it is deliberate `
        + "and update PROBE_GATED_TOOLS",
      );
    }
    if (inverse.join(",") !== INVERSE_GATED_TOOLS.join(",")) {
      problems.push(
        `${edition}: the tools that exist only where the capability is OFF are `
        + `[${inverse.join(", ")}], not [${INVERSE_GATED_TOOLS.join(", ")}]`,
      );
    }

    // The run-only family, both ways round: present inside a run, and absent
    // from every posture that is not one.
    const runExtra = only(inRun, enabled).filter((n) => !RUN_ONLY_TOOLS.includes(n));
    for (const name of RUN_ONLY_TOOLS) {
      if (!inRun.some((t) => t.name === name)) {
        problems.push(
          `${edition}: "${name}" is registered only inside a coding run and did not appear in the `
          + "run posture — the run-context override is not reaching the registrars",
        );
      }
      if (tools.some((t) => t.name === name)) {
        problems.push(`${edition}: "${name}" is registered outside a coding run`);
      }
    }
    if (runExtra.length) {
      problems.push(
        `${edition}: the run profile registers [${runExtra.join(", ")}], which nothing outside a run `
        + "gets and this file does not name — record them in RUN_ONLY_TOOLS",
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
    // TWO figures, because they answer different questions. The headline is
    // what a real box registers — the tools/list payload a 4-8B local model
    // actually pays for — and the union beside it is a maximum no single box
    // is ever in, since `image_generate` exists only where the others do not.
    const real = byEditionReal[edition];
    const bytes = schemaBytes(real);
    console.log(
      `\n${edition}: ${real.length} tools, ${(bytes / 1024).toFixed(1)} KB of tools/list payload`
      + ` (union of all postures: ${tools.length} tools, ${(schemaBytes(tools) / 1024).toFixed(1)} KB)`,
    );
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

  const unprobed = Object.entries(probeResults).filter(([, ok]) => !ok).map(([name]) => name);
  if (unprobed.length) {
    // Said out loud, every time, and PER PROBE: the alternative is the shape
    // this checker exists to catch, a run that examined part of the surface and
    // printed OK. The contract above WAS checked over every posture; what this
    // host could not do is tell you whether these particular probes work.
    console.log(
      `\nnote: ${unprobed.join(", ")} probed false on this host`
      + ` (CLAWBOX_ROOT=${DEFAULT_CWD} is where probes are spawned).`
      + "\n      The contract and the matrix above come from the declared postures, which are the"
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
