// Orientation tools: what this device is, whether it is healthy, and the field
// guide. Build these first — every other tool's description points at them.

import { readFileSync } from "fs";
import { join } from "path";
import { apiTry, apiToken, API_BASE, authHeader } from "../lib/api";
import { DEFAULT_CWD } from "../lib/guard";
import { json, text, type Ed, type Registrar } from "../lib/register";
import { CURRENT_CHAT_MODEL_NOTE, hermesDeviceDefault, reported, type HermesDefaultSource } from "../lib/report";
import type { McpContext } from "../lib/context";
import { shipsOpenclaw, type VersionsPayload } from "../lib/versions";
import { WEBAPP_KV_CLIENT_SNIPPET } from "../../src/lib/webapp-sandbox";

const FIELD_GUIDE_PATH = join(DEFAULT_CWD, "Clawbox.md");

// The OpenClaw answer to CURRENT_CHAT_MODEL_NOTE, and it is the opposite one.
// The chat header's pick is POSTed to /setup-api/chat/model, which writes
// agents.defaults.model.primary AND repoints every agent session, and this
// edition has neither a per-turn override nor a reply label — so the default
// IS the chat's model, and saying "not visible" here would turn a right answer
// into a shrug.
const OPENCLAW_CURRENT_CHAT_NOTE =
  "the device default above: on this edition the chat header writes it to the box and repoints every session, so it is what this chat runs.";

// …but only where the edition is CERTAIN. `resolveAppHarness` asks
// /setup-api/harness/active with a 3 s timeout and hands the answer to
// `resolveEdition`, which takes "openclaw" for a `dual` box that did not
// answer — and this server is spawned at harness start, exactly when the web
// app may not be up yet. On a locked SKU that fallback cannot be wrong; on
// DUAL it can, and an affirmative "the default is what this chat runs" handed
// to a Hermes chat reinstates the whole defect this note exists to remove
// (the agent answers "which model are you" from the device default). A shrug
// is safe on both editions; the claim is not. `ctx.install` is the raw value,
// so "dual" is the one case that has to hedge.
const UNCONFIRMED_EDITION_CHAT_NOTE =
  "not established here: this device can run either harness and the tool server could not confirm which is active, so the device default above may not be what this chat runs. Where the ClawBox chat knows the model that served a reply, it prints it under that reply.";

/**
 * How the description qualifies the default, per edition — the Hermes chat can
 * override it per session; the OpenClaw chat cannot.
 *
 * Keyed on `Ed`, not `string`: a third edition would then be a compile error
 * here rather than the literal "(undefined)" inside a tool description every
 * model reads.
 */
const DEFAULT_QUALIFIER: Record<Ed, string> = {
  hermes: "not necessarily the one answering this chat",
  openclaw: "which is also what the chat runs",
};

