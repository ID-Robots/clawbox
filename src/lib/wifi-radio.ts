import { execFile, spawn } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

/** The caller's short scan timeout also bounds waiting for radio ownership.
 * The shell execs iw, so killing the child releases the lock, not an orphan.
 */
export function spawnWifiScan() {
  return spawn("bash", ["/usr/local/libexec/clawbox/wifi-radio.sh", "--iw-scan"]);
}

/** Same kernel lock as AP/failover services, without elevating the web account.
 * The helper refuses abandoned root recovery state until service cleanup lands.
 * Include lock wait in the process deadline, not the NM operation's own budget.
 */
export function execWifiNmcli(args: string[], opts: { timeout: number }) {
  return exec("bash", ["/usr/local/libexec/clawbox/wifi-radio.sh", "--nmcli", ...args], {
    timeout: opts.timeout + 180_000,
  });
}
