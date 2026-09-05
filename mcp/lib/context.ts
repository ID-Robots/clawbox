// Everything the tool modules need to know about THIS device, resolved once at
// startup so no tool has to re-discover it per call.
//
// Capability probes follow the same principle as edition gating: a tool that
// cannot work here (no screen grabber installed, no readable journal) is not
// registered at all, rather than registered and failing.

import { capabilitiesFor, type HarnessFacts } from "../../src/lib/harness/capabilities";
import { appExistsOnEdition } from "../../src/lib/desktop-app-editions";
import type { HarnessId } from "../../src/lib/harness/transport";
import { hasBinary, spawnArgv } from "./guard";
import { apiTry } from "./api";
import type { Ed, Profile } from "./register";

export interface DesktopApp {
  id: string;
  name: string;
  description: string;
  /**
   * The desktop opens this one in a NEW BROWSER TAB (`window.open`), not in a
   * desktop window — so the browser's popup blocker can drop it, and
   * `ui_open_app` must not claim it appeared. Mirrors `type: "external"` in
   * src/lib/desktop-apps.ts; the drift test holds the two together.
   */
  external?: boolean;
}

// Every built-in desktop app, in the order src/lib/desktop-apps.ts declares
// them, with the sentence the agent needs to pick the right window. The
// registry cannot be imported here — it reaches React through the `@/` alias,
// which mcp/tsconfig.json exists to keep out of this stdio process — so
// src/tests/unit/mcp-desktop-apps.test.ts holds this table against it: adding
// an app to the desktop without a line here fails CI (TASK-541, where four
// apps the desktop shows had gone missing from this list and `ui_open_app`
// answered "there is no such app" for the box's own Hermes dashboard).
//
// The EDITION gate is not repeated here: src/lib/desktop-app-editions.ts is
// the one copy, shared with the desktop grid and the standalone window.
const APP_DESCRIPTIONS: Record<string, Omit<DesktopApp, "id">> = {
  settings: { name: "Settings", description: "Device settings, AI provider, backup" },
  clawbox: { name: "Chat", description: "The ClawBox chat window on the desktop — the device's MAIN conversation, which is not necessarily this one" },
  openclaw: { name: "OpenClaw", description: "OpenClaw's own Control UI chat, in a browser tab", external: true },
  hermes: { name: "Hermes", description: "The Hermes dashboard, in a browser tab", external: true },
  "hermes-skills": { name: "Hermes Skills", description: "Install skills for the agent" },
  terminal: { name: "Terminal", description: "Shell" },
  coding: { name: "Coding Agent", description: "The owner's switch for delegated coding runs, what a run needs, and recent runs" },
  files: { name: "Files", description: "File manager" },
  clawkeep: { name: "ClawKeep", description: "Backups: what is protected, run one now, restore" },
  "memory-shard": { name: "Memory Shard", description: "The memory index: embedding health, reindex, schedule" },
  system_update: { name: "System Update", description: "The installed ClawBox version and the update button" },
  store: { name: "Store", description: "App store" },
  browser: { name: "Browser Setup", description: "Browser integration panel, not the browsing window" },
  vnc: { name: "Remote Desktop", description: "VNC viewer" },
};

/**
 * The built-in apps this harness has. `null` — the harness could not be
 * determined — answers the apps that exist on BOTH, never one harness's guess.
 */
export function builtInApps(edition: Ed | null): DesktopApp[] {
  return Object.entries(APP_DESCRIPTIONS)
    .filter(([id]) => appExistsOnEdition(id, edition))
    .map(([id, def]) => ({ id, ...def }));
}

/**
 * Why an app that exists on ONE harness cannot be offered right now.
 *
 * The wording matters, and the CLI has said it since this gate existed: an app
 * the OTHER harness owns is "not here", while the SAME app on a box whose
 * harness could not be determined is "could not be placed". Saying the first
 * over the second tells the agent as a durable fact that the box has no
 * dashboard, which is how it stops asking — so the MCP tool and the CLI say the
 * same sentence, from here.
 */
export const UNKNOWN_HARNESS_NOTE =
  "This ClawBox could not say which harness it is running, so apps that belong to only one of them"
  + " are not offered. Check /etc/clawbox/edition.env and that the device's web server is up.";

