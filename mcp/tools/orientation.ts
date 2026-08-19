// Orientation tools: what this device is, whether it is healthy, and the field
// guide. Build these first — every other tool's description points at them.

import { readFileSync } from "fs";
import { join } from "path";
import { apiTry, apiToken, API_BASE, authHeader } from "../lib/api";
import { DEFAULT_CWD } from "../lib/guard";
import { json, text, type Registrar } from "../lib/register";
import type { McpContext } from "../lib/context";

const FIELD_GUIDE_PATH = join(DEFAULT_CWD, "Clawbox.md");

// Moved wholesale out of webapp_create / code_project_init: those descriptions
// were 700+ chars of tutorial that a small model had to read on every
// tools/list, to learn something it only needs once it is actually writing an
// app. It lives here, load-on-demand.
const WEBAPP_STORAGE_GUIDE = `## Storing data in a ClawBox webapp

Do NOT use localStorage — it does not survive a session. Use the device KV store:
  GET  /setup-api/kv?key=myapp:data      -> { key, value }
  GET  /setup-api/kv?prefix=myapp:       -> { "myapp:a": "...", "myapp:b": "..." }
  POST /setup-api/kv  { key: "myapp:data", value: JSON.stringify(data) }
  POST /setup-api/kv  { delete: "myapp:data" }

Namespace every key with your app id ("todo:items", "notes:list"). Values are
strings: JSON.stringify before saving, JSON.parse after loading.

Style single-file apps dark: background #1a1a2e, text #e0e0e0, accent #f97316.
No CDN links — the device may be offline.`;

function loadFieldGuide(): string | null {
  try {
    return readFileSync(FIELD_GUIDE_PATH, "utf8");
  } catch {
    // Missing on a fresh device that has not synced Clawbox.md yet.
    return null;
  }
}

interface StatsPayload {
  memory?: { usedPercent?: number };
  storage?: { mountpoint?: string; size?: string; used?: string; avail?: string; usePercent?: number }[];
  temperature?: unknown;
}

interface VersionsPayload {
  clawbox?: { current?: string | null; target?: string | null; updateAvailable?: boolean };
  openclaw?: { current?: string | null; target?: string | null; updateAvailable?: boolean };
}

interface HermesModelsPayload {
  current?: string;
  provider?: string;
  reasoning?: string;
}

interface ClawaiPayload {
  hasToken?: boolean;
  tier?: string;
  active?: boolean;
  model?: string;
}

interface ChatModelPayload {
  selected?: { model?: string | null; provider?: string | null; label?: string } | null;
  current?: string | null;
}

interface ConfiguredModelLimits {
  model: string;
  context_window_tokens: number | "unknown";
  max_output_tokens: number | "unknown";
  source: "openclaw_config";
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
    "Report what this ClawBox is: edition, active agent, AI provider and model, the active model's configured context/output limits, thinking level, free disk space, and whether a software update is waiting. Call this before answering any question about the device itself or its model limits. Any part that cannot be read reports \"unknown\" instead of failing the whole call.",
    {},
    { editions: ["openclaw", "hermes"], readOnly: true, profile: "core" },
    async () => {
      // Independent legs, independent timeouts: a stalled updater must not cost
      // the agent the disk figure it actually asked for.
      const [stats, versions, hermesModels, clawai, chatModel] = await Promise.all([
        apiTry<StatsPayload>("/setup-api/system/stats", { timeoutMs: 6_000 }),
        apiTry<VersionsPayload>("/setup-api/update/versions", { timeoutMs: 6_000 }),
        ctx.edition === "hermes"
          ? apiTry<HermesModelsPayload>("/setup-api/hermes/models", { timeoutMs: 6_000 })
          : Promise.resolve(null),
        ctx.edition === "hermes"
          ? apiTry<ClawaiPayload>("/setup-api/hermes/clawai", { timeoutMs: 6_000 })
          : Promise.resolve(null),
        ctx.edition === "openclaw"
          ? apiTry<ChatModelPayload>("/setup-api/chat/model", { timeoutMs: 6_000 })
          : Promise.resolve(null),
      ]);

      const ai =
        ctx.edition === "hermes"
          ? {
              provider: hermesModels?.provider ?? "unknown",
              model: hermesModels?.current ?? "unknown",
              thinking: hermesModels?.reasoning ?? "unknown",
              // READ ONLY. Changing the plan changes what the customer is
              // billed, so there is deliberately no tool that switches it:
              // point the user at Settings -> AI instead.
              clawbox_ai: clawai
                ? { signed_in: clawai.hasToken === true, tier: clawai.tier ?? "unknown", in_use: clawai.active === true }
                : "unknown",
            }
          : {
              provider: chatModel?.selected?.provider ?? "unknown",
              model: chatModel?.selected?.model ?? chatModel?.current ?? "unknown",
              limits: readConfiguredModelLimits(),
              thinking: "unknown",
            };

      return json({
        edition: ctx.edition,
        install_edition: ctx.install,
        agent: ctx.edition === "hermes" ? "Hermes" : "OpenClaw",
        ai,
        disk: rootDisk(stats),
        memory_used_percent: stats?.memory?.usedPercent ?? "unknown",
        update: versions
          ? {
              clawbox: versions.clawbox ?? "unknown",
              ...(ctx.edition === "openclaw" ? { openclaw: versions.openclaw ?? "unknown" } : {}),
              waiting:
                versions.clawbox?.updateAvailable === true
                || (ctx.edition === "openclaw" && versions.openclaw?.updateAvailable === true),
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
      const guide = loadFieldGuide();
      const parts: string[] = [];
      if (guide && guide.trim()) parts.push(guide);
      else parts.push(`(The device field guide is not installed on this ClawBox.)`);
      parts.push(WEBAPP_STORAGE_GUIDE);
      return text(parts.join("\n\n---\n\n"));
    },
  );
}
