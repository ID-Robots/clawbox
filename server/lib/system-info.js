const os = require('os');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);

module.exports = {
  async gather() {
    const [uptimeRes, dfRes, tempRes] = await Promise.allSettled([
      exec('uptime', ['-p']),
      exec('df', ['-h', '--output=size,used,avail,pcent', '/']),
      fs.readFile('/sys/devices/virtual/thermal/thermal_zone0/temp', 'utf-8')
    ]);

    return {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpus: os.cpus().length,
      memoryTotal: Math.round(os.totalmem() / 1024 / 1024) + ' MB',
      memoryFree: Math.round(os.freemem() / 1024 / 1024) + ' MB',
      uptime: uptimeRes.status === 'fulfilled' ? uptimeRes.value.stdout.trim() : 'unknown',
      disk: dfRes.status === 'fulfilled' ? dfRes.value.stdout.trim() : 'unknown',
      temperature: tempRes.status === 'fulfilled'
        ? (parseInt(tempRes.value.trim(), 10) / 1000).toFixed(1) + '°C'
        : 'unknown',
      networkInterfaces: os.networkInterfaces()
    };
  }
};