/**
 * What may honestly be said after the open action has been posted.
 *
 * ONE sentence for both surfaces. `ui_open_app` and `clawbox app open` push the
 * same action into the same fire-and-forget ring (`ui:pending-actions`), which
 * the desktop POLLS — so neither of them learns what became of it, and an
 * `external` app is opened with `window.open()` from that poll rather than from
 * a click, where a popup blocker can drop it silently. Claiming it appeared is
 * a false success on the one path the agent cannot see; saying so is what lets
 * the agent ask the owner to look. Kept here, beside the `external` flag, so
 * the CLI and the tool cannot answer the same question two ways — which is the
 * defect TASK-541 is about.
 *
 * @param app the built-in app, or undefined for an installed one (never
 *            external: an installed app is FRAMED in the desktop).
 * @param fallbackId what to call it when the registry has no row.
 */
export function openedAppNotice(app: DesktopApp | undefined, fallbackId: string): string {
  return app?.external
    ? `Asked the desktop to open ${app.name}. It opens in a new browser tab, so ask the user to`
      + " look at the screen — and to allow the popup if their browser blocked it."
    : `Opened ${app?.name ?? fallbackId} on the desktop.`;
}

/**
 * The same notice for a human reading a shell, with the CLI's tick.
 *
 * The tick and the wording are separated deliberately: the SENTENCE is the
 * claim, and it has to be the tool's, or a future change to one surface's
 * hedging silently un-aligns them again — which is the drift `openedAppNotice`
 * was added to prevent and, on its first outing, only half prevented. The glyph
 * is presentation, and only where a person is reading.
 */
export function openedAppLine(app: DesktopApp | undefined, fallbackId: string): string {
  return `${app?.external ? "" : "✅ "}${openedAppNotice(app, fallbackId)}`;
}

export interface Capabilities {
  /** Binary that can grab display :0, or null when none is installed. */
  screenGrabber: string | null;
  /** ImageMagick `convert`, used to shrink a capture before it is returned. */
  imageConvert: boolean;
  /** journalctl present AND able to read at least one ClawBox unit. */
  journal: boolean;
  /** `du` present — disk_usage needs it for the cache breakdown. */
  du: boolean;
}

export interface McpContext {
  /** The tool set registered: the resolved single harness. */
  edition: Ed;
  /** The raw install edition — can be "dual", which `edition` resolves. */
  install: "openclaw" | "hermes" | "dual";
  /**
   * Whose built-in DESKTOP APPS this device shows, or null when that could not
   * be determined — a different question from `edition`, which is a tool set
   * and fails closed onto the smaller of two nested answers. See
   * `resolveAppHarness`.
   *
   * A STARTUP SNAPSHOT, like everything else here: on the `dual` SKU a harness
   * switch made after this child spawned is not seen until it restarts, which
   * `mcp/tools/desktop.ts` says out loud where it matters.
   */
  appHarness: Ed | null;
  profile: Profile;
  capabilities: Capabilities;
  /**
   * Hermes provider ids that reported credentials at startup. Empty when the
   * catalogue could not be read — the ai_set_provider registration degrades to
   * a runtime check rather than disappearing.
   */
  providers: string[];
  /**
   * Whether the device has a mail account AND the owner picked a mode that
   * lets the agent open the mailbox. Decides whether email_list/email_read are
   * registered at all — a tool that could only ever 409 is a tool that trips
   * Hermes' circuit breaker and takes the whole server down with it.
   *
   * Both editions, like sending: reading runs on ClawBox's own IMAP client and
   * needs nothing from Hermes.
   */
  emailCanRead: boolean;
  /**
   * Whether the owner switched the coding agent on AND the harness behind it
   * (Claude Code + claude-ds + ClawBox AI) is ready. Same gating rule as
   * emailCanRead, for the same circuit-breaker reason: the coding_agent_*
   * tools exist only when a run could actually start.
   */
  codingAgent: boolean;
  /**
   * Whether this box can actually make a picture — the agent has an image
   * backend, or the box itself has a credential and a route to spend it on.
   *
   * The one probe here whose FALSE registers a tool instead of hiding one. An
   * unlinked box has no image tool in any surface, and an agent asked for a
   * picture with no tool to draw it does not stop: on the owner's box
   * (2026-08-26) it reached for the shell, hand-wrote an SVG, installed
   * cairosvg and rasterised it — producing a file the chat cannot serve and
   * telling the customer nothing about why. Silence is what let that happen, so
   * the absence gets a voice. See registerAiTools.
   */
  canGenerateImages: boolean;
}

const SCREEN_GRABBERS = ["scrot", "gnome-screenshot", "spectacle", "import"];

async function probeJournal(): Promise<boolean> {
  const r = await spawnArgv("journalctl", ["-n", "1", "--no-pager", "-u", "clawbox-setup.service"], {
    timeoutMs: 5_000,
  });
  return r.exitCode === 0;
}

