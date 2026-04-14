import os from "os";
import path from "path";

function firstNonEmpty(...values: Array<string | undefined | null>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function resolveClawboxUser(): string {
  const explicitUser = firstNonEmpty(process.env.CLAWBOX_USER, process.env.SUDO_USER);
  if (explicitUser) return explicitUser;

  const loginUser = firstNonEmpty(process.env.USER, process.env.LOGNAME);
  if (loginUser && loginUser !== "root") return loginUser;

  try {
    const userInfo = os.userInfo().username.trim();
    if (userInfo && userInfo !== "root") return userInfo;
  } catch {
    // Fall through to the device-style default below.
  }

  return loginUser || "clawbox";
}

function resolveClawboxHome(user: string): string {
  const explicitHome = firstNonEmpty(process.env.CLAWBOX_HOME);
  if (explicitHome) return explicitHome;

  const envHome = firstNonEmpty(process.env.HOME);
  if (envHome && envHome !== "/root") return envHome;

  return path.join("/home", user === "root" ? "clawbox" : user);
}

export const CLAWBOX_USER = resolveClawboxUser();
export const CLAWBOX_HOME = resolveClawboxHome(CLAWBOX_USER);
export const CLAWBOX_ROOT =
  firstNonEmpty(process.env.CLAWBOX_ROOT, process.env.CONFIG_ROOT)
  || (process.env.NODE_ENV === "development" ? process.cwd() : path.join(CLAWBOX_HOME, "clawbox"));
export const DATA_DIR = path.join(CLAWBOX_ROOT, "data");
export const FILES_ROOT = firstNonEmpty(process.env.FILES_ROOT) || CLAWBOX_HOME;
export const OPENCLAW_HOME = firstNonEmpty(process.env.OPENCLAW_HOME) || path.join(CLAWBOX_HOME, ".openclaw");
export const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");
export const CLAWBOX_DOWNLOADS_DIR = path.join(CLAWBOX_HOME, "Downloads");
export const CLAWBOX_NPM_PREFIX = firstNonEmpty(process.env.NPM_PREFIX) || path.join(CLAWBOX_HOME, ".npm-global");
export const HF_BIN_PATH = firstNonEmpty(process.env.HF_BIN) || path.join(CLAWBOX_HOME, ".local", "bin", "hf");
export const AP_START_SCRIPT = firstNonEmpty(process.env.AP_START_SCRIPT) || path.join(CLAWBOX_ROOT, "scripts", "start-ap.sh");
export const AP_STOP_SCRIPT = firstNonEmpty(process.env.AP_STOP_SCRIPT) || path.join(CLAWBOX_ROOT, "scripts", "stop-ap.sh");
export const CLAWBOX_INSTALL_MODE = firstNonEmpty(process.env.CLAWBOX_INSTALL_MODE) || "device";
export const CLAWBOX_INSTALL_SCRIPT =
  firstNonEmpty(process.env.CLAWBOX_INSTALL_SCRIPT)
  || path.join(CLAWBOX_ROOT, CLAWBOX_INSTALL_MODE === "x64" ? "install-x64.sh" : "install.sh");

export function getClawboxRuntimeEnv(
  extraEnv: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: CLAWBOX_HOME,
    CLAWBOX_HOME,
    CLAWBOX_ROOT,
    OPENCLAW_HOME,
    FILES_ROOT,
    HF_BIN: HF_BIN_PATH,
    CLAWBOX_INSTALL_MODE,
    CLAWBOX_INSTALL_SCRIPT,
    ...extraEnv,
  };
}
