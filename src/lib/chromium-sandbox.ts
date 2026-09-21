/**
 * Chromium's namespace sandbox, on or off — the same test
 * `scripts/launch-browser.sh` makes for the window on the screen, so every
 * Chromium this box starts is hardened the same way.
 *
 * It lives here rather than in the browser route because there are now three
 * of them: the window on the owner's screen, the route's own headless one, and
 * the one the delivery pipeline opens to photograph a deployment
 * (the pipeline's verification). The route's own comment already said the point —
 * "so the two Chromiums on this box are not hardened differently by accident" —
 * and a third copy of the test is how that sentence stops being true.
 *
 * It cannot initialise where the kernel restricts unprivileged user namespaces
 * (Ubuntu 23.10+ through AppArmor, and the e2e container), and a blanket
 * `--no-sandbox` gives a page this browser opens — which can be any address a
 * run or the assistant types — a renderer running with the whole `clawbox`
 * user's privileges. So the flag is the exception it is in the launcher: on a
 * real Jetson the sandbox stays ON.
 */
import fs from "fs";

export function chromiumSandboxArgs(): string[] {
  if (process.env.CLAWBOX_TEST_MODE === "1") return ["--no-sandbox", "--disable-setuid-sandbox"];
  try {
    const restricted = fs.readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf-8").trim();
    if (restricted === "1") return ["--no-sandbox", "--disable-setuid-sandbox"];
  } catch {
    // No such knob on this kernel: nothing is restricting the sandbox.
  }
  return [];
}
