/**
 * Thin typed client for /setup-api/* endpoints, used directly (not via a
 * browser page) so happy-path tests can exercise the full install/setup
 * lifecycle without needing a full graphical session.
 */
import { BASE_URL } from "./container";

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

export interface SetupStatus {
  setup_complete: boolean;
  wifi_configured: boolean;
  update_completed: boolean;
  password_configured: boolean;
  local_ai_configured: boolean;
  local_ai_provider?: string | null;
  local_ai_model?: string | null;
  ai_model_configured: boolean;
  telegram_configured: boolean;
}

export const getStatus = () => request<SetupStatus>("/setup-api/setup/status");

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

/**
 * Poll update status until phase is `completed` or `failed`, or until the
 * request itself starts failing (which happens during the real restart step —
 * the server is down for ~10-60s while the service bounces).
 *
 * Returns the final state. Tolerates transient fetch failures with
 * `maxConsecutiveFetchErrors` so a service restart doesn't abort the wait.
 */
export async function waitForUpdate(
  opts: { timeoutMs?: number; maxConsecutiveFetchErrors?: number } = {},
): Promise<UpdateState> {
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  const maxConsecutiveFetchErrors = opts.maxConsecutiveFetchErrors ?? 60; // ~3min downtime
  const deadline = Date.now() + timeoutMs;
  let consecutiveErrors = 0;
  let lastState: UpdateState | null = null;
  while (Date.now() < deadline) {
    try {
      const state = await getUpdateStatus();
      lastState = state;
      consecutiveErrors = 0;
      if (state.phase === "completed" || state.phase === "failed") {
        return state;
      }
    } catch {
      consecutiveErrors += 1;
      if (consecutiveErrors > maxConsecutiveFetchErrors) {
        throw new Error(`update status unreachable for ${consecutiveErrors * 3}s — giving up`);
      }
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`update did not complete within ${timeoutMs}ms; last state: ${JSON.stringify(lastState)}`);
}