interface ModelsPayload {
  current?: string;
  provider?: string;
  providers?: { id?: string; authenticated?: boolean }[];
}

interface EmailStatusPayload {
  configured?: boolean;
  /** The device's own answer to "may the agent read?" — see below. */
  canRead?: boolean;
}

/**
 * Ask the device whether reading is switched on. A device whose status route
 * cannot be reached (an older build, a service still starting) answers null,
 * and the read tools stay UNREGISTERED — the safe direction, because the
 * failure mode of guessing "yes" is a permanently-failing tool.
 */
async function probeEmailRead(): Promise<boolean> {
  const status = await apiTry<EmailStatusPayload>("/setup-api/email/status", { timeoutMs: 3_000 });
  if (!status?.configured) return false;
  // The device answers this itself (src/lib/email-config.ts modeAllowsReading).
  // Restating which modes allow reading here would be a second copy of the
  // rule, in the process least likely to be updated when a mode is added.
  return status.canRead === true;
}

interface CodingAgentStatusPayload {
  enabled?: boolean;
  /** enabled AND installed AND connected — the device's own verdict. */
  ready?: boolean;
}

/**
 * Same shape as the email probe: an unreachable or older device answers null
 * and the family stays unregistered.
 */
async function probeCodingAgent(): Promise<boolean> {
  const status = await apiTry<CodingAgentStatusPayload>("/setup-api/coding-agent/status", { timeoutMs: 3_000 });
  return status?.enabled === true && status.ready === true;
}

interface ChatCapabilitiesBody {
  harness?: HarnessId;
  facts?: HarnessFacts;
}

/**
 * Ask the device whether drawing is possible at all.
 *
 * The route answers FACTS and `capabilitiesFor` turns them into the flag, which
 * is the same pair the browser uses — deliberately, so the tool the agent sees
 * and the button the customer sees can never disagree about whether this box
 * can draw. Restating the rule here would be a second copy of it, in the
 * process least likely to be updated when the rule changes.
 *
 * Fails CLOSED like its neighbours, and closed here means the honest-refusal
 * tool IS registered: a box we cannot ask about is a box we cannot promise a
 * picture from.
 */
async function probeImageGeneration(): Promise<boolean> {
  const body = await apiTry<ChatCapabilitiesBody>("/setup-api/chat/capabilities", {
    timeoutMs: 5_000,
  });
  if (!body?.harness || !body.facts) return false;
  return capabilitiesFor(body.harness, body.facts).canGenerateImages;
}

export async function buildContext(
  edition: Ed,
  install: "openclaw" | "hermes" | "dual",
  profile: Profile,
  // REQUIRED, with no default. `= edition` looked harmless because both
  // production callers pass it, but it is the wrong answer by this module's own
  // argument: with an unreadable lock `edition` is "hermes", and answering that
  // for the APP question refuses three apps the box has and ticks off two it
  // may not. A caller who omitted it would get exactly that, silently and
  // without a type error — the conflation this pair of questions exists to end.
  appHarness: Ed | null,
): Promise<McpContext> {
  let screenGrabber: string | null = null;
  for (const bin of SCREEN_GRABBERS) {
    if (await hasBinary(bin)) {
      screenGrabber = bin;
      break;
    }
  }
  const [imageConvert, journal, du] = await Promise.all([
    hasBinary("convert"),
    probeJournal(),
    hasBinary("du"),
  ]);

  const [emailCanRead, codingAgent, canGenerateImages] = await Promise.all([
    probeEmailRead(),
    probeCodingAgent(),
    probeImageGeneration(),
  ]);

  let providers: string[] = [];
  if (edition === "hermes") {
    const payload = await apiTry<ModelsPayload>("/setup-api/hermes/models", { timeoutMs: 3_000 });
    providers = (payload?.providers ?? [])
      .filter((p) => typeof p.id === "string" && p.authenticated !== false)
      .map((p) => p.id as string);
    // The device's configured DEFAULT provider is always a legal target, even
    // when it is absent from the credentialed catalogue — the Hermes CLI has
    // meta-providers ("auto") the catalogue never lists. Without this seed,
    // ai_set_provider was a one-way door: the agent could switch away from the
    // configured provider and then had no enum value to switch back to.
    const current = payload?.provider;
    if (typeof current === "string" && current && !providers.includes(current)) {
      providers.unshift(current);
    }
  }

  return {
    edition,
    install,
    appHarness,
    profile,
    capabilities: { screenGrabber, imageConvert, journal, du },
    providers,
    emailCanRead,
    codingAgent,
    canGenerateImages,
  };
}