// Moved wholesale out of webapp_create / code_project_init: those descriptions
// were 700+ chars of tutorial that a small model had to read on every
// tools/list, to learn something it only needs once it is actually writing an
// app. It lives here, load-on-demand.
//
// The storage path is the desktop's KV bridge, not fetch('/setup-api/kv'):
// a webapp runs in a sandboxed frame with an opaque origin (see
// src/lib/webapp-sandbox.ts), so a fetch from inside it carries no session and
// is refused. The bridge snippet is quoted whole because a one-file app from
// webapp_create has to carry it itself; code_project_init writes it into the
// scaffold.
export const WEBAPP_STORAGE_GUIDE = `## Storing data in a ClawBox webapp

Do NOT use localStorage — it does not survive a session. Do NOT fetch
/setup-api/kv (or any /setup-api route) from the app: a webapp runs in a
sandboxed frame without the ClawBox session, and the call is refused. Use the
desktop's KV bridge, window.clawboxKv — every method returns a Promise:
  await window.clawboxKv.set("items", JSON.stringify(items));
  const raw = await window.clawboxKv.get("items");   // string, or null when unset
  await window.clawboxKv.delete("items");
  const mine = await window.clawboxKv.list();        // this app's saved keys and values

Use plain key names ("items", "settings"): the desktop keeps them under your
app's own namespace and refuses a key that names another app's. Values are
strings: JSON.stringify before saving, JSON.parse after loading. A call rejects
after 30 s when no ClawBox desktop is hosting the app.

A project from code_project_init already has the bridge in index.html. A
one-file app from webapp_create must include it — paste this in <head>,
unchanged:

${WEBAPP_KV_CLIENT_SNIPPET}

An app written earlier against fetch('/setup-api/kv') no longer reaches its
saved data; move it to window.clawboxKv with webapp_update or a rebuild.

Style single-file apps dark: background #1a1a2e, text #e0e0e0, accent #f97316.
No CDN links — the device may be offline.

## An app that runs its own server

A project with its own server (a Next.js app on a port, a game engine) is
reached THROUGH the box, never by its port: the box serves it under
/apps/<folder>/ on its own origin, so the desktop icon works on the LAN, over
the tunnel, and after the tunnel's address changes — a link that names a host
or a port is dead the next morning. Three things make it work:

1. Write clawbox.json at the project's root, the ClawBox app manifest:
     { "name": "Tinder Clone", "description": "…", "kind": "server", "port": 4230, "start": "bun run dev" }
   The box reads the port from it and puts the app on the desktop when the
   run settles; the same file marks the repository as a ClawBox app.
2. Serve the app under the base path /apps/<folder> — the path reaches it
   unchanged. Next.js: basePath: "/apps/<folder>" in next.config; Vite:
   base: "/apps/<folder>/"; Express: app.use("/apps/<folder>", router).
   An app that must serve at "/" with relative links may say
   "stripBasePath": true in the manifest instead.
3. Keep the server listening on 127.0.0.1 at that port, started from inside
   the project folder (the box proxies only a server of the project's own,
   and nothing else needs to reach the port), and say in the reply which
   port it serves on and that it opens at /apps/<folder>/.

Never write location.hostname or a port into an HTML redirect: the desktop
frames /apps/<folder>/ itself. To stop or restart a server YOU started,
use its PID (the one \`node …\` printed, or \`$!\`) — never pkill, killall or fuser:
ClawBox's own web server is a Next.js server too, and \`pkill -f next-server\`
takes the box down with your run.`;

function loadFieldGuide(): string | null {
  try {
    return readFileSync(FIELD_GUIDE_PATH, "utf8");
  } catch {
    // Missing on a fresh device that has not synced Clawbox.md yet.
    return null;
  }
}

// The name class is deliberately wider than the two values that exist: a typo
// this pattern does NOT match is not a fence at all, so its block would be
// served to every box with the marker still in the text. Recognising it is what
// lets the unknown-name case fail closed.
const BLOCK_OPEN = /^<!--\s*(edition|ships):([a-z0-9_-]+)\s*-->\s*$/;
const BLOCK_CLOSE = /^<!--\s*\/(edition|ships)\s*-->\s*$/;

