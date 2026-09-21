const DEFAULT_LOCAL_AI_PROXY_ROOT_URL = "http://127.0.0.1";

/** Loopback authority where the ClawBox UI exposes its local-AI proxy. */
export function getLocalAiProxyRootUrl(): string {
  const explicit = process.env.CLAWBOX_LOCAL_AI_PROXY_BASE_URL?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;

  const configuredPort = (process.env.CLAWBOX_PORT || process.env.PORT || "80").trim();
  const validPort = /^\d+$/.test(configuredPort)
    && Number(configuredPort) >= 1
    && Number(configuredPort) <= 65535;
  const port = validPort ? configuredPort : "80";
  return `${DEFAULT_LOCAL_AI_PROXY_ROOT_URL}${port === "80" ? "" : `:${port}`}`;
}
