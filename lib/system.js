'use strict';

const os = require('os');
const { exec, execFile } = require('child_process');

function hostInfo() {
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptimeSec: Math.round(os.uptime()),
    loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    cpus: os.cpus().length,
    memTotalBytes: os.totalmem(),
    memFreeBytes: os.freemem(),
  };
}

// Best-effort list of RTL-SDR dongles via lsusb. Never throws.
function sdrDongles() {
  return new Promise((resolve) => {
    execFile('lsusb', { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const hits = stdout
        .split('\n')
        .filter((l) => /RTL2838|RTL2832|Realtek.*DVB|RTL-SDR|dongle/i.test(l))
        .map((l) => l.trim());
      resolve(hits);
    });
  });
}

function reboot(rebootCommand) {
  return new Promise((resolve, reject) => {
    if (!rebootCommand) return reject(new Error('rebootCommand not configured'));
    // Detached so the panel's own shutdown mid-request doesn't kill it.
    const child = exec(rebootCommand, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err && err.code !== undefined && err.killed) {
        // process may be torn down by the reboot itself before exec resolves
        return resolve({ note: 'reboot command issued (process ended)' });
      }
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
    child.unref();
  });
}

module.exports = { hostInfo, sdrDongles, reboot };