/**
 * The field guide with the blocks that do not apply to this box removed.
 *
 * TASK-540: `clawbox_context` served Clawbox.md verbatim, so a Hermes agent was
 * oriented by an OpenClaw script — told it was "the brain of an OpenClaw
 * ClawBox", handed the address of a gateway that is masked on that SKU and the
 * path of a config file that does not exist there, and offered `bash`,
 * `write_file`, `web_search` and the rest of the coding family, none of which
 * is registered on Hermes (`mcp/tools/coding.ts`). `mcp/clawbox-mcp.ts`
 * `instructionsFor()` had already branched the server's own stub per edition
 * for exactly this reason; the field guide is the half that had not.
 *
 * ONE document, fenced in place, rather than a second file: two files drift
 * within a release, and the shared four fifths of this guide is the part that
 * has to stay identical. Everything outside a fence is served to every box.
 *
 * TWO fence families, because the guide answers two different questions and
 * `dual` separates them:
 *   - `edition:` — the ACTIVE HARNESS, i.e. whose tool set the agent reading
 *     this was given. `ctx.edition` resolves `dual` to one of the two.
 *   - `ships:`   — what the DEVICE HAS INSTALLED. A dual box has an OpenClaw
 *     gateway and a Hermes dashboard, and both blocks are served there. Keying
 *     the gateway's address on the harness would have told a dual box running
 *     Hermes that its gateway is gone while it is up and listening.
 *
 * Nesting is tracked with a stack: a close restores the enclosing block rather
 * than declaring the rest of the file unconditional, so a Hermes note added
 * inside an OpenClaw section cannot hand the OpenClaw remainder to every box.
 * An unmatched close is ignored; `src/tests/unit/clawbox-field-guide-edition.test.ts`
 * fails CI on either malformation.
 *
 * Fails CLOSED on an unknown name: it matches no box and its block is dropped
 * everywhere, which costs some text. Serving a block whose audience could not
 * be established is how the Hermes agent was told it had a gateway.
 */
export function fieldGuideForEdition(
  markdown: string,
  edition: Ed,
  install: "openclaw" | "hermes" | "dual" = edition,
): string {
  const applies = (family: string, name: string): boolean => {
    // The name is validated FIRST. `install === "dual"` answers true for every
    // `ships:` block, so without this an unknown audience would be served on
    // exactly the SKU that has both harnesses to be wrong about.
    if (name !== "openclaw" && name !== "hermes") return false;
    return family === "edition" ? name === edition : name === install || install === "dual";
  };
  const kept: string[] = [];
  const stack: { family: string; keep: boolean }[] = [];
  for (const line of markdown.split("\n")) {
    const open = BLOCK_OPEN.exec(line);
    if (open) {
      stack.push({ family: open[1], keep: applies(open[1], open[2]) });
      continue;
    }
    const close = BLOCK_CLOSE.exec(line);
    if (close) {
      // A `</ships>` closing an `edition:` block is a malformed document. Pop
      // only a matching frame: leaving the mismatched one open drops the rest
      // of the file for the wrong audience rather than serving it, and the
      // suite's well-nesting assertion fails CI on the file itself.
      if (stack.length && stack[stack.length - 1].family === close[1]) stack.pop();
      continue;
    }
    if (stack.some((frame) => !frame.keep)) continue;
    kept.push(line);
  }
  // A dropped block leaves the blank lines that surrounded it behind. Markdown
  // does not care, but the agent pays for every one of them.
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

interface StatsPayload {
  memory?: { usedPercent?: number };
  storage?: { mountpoint?: string; size?: string; used?: string; avail?: string; usePercent?: number }[];
  temperature?: unknown;
}

interface ClawaiPayload {
  hasToken?: boolean;
  tier?: string;
  active?: boolean;
  model?: string;
}

/**
 * The shape /setup-api/chat/model actually answers with.
 *
 * It never had `selected` or `current`: this tool read two keys the route has
 * never returned, so `reported()` mapped both to "unknown" and every OpenClaw
 * box reported `device_default: {provider:"unknown", model:"unknown"}`. The
 * tests that should have caught it invented the payload themselves.
 *
 * `wrong_store` is the route's refusal (409) on a box whose harness keeps its
 * own model — the same code chat/history uses. It is read here so the two
 * halves of `ai` cannot contradict each other; see `limits` below.
 *
 * `activeModel` is `agents.defaults.model.primary` as the route reports it —
 * the SAME key `readConfiguredModelLimits()` parses. Everything in `ai` is
 * derived from it and nothing else: the payload's `primary` object is the
 * "back to primary" TARGET, which on a box running its local model is a
 * different row, and mixing the two produced a provider from one model beside
 * the id and context window of another.
 */
interface ChatModelPayload {
  activeModel?: string | null;
  activeLabel?: string | null;
  code?: string;
}

interface ConfiguredModelLimits {
  model: string;
  context_window_tokens: number | "unknown";
  max_output_tokens: number | "unknown";
  source: "openclaw_config";
}

/**
 * `provider/modelId` -> the id half, so the OpenClaw leg reports the same shape
 * the Hermes one does (`hermesDeviceDefault`): a bare model id beside a
 * separate provider, not the qualified reference repeated in both fields.
 * A reference with no namespace is passed through as-is.
 */
function bareModelId(ref: string | null | undefined): string | null {
  if (typeof ref !== "string" || !ref) return null;
  const slash = ref.indexOf("/");
  return slash > 0 && slash < ref.length - 1 ? ref.slice(slash + 1) : ref;
}

/** Its other half: `provider/modelId` -> the namespace the gateway routes through. */
function providerOf(ref: string | null | undefined): string | null {
  if (typeof ref !== "string" || !ref) return null;
  const slash = ref.indexOf("/");
  return slash > 0 && slash < ref.length - 1 ? ref.slice(0, slash) : null;
}

/** Keep only positive whole-token counts; invalid config stays visibly unknown. */
function positiveInteger(value: unknown): number | "unknown" {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : "unknown";
}

/** Read the active model's declared limits from the config the gateway uses. */
export function readConfiguredModelLimits(
  configPath = process.env.OPENCLAW_CONFIG
    ?? join(process.env.HOME ?? "/home/clawbox", ".openclaw", "openclaw.json"),
): ConfiguredModelLimits | "unknown" {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      agents?: { defaults?: { model?: { primary?: unknown } } };
      models?: { providers?: Record<string, { models?: unknown[] }> };
    };
    const primary = config.agents?.defaults?.model?.primary;
    if (typeof primary !== "string") return "unknown";
    const slash = primary.indexOf("/");
    if (slash <= 0 || slash === primary.length - 1) return "unknown";
    const provider = primary.slice(0, slash);
    const modelId = primary.slice(slash + 1);
    const models = config.models?.providers?.[provider]?.models;
    if (!Array.isArray(models)) return "unknown";
    const model = models.find((entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === "object" && (entry as { id?: unknown }).id === modelId
    );
    if (!model) return "unknown";
    return {
      model: primary,
      context_window_tokens: positiveInteger(model.contextWindow),
      max_output_tokens: positiveInteger(model.maxTokens),
      source: "openclaw_config",
    };
  } catch {
    return "unknown";
  }
}

