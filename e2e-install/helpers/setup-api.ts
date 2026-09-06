/**
 * Thin typed client for /setup-api/* endpoints, used directly (not via a
 * browser page) so happy-path tests can exercise the full install/setup
 * lifecycle without needing a full graphical session.
 */
import { BASE_URL, dockerExec } from "./container";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${res.statusText}: ${text}`);
  }
  return body as T;
}

// ── Session ───────────────────────────────────────────────────────────────

/** The password `10-setup-wizard.spec.ts` sets while running the wizard. */
export const SETUP_PASSWORD = "clawbox-e2e-pass";

/** One of the durations `/login-api` accepts, in seconds. */
const SESSION_DURATION_SECONDS = 21_600;

/**
 * Log in and return the `clawbox_session` cookie as a ready-to-send
 * `name=value` pair.
 *
 * Browser-driven specs get this cookie for free from the Playwright context.
 * Specs that open a raw socket do not: a WebSocket upgrade is served by
 * `production-server.js` and never passes through the Next.js request
 * pipeline, so those specs have to carry the session on the upgrade request
 * themselves — exactly as the desktop UI does.
 */
export async function loginSessionCookie(
  password: string = SETUP_PASSWORD,
): Promise<string> {
  const res = await fetch(`${BASE_URL}/login-api`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password, duration: SESSION_DURATION_SECONDS }),
  });
  if (!res.ok) {
    throw new Error(
      `POST /login-api → ${res.status} ${res.statusText}: ${await res.text()}`,
    );
  }
  // `getSetCookie()` keeps multiple Set-Cookie headers separate; the single
  // -header fallback keeps this working on any runtime that lacks it.
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const cookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  for (const raw of cookies) {
    const match = /(?:^|,\s*)(clawbox_session=[^;,]+)/.exec(raw);
    if (match) return match[1];
  }
  throw new Error(
    `/login-api returned 200 but set no clawbox_session cookie: ${cookies.join(" | ")}`,
  );
}

/**
 * What /setup-api/setup/status tells a caller with NO session.
 *
 * This route is the one deliberately public /setup-api endpoint (the /login
 * page and the desktop bootstrap both read it before a session exists) AND it
 * is reachable through the cloudflared tunnel, so its unauthenticated payload
 * is readable by anyone holding that URL. It therefore carries only the
 * wizard's own progress — which AI provider the box is wired to, which local
 * model it runs and whether Telegram is configured are session-only.
 */
export interface SetupStatusPublic {
  setup_complete: boolean;
  wifi_configured: boolean;
  update_completed: boolean;
  password_configured: boolean;
  setup_progress_step: number | null;
}

/** The full payload, served only to a caller with a session. */
export interface SetupStatus extends SetupStatusPublic {
  local_ai_configured: boolean;
  local_ai_provider?: string | null;
  local_ai_model?: string | null;
  ai_model_configured: boolean;
  telegram_configured: boolean;
}

/** The trimmed payload an anonymous caller sees. */
export const getStatus = () => request<SetupStatusPublic>("/setup-api/setup/status");

/**
 * The full payload, fetched the way the desktop actually fetches it — with a
 * session. Use this for anything beyond the wizard's progress flags.
 */
export async function getStatusAuthed(
  password: string = SETUP_PASSWORD,
): Promise<SetupStatus> {
  const cookie = await loginSessionCookie(password);
  return request<SetupStatus>("/setup-api/setup/status", { headers: { cookie } });
}

export const scanWifi = () =>
  request<{ scanning: boolean; networks: Array<{ ssid: string }> | null }>("/setup-api/wifi/scan?live=1", {
    method: "POST",
  });

export const connectWifi = (ssid: string, password: string) =>
  request<{ success: boolean; message?: string }>("/setup-api/wifi/connect", {
    method: "POST",
    body: JSON.stringify({ ssid, password }),
  });

export const skipWifi = () =>
  request<{ success: boolean }>("/setup-api/wifi/connect", {
    method: "POST",
    body: JSON.stringify({ skip: true }),
  });

export const setSystemPassword = (password: string) =>
  request<{ success: boolean }>("/setup-api/system/credentials", {
    method: "POST",
    body: JSON.stringify({ password }),
  });

export const setHotspot = (ssid: string, password?: string, enabled = true) =>
  request<{ success: boolean }>("/setup-api/system/hotspot", {
    method: "POST",
    body: JSON.stringify({ ssid, password, enabled }),
  });

export const configureAiModel = (provider: string, apiKey: string, scope: "primary" | "local" = "primary") =>
  request<{ success: boolean }>("/setup-api/ai-models/configure", {
    method: "POST",
    body: JSON.stringify({ provider, apiKey, scope }),
  });

export const configureTelegram = (botToken: string) =>
  request<{ success: boolean }>("/setup-api/telegram/configure", {
    method: "POST",
    body: JSON.stringify({ botToken }),
  });

export const completeSetup = () =>
  request<{ success: boolean }>("/setup-api/setup/complete", { method: "POST" });

export const startUpdate = (force = false) =>
  request<{ started: boolean; already_completed?: boolean }>("/setup-api/update/run", {
    method: "POST",
    body: JSON.stringify({ force }),
  });

export interface UpdateState {
  phase: "idle" | "running" | "completed" | "failed";
  steps: Array<{ id: string; label: string; status: string; error?: string }>;
  currentStepIndex: number;
  error?: string;
}

export const getUpdateStatus = () => request<UpdateState>("/setup-api/update/status");

// ── System ────────────────────────────────────────────────────────────────

export const getSystemStats = () =>
  request<{ cpu: unknown; memory: unknown; temperature: unknown }>("/setup-api/system/stats");

export const getSystemInfo = () =>
  request<{ hostname: string; os: string; uptime: string }>("/setup-api/system/info");

export const systemPower = (action: "restart" | "shutdown") =>
  request<{ success: boolean }>("/setup-api/system/power", {
    method: "POST",
    body: JSON.stringify({ action }),
  });

// ── Preferences / KV ──────────────────────────────────────────────────────

export const getPreferences = () =>
  request<Record<string, unknown>>("/setup-api/preferences?all=1");

export const setPreferences = (patch: Record<string, unknown>) =>
  request<{ success: boolean }>("/setup-api/preferences", {
    method: "POST",
    body: JSON.stringify(patch),
  });

// ── Files ─────────────────────────────────────────────────────────────────

export const listFiles = (dir = "") =>
  request<{ files: Array<{ name: string; type: string; size: number | null }> }>(
    `/setup-api/files?dir=${encodeURIComponent(dir)}`,
  );

export const mkdir = (dir: string, name: string) =>
  request<{ success: boolean }>(
    `/setup-api/files?dir=${encodeURIComponent(dir)}`,
    { method: "POST", body: JSON.stringify({ action: "mkdir", name }) },
  );

export async function uploadFile(dir: string, name: string, contents: string | Uint8Array): Promise<void> {
  const body: BodyInit = typeof contents === "string"
    ? contents
    : new Blob([contents as unknown as ArrayBuffer]);
  const res = await fetch(`${BASE_URL}/setup-api/files?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, {
    method: "PUT",
    body,
  });
  if (!res.ok) throw new Error(`upload ${name} → ${res.status}: ${await res.text()}`);
}

