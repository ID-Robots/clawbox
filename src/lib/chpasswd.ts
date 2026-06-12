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