/** The root mount is what "free disk" means to a customer. */
function rootDisk(stats: StatsPayload | null) {
  if (!stats?.storage?.length) return "unknown";
  const root = stats.storage.find((m) => m.mountpoint === "/") ?? stats.storage[0];
  return { mount: root.mountpoint, size: root.size, free: root.avail, used_percent: root.usePercent };
}

export function registerOrientationTools(reg: Registrar, ctx: McpContext): void {
  reg.tool(
    "device_status",
    `Report what this ClawBox is: edition, active agent, the device's default AI provider and model (${ctx.install === "dual" ? DEFAULT_QUALIFIER.hermes : DEFAULT_QUALIFIER[ctx.edition]}), the default model's configured context/output limits, thinking level, free disk space, and whether a software update is waiting. Call this before answering any question about the device itself or its model limits. Any part that cannot be read reports "unknown" instead of failing the whole call.`,
    {},
    { editions: ["openclaw", "hermes"], readOnly: true, profile: "core" },
    async () => {
      // Independent legs, independent timeouts: a stalled updater must not cost
      // the agent the disk figure it actually asked for.
      const [stats, versions, hermesModels, clawai, chatModel] = await Promise.all([
        apiTry<StatsPayload>("/setup-api/system/stats", { timeoutMs: 6_000 }),
        apiTry<VersionsPayload>("/setup-api/update/versions", { timeoutMs: 6_000 }),
        ctx.edition === "hermes"
          ? apiTry<HermesDefaultSource>("/setup-api/hermes/models", { timeoutMs: 6_000 })
          : Promise.resolve(null),
        ctx.edition === "hermes"
          ? apiTry<ClawaiPayload>("/setup-api/hermes/clawai", { timeoutMs: 6_000 })
          : Promise.resolve(null),
        ctx.edition === "openclaw"
          ? apiTry<ChatModelPayload>("/setup-api/chat/model", { timeoutMs: 6_000 })
          : Promise.resolve(null),
      ]);

      // `reported()`, not `??` — see mcp/lib/report.ts. device_status is the
      // surface the server's instructions tell every model to call FIRST, so a
      // blank here is the likeliest of all of them to be filled in with a
      // plausible-sounding model name.
      //
      // `device_default`, not bare `provider`/`model`: the bare keys were read
      // as "the model I am" on a live box — see CURRENT_CHAT_MODEL_NOTE.
      const ai =
        ctx.edition === "hermes"
          ? {
              device_default: hermesDeviceDefault(hermesModels),
              current_chat: CURRENT_CHAT_MODEL_NOTE,
              // The instructions tell the model to read `ai.limits` before
              // stating any context/output limit. Hermes has no configured-limit
              // source to read (readConfiguredModelLimits() parses the OpenClaw
              // gateway config, a file this SKU does not have), so the key is
              // emitted as an explicit "unknown" rather than omitted — a missing
              // key is the one answer that sends the model back to its training
              // memory for a number.
              limits: "unknown",
              // READ ONLY. Changing the plan changes what the customer is
              // billed, so there is deliberately no tool that switches it:
              // point the user at Settings -> AI instead. `is_device_default`,
              // not `in_use`: `active` is whether config.yaml's provider is
              // ClawBox AI — the same default, one key down.
              clawbox_ai: clawai
                ? { signed_in: clawai.hasToken === true, tier: reported(clawai.tier), is_device_default: clawai.active === true }
                : "unknown",
            }
          : {
              // ONE source. Both halves and the limits below come from
              // `agents.defaults.model.primary`, so the payload can only name a
              // model the box is actually set to — or nothing, which is the
              // truthful answer on a box with nothing pinned and the whole
              // point of the route's own null guard.
              device_default: {
                provider: reported(providerOf(chatModel?.activeModel)),
                model: reported(bareModelId(chatModel?.activeModel)),
                thinking: "unknown",
              },
              current_chat: ctx.install === "dual" ? UNCONFIRMED_EDITION_CHAT_NOTE : OPENCLAW_CURRENT_CHAT_NOTE,
              // Both halves answer from the SAME store or neither does. `ctx.edition`
              // is resolved once at MCP startup and falls back to "openclaw" when the
              // web app is not up yet, so on a dual box this branch can run while
              // Hermes is active — and the route then 409s while this file happily
              // parses openclaw.json. That produced one payload saying "I do not know
              // my model" beside a named model with a context window, which the
              // server's own instructions tell every model to read as authoritative.
              limits: chatModel ? readConfiguredModelLimits() : "unknown",
            };

      return json({
        edition: ctx.edition,
        install_edition: ctx.install,
        agent: ctx.edition === "hermes" ? "Hermes" : "OpenClaw",
        ai,
        disk: rootDisk(stats),
        memory_used_percent: stats?.memory?.usedPercent ?? "unknown",
        // `shipsOpenclaw`, not `ctx.edition`: the question is whether the DEVICE
        // has an OpenClaw to update, which the payload answers itself. Reading
        // the active harness here hid a waiting OpenClaw update from a dual box
        // whenever Hermes happened to be the one answering.
        update: versions
          ? {
              clawbox: versions.clawbox ?? "unknown",
              ...(shipsOpenclaw(versions, ctx) ? { openclaw: versions.openclaw ?? "unknown" } : {}),
              waiting:
                versions.clawbox?.updateAvailable === true
                || (shipsOpenclaw(versions, ctx) && versions.openclaw?.updateAvailable === true),
            }
          : "unknown",
      });
    },
  );

  reg.tool(
    "clawbox_health",
    "Check that this tool server can reach the ClawBox device and that its access token is accepted. Run this first whenever other tools return AUTH_FAILED or ENDPOINT_DOWN — it separates a token problem from a service problem. It changes nothing.",
    {},
    { editions: ["openclaw", "hermes"], readOnly: true, profile: "core" },
    async () => {
      const checks: Record<string, { ok: boolean; detail: string }> = {};
      const { token, source } = apiToken();
      checks.api_token = token
        ? { ok: token.length >= 16, detail: `present (${source})` }
        : { ok: false, detail: "missing — the device did not provision one" };

      const probe = async (path: string): Promise<{ ok: boolean; detail: string }> => {
        try {
          const auth = authHeader();
          const res = await fetch(`${API_BASE}${path}`, {
            headers: { accept: "application/json", ...(auth ? { authorization: auth } : {}) },
            redirect: "manual",
            signal: AbortSignal.timeout(5_000),
          });
          // Same split as lib/api.ts: only a redirect to /login is an auth
          // problem. A redirect anywhere else means the route is absent from
          // this build, and reporting that as "token rejected" next to
          // "api_token: present" is the contradiction that loops a small model.
          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("location") || "";
            return !loc || /(^|\/)login(\/|\?|#|$)/.test(loc)
              ? { ok: false, detail: "token rejected" }
              : { ok: false, detail: "not present in this software version" };
          }
          if (res.status === 404) return { ok: false, detail: "not present in this software version" };
          if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
          await res.json();
          return { ok: true, detail: "ok" };
        } catch {
          return { ok: false, detail: "no answer" };
        }
      };

      // The edition-specific probe is the one that proves the tools this agent
      // was actually given can work.
      const editionPath =
        ctx.edition === "hermes" ? "/setup-api/hermes/skills/installed" : "/setup-api/apps/store?limit=1";
      const [info, prefs, editionCheck] = await Promise.all([
        probe("/setup-api/system/info"),
        probe("/setup-api/preferences?all=1"),
        probe(editionPath),
      ]);
      checks.device_api = info;
      checks.preferences = prefs;
      checks[ctx.edition === "hermes" ? "hermes_skills" : "app_store"] = editionCheck;

      if (ctx.edition === "openclaw") {
        // GET /setup-api/gateway/health answers HTTP 200 even when the gateway
        // is gone — the answer is in the JSON `available` field. Reading the
        // status code here would report a masked gateway as healthy.
        const gw = await apiTry<{ available?: boolean }>("/setup-api/gateway/health", { timeoutMs: 5_000 });
        checks.gateway = gw
          ? { ok: gw.available === true, detail: gw.available === true ? "running" : "not running" }
          : { ok: false, detail: "no answer" };
      }

      const healthy = Object.values(checks).every((c) => c.ok);
      return json({ healthy, edition: ctx.edition, agent: ctx.edition === "hermes" ? "Hermes" : "OpenClaw", checks });
    },
  );

  reg.tool(
    "clawbox_context",
    "Load the ClawBox field guide: what this device is, its mascot, its architecture, the house rules, and how to store data in a webapp you build. Call it once at the start of a session, and always before answering \"what is this\" or \"what can you do\".",
    {},
    { editions: ["openclaw", "hermes"], readOnly: true, profile: "core", maxChars: 24_000 },
    async () => {
      const raw = loadFieldGuide();
      const guide = raw === null ? null : fieldGuideForEdition(raw, ctx.edition, ctx.install);
      const parts: string[] = [];
      if (guide && guide.trim()) parts.push(guide);
      else parts.push(`(The device field guide is not installed on this ClawBox.)`);
      parts.push(WEBAPP_STORAGE_GUIDE);
      return text(parts.join("\n\n---\n\n"));
    },
  );
}
