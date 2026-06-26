/**
 * Single source of truth for the chpasswd hand-off between the Next.js
 * routes and the root systemd template that actually runs `chpasswd`.
 *
 * The route writes `<user>:<password>\n` to {@link CHPASSWD_INPUT_PATH} at
 * mode 0600, then triggers {@link CHPASSWD_SERVICE_NAME}. The unit (defined
 * by `config/clawbox-root-update@.service` + `install.sh::step_chpasswd`)
 * reads the same path, runs `chpasswd`, and `rm -f`s the file.
 *
 * Keep this file's constants aligned with `install.sh::step_chpasswd` —
 * both ends must agree on the path, or chpasswd silently no-ops while the
 * route reports success.
 */
import path from "path";
import { DATA_DIR } from "@/lib/config-store";

export const CHPASSWD_INPUT_PATH = path.join(DATA_DIR, ".chpasswd-input");
export const CHPASSWD_SERVICE_NAME = "clawbox-root-update@chpasswd.service";

// POSIX-portable username (useradd's default policy). The username reaches us
// via env vars (CLAWBOX_USER/SUDO_USER/USER), so validate before composing
// the record — a name containing ":" or a newline would inject an extra
// password entry into the colon/newline-delimited chpasswd format.
const SAFE_USERNAME = /^[a-z_][a-z0-9_-]{0,31}\$?$/;

/**
 * Compose a single chpasswd record, refusing usernames that could corrupt
 * the format. Colons in the PASSWORD are fine (chpasswd splits on the first
 * colon), but CR/LF/NUL would terminate the record early — reject them.
 */
export function chpasswdRecord(user: string, password: string): string {
  if (!SAFE_USERNAME.test(user)) {
    throw new Error(`Unsafe username for chpasswd record: ${JSON.stringify(user)}`);
  }
  if (/[\r\n\0]/.test(password)) {
    throw new Error("Unsafe password for chpasswd record (control characters)");
  }
  return `${user}:${password}\n`;
}
