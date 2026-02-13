const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);

const IFACE = 'wlP1p1s0';

async function scanWifi() {
  // Trigger a fresh scan (ignore errors like "scan already in progress")
  await exec('nmcli', ['device', 'wifi', 'rescan', 'ifname', IFACE]).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 3000));

  const { stdout } = await exec('nmcli', [
    '-t', '-f', 'SSID,SIGNAL,SECURITY,FREQ',
    'device', 'wifi', 'list', 'ifname', IFACE
  ]);

  const networks = stdout.trim().split('\n')
    .filter(line => line.trim())
    .map(line => {
      // nmcli terse mode uses ':' as delimiter; SSID could contain ':'
      // but SIGNAL, SECURITY, FREQ are at the end - parse from right
      const parts = line.split(':');
      if (parts.length < 4) return null;
      const freq = parts.pop();
      const security = parts.pop();
      const signal = parts.pop();
      const ssid = parts.join(':'); // rejoin in case SSID had ':'
      return { ssid, signal: parseInt(signal, 10), security, freq };
    })
    .filter(n => n && n.ssid && n.ssid !== 'ClawBox-Setup');

  // Deduplicate by SSID, keep strongest signal
  const deduped = new Map();
  for (const n of networks) {
    if (!deduped.has(n.ssid) || deduped.get(n.ssid).signal < n.signal) {
      deduped.set(n.ssid, n);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => b.signal - a.signal);
}

async function switchToClient(ssid, password) {
  console.log(`[WiFi] Switching to client mode, connecting to: ${ssid}`);

  // Stop the AP
  await exec('bash', ['/home/clawbox/clawbox/scripts/stop-ap.sh']);

  // Connect as client
  const args = ['device', 'wifi', 'connect', ssid, 'ifname', IFACE];
  if (password) {
    args.splice(4, 0, 'password', password);
  }

  const { stdout } = await exec('nmcli', args, { timeout: 30000 });
  console.log(`[WiFi] Connected: ${stdout.trim()}`);
  return { message: stdout.trim() };
}

async function restartAP() {
  console.log('[WiFi] Restarting access point...');
  await exec('bash', ['/home/clawbox/clawbox/scripts/start-ap.sh']);
}

async function getWifiStatus() {
  try {
    const { stdout } = await exec('nmcli', [
      '-t', '-f', 'GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS,IP4.GATEWAY',
      'device', 'show', IFACE
    ]);

    const info = {};
    for (const line of stdout.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > -1) {
        info[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    return info;
  } catch {
    return { error: 'WiFi interface not available' };
  }
}

module.exports = { scanWifi, switchToClient, restartAP, getWifiStatus };