export async function readFileRaw(fullPath: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/setup-api/files/${fullPath.split("/").map(encodeURIComponent).join("/")}`);
  if (!res.ok) throw new Error(`read ${fullPath} → ${res.status}`);
  return res.text();
}

export async function deleteFile(fullPath: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/setup-api/files/${fullPath.split("/").map(encodeURIComponent).join("/")}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`delete ${fullPath} → ${res.status}`);
}

// ── Browser ───────────────────────────────────────────────────────────────

export const browserManage = (action: "install-chromium" | "enable" | "disable" | "open-browser" | "close-browser") =>
  request<{ chromium: { installed: boolean }; browser: { running: boolean; cdpReady: boolean }; enabled: boolean }>(
    "/setup-api/browser/manage",
    { method: "POST", body: JSON.stringify({ action }) },
  );

export const getBrowserManage = () =>
  request<{ chromium: { installed: boolean }; browser: { running: boolean; cdpReady: boolean }; enabled: boolean }>(
    "/setup-api/browser/manage",
  );

export const browserLaunch = (url: string) =>
  request<{ sessionId: string; url: string; title: string; screenshot: string | null }>(
    "/setup-api/browser",
    { method: "POST", body: JSON.stringify({ action: "launch", url }) },
  );

export const browserNavigate = (sessionId: string, url: string) =>
  request<{ url: string; title: string; screenshot: string | null }>(
    "/setup-api/browser",
    { method: "POST", body: JSON.stringify({ action: "navigate", sessionId, url }) },
  );

export const browserScreenshot = (sessionId: string) =>
  request<{ screenshot: string | null }>(
    "/setup-api/browser",
    { method: "POST", body: JSON.stringify({ action: "screenshot", sessionId }) },
  );

export const browserClose = (sessionId: string) =>
  request<{ closed: boolean }>(
    "/setup-api/browser",
    { method: "POST", body: JSON.stringify({ action: "close", sessionId }) },
  );

// ── App store ─────────────────────────────────────────────────────────────

export interface StoreCatalog {
  total: number;
  apps: Array<{ slug: string; name: string; category: string }>;
}

export const searchApps = (query = "") =>
  request<StoreCatalog>(`/setup-api/apps/store?q=${encodeURIComponent(query)}`);

export const installApp = (appId: string) =>
  request<{ clawhub?: { success: boolean; error?: string }; reload?: string }>(
    "/setup-api/apps/install",
    { method: "POST", body: JSON.stringify({ appId }) },
  );

export interface InstallOutcome {
  status: number;
  ok: boolean;
  code?: string;
  error?: string;
  retryable?: boolean;
  matches?: Array<{ ownerHandle?: string; ref?: string }>;
  clawhub?: { success: boolean; error?: string };
}

/**
 * Like installApp, but a refusal is an answer, not an exception: the install
 * route reports ClawHub's honest verdict as a non-2xx with `ok:false` and a
 * `code` (review_required, ambiguous, not_found, rate_limited, …), and the
 * store spec needs to read that verdict rather than blow up on it.
 */
export async function installAppRaw(appId: string): Promise<InstallOutcome> {
  const res = await fetch(`${BASE_URL}/setup-api/apps/install`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* non-JSON body */ }
  return { status: res.status, ...body, ok: res.ok && body.ok !== false } as InstallOutcome;
}

export const uninstallApp = (appId: string) =>
  request<{ success: boolean }>(
    "/setup-api/apps/uninstall",
    { method: "POST", body: JSON.stringify({ appId }) },
  );

// ── Code assistant / webapps ──────────────────────────────────────────────

export interface CodeProject {
  projectId: string;
  name: string;
  color?: string;
  description?: string;
  created?: string;
  updated?: string;
}

export const codeProjectInit = (projectId: string, name: string) =>
  request<{ success: boolean; project: CodeProject }>(
    "/setup-api/code",
    { method: "POST", body: JSON.stringify({ action: "init", projectId, name }) },
  );

export const codeFileWrite = (projectId: string, filePath: string, content: string) =>
  request<{ success: boolean }>(
    "/setup-api/code",
    { method: "POST", body: JSON.stringify({ action: "file-write", projectId, filePath, content }) },
  );

export const codeProjectBuild = (projectId: string) =>
  request<{ success: boolean; url?: string; filesInlined?: number }>(
    "/setup-api/code",
    { method: "POST", body: JSON.stringify({ action: "build", projectId }) },
  );

export const codeProjectList = () =>
  request<{ projects: CodeProject[] }>(
    "/setup-api/code",
    { method: "POST", body: JSON.stringify({ action: "list-projects" }) },
  );

export const codeProjectDelete = (projectId: string) =>
  request<{ success: boolean }>(
    "/setup-api/code",
    { method: "POST", body: JSON.stringify({ action: "delete-project", projectId }) },
  );

// ── Gateway / chat ────────────────────────────────────────────────────────

export const getChatWsConfig = () =>
  request<{ token: string; wsUrl: string; model: string | null }>(
    "/setup-api/gateway/ws-config",
  );

export const getGatewayHealth = () =>
  request<{ available: boolean; port: number }>("/setup-api/gateway/health");

/**
 * Poll update status until phase is `completed` or `failed`, or until the
 * request itself starts failing (which happens during the real restart step —
 * the server is down for ~10-60s while the service bounces).
 *
 * Returns the final state. Tolerates transient fetch failures with
 * `maxConsecutiveFetchErrors` so a service restart doesn't abort the wait.
 */
/**
 * "Nothing has started" — the state a box reports when no update was ever asked
 * for.
 *
 * It is also, before TASK-731, what a box reported when an update HAD been
 * asked for and the web server that was running it was replaced: the step
 * list's position lived only in that process, and the next one released the
 * update lock and answered this. Six e2e-install runs polled it for the whole
 * 45-minute budget.
 */
function looksUnstarted(state: UpdateState): boolean {
  return (
    state.phase === "idle"
    && state.currentStepIndex < 0
    && state.steps.length > 0
    && state.steps.every((step) => step.status === "pending")
  );
}

/** What the container can say about a run that vanished. Never throws. */
async function diagnoseLostUpdate(): Promise<string> {
  const parts: string[] = [];
  const ask = async (label: string, cmd: string[]) => {
    try {
      parts.push(`${label}:\n${(await dockerExec(cmd, { user: "root" })).trim()}`);
    } catch (err) {
      parts.push(`${label}: could not be read (${err instanceof Error ? err.message : String(err)})`);
    }
  };
  // How many times the web server has been (re)started, and when: an update
  // whose process was replaced shows a restart between the POST and now.
  await ask("clawbox-setup.service", [
    "systemctl", "show", "clawbox-setup.service",
    "-p", "NRestarts", "-p", "ActiveEnterTimestamp", "-p", "ExecMainStartTimestamp", "-p", "Result",
  ]);
  await ask("the updater's own keys on disk", [
    "bash", "-lc",
    "python3 -c \"import json;d=json.load(open('/home/clawbox/clawbox/data/config.json'));"
    + "print({k:d.get(k) for k in ('update_in_progress','update_needs_continuation',"
    + "'update_interrupted_at','update_completed','update_completed_at')})\" 2>&1 || true",
  ]);
  // REDACTED, and only the web server's own unit. This message becomes a
  // Playwright error and is uploaded as a CI artifact on a PUBLIC repository,
  // where GitHub's `***` masking does not reach; the container is started with
  // real provider keys in its environment (e2e-install/.env.test). Anything
  // that looks like a token is replaced before it can be written down, and the
  // `clawbox-root-update@*` journal — the unit that runs install.sh, which
  // handles four provider keys — is deliberately not dumped at all.
  await ask("the last 40 web-server journal lines (redacted)", [
    "bash", "-lc",
    "journalctl -u clawbox-setup.service -n 40 --no-pager 2>&1 | sed -E 's/[A-Za-z0-9_-]{20,}/[redacted]/g' || true",
  ]);
  return parts.join("\n\n");
}

export async function waitForUpdate(
  opts: { timeoutMs?: number; maxConsecutiveFetchErrors?: number; unstartedBudgetMs?: number } = {},
): Promise<UpdateState> {
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  const maxConsecutiveFetchErrors = opts.maxConsecutiveFetchErrors ?? 60; // ~3min downtime
  // How long a state that says "nothing has started" is tolerated before it is
  // called what it is. It is legitimate only briefly — a web server that has
  // just come back answers it until `checkContinuation()` resumes the second
  // half, which is one poll later — so two minutes is generous by a wide
  // margin, and it replaces a 45-minute wait for a state machine that cannot
  // move.
  const unstartedBudgetMs = opts.unstartedBudgetMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  let consecutiveErrors = 0;
  let lastState: UpdateState | null = null;
  let unstartedSince: number | null = null;
  while (Date.now() < deadline) {
    try {
      const state = await getUpdateStatus();
      lastState = state;
      consecutiveErrors = 0;
      if (state.phase === "completed" || state.phase === "failed") {
        return state;
      }
      if (looksUnstarted(state)) {
        unstartedSince ??= Date.now();
        if (Date.now() - unstartedSince > unstartedBudgetMs) {
          // The headline says what was OBSERVED, not what caused it. This shape
          // has two causes and the poller cannot tell them apart: a run that
          // lost its process (TASK-731), and a run that FINISHED whose status
          // the container cannot synthesise as `completed` — the e2e box is
          // permanently `checkout-dirty`, which forces drift and disables that
          // synthesis for the whole run, so a web-server restart after a good
          // update lands here too. The disk keys below say which: an
          // `update_interrupted_at` is the first, an `update_completed` with no
          // lock is the second.
          throw new Error(
            `the box has reported "nothing is running" for `
            + `${Math.round((Date.now() - unstartedSince) / 1000)}s after the update was accepted. `
            + `Either the web server that owned the run was replaced and its successor had nothing to `
            + "resume (TASK-731), or the run finished and this container cannot report completed "
            + "because it is permanently drifted. The updater's own keys below say which.\n"
            + `last state: ${JSON.stringify(lastState)}\n\n${await diagnoseLostUpdate()}`,
          );
        }
      } else {
        unstartedSince = null;
      }
    } catch (err) {
      // Our own verdict is not a fetch failure; it must not be counted as one.
      if (err instanceof Error && err.message.startsWith("the box has reported")) throw err;
      consecutiveErrors += 1;
      if (consecutiveErrors > maxConsecutiveFetchErrors) {
        throw new Error(`update status unreachable for ${consecutiveErrors * 3}s — giving up`);
      }
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(
    `update did not complete within ${timeoutMs}ms; last state: ${JSON.stringify(lastState)}`
    + `\n\n${await diagnoseLostUpdate()}`,
  );
}

// ── Tunnel (Cloudflare quick-tunnel) ─────────────────────────────────

export interface TunnelStatusResponse {
  enabled: boolean;
  running: boolean;
  tunnelUrl: string | null;
  error: string | null;
  cloudflaredInstalled: boolean;
}

export const getTunnelStatus = () =>
  request<TunnelStatusResponse>("/setup-api/tunnel/status");

export const enableTunnel = () =>
  request<{ success: boolean; tunnelUrl?: string; error?: string }>(
    "/setup-api/tunnel/enable",
    { method: "POST" },
  );

export const disableTunnel = () =>
  request<{ success: boolean; error?: string }>("/setup-api/tunnel/disable", {
    method: "POST",
  });

// ── VNC ──────────────────────────────────────────────────────────────

export const getVncStatus = () =>
  request<{ available: boolean; vncPort?: number; wsPort?: number }>(
    "/setup-api/vnc",
  );

// ── Ollama ───────────────────────────────────────────────────────────

export interface OllamaStatus {
  running: boolean;
  models: Array<{ name: string; size?: number; modified_at?: string }>;
  standbyEnabled?: boolean;
  idleTimeoutMs?: number;
  proxyBaseUrl?: string;
}

export const getOllamaStatus = () =>
  request<OllamaStatus>("/setup-api/ollama/status");

export const searchOllama = (query: string) =>
  request<{ results: Array<{ name: string; description?: string }> }>(
    `/setup-api/ollama/search?q=${encodeURIComponent(query)}`,
  );

// ── ClawKeep ─────────────────────────────────────────────────────────

export interface ClawKeepStatus {
  initialized: boolean;
  configured: boolean;
  hasLocalTarget?: boolean;
  hasCloudTarget?: boolean;
  lastSnap?: string | null;
}

export const getClawkeepStatus = (sourcePath: string) =>
  request<ClawKeepStatus>(
    `/setup-api/clawkeep?sourcePath=${encodeURIComponent(sourcePath)}`,
  );

export const clawkeepInit = (sourcePath: string) =>
  request<ClawKeepStatus>("/setup-api/clawkeep", {
    method: "POST",
    body: JSON.stringify({ action: "init", sourcePath }),
  });

export const clawkeepConfigure = (
  sourcePath: string,
  opts: { localPath?: string; cloudEnabled?: boolean; password?: string },
) =>
  request<ClawKeepStatus>("/setup-api/clawkeep", {
    method: "POST",
    body: JSON.stringify({ action: "configure", sourcePath, ...opts }),
  });

export const clawkeepSnap = (sourcePath: string, message?: string) =>
  request<{ success?: boolean }>("/setup-api/clawkeep", {
    method: "POST",
    body: JSON.stringify({ action: "snap", sourcePath, message }),
  });
