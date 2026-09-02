'use strict';

const os = require('os');
const fs = require('fs');
const { exec, execFile } = require('child_process');

// CPU temperature from /sys/class/thermal (Linux). millidegrees C. Returns
// { celsius, source } or null. Prefers a package/core sensor over the generic
// acpitz zone. Never throws; empty on non-Linux or headless VMs with no sensor.
function cpuTemp() {
  if (process.env.PANEL_FAKE_CPU_TEMP) {
    return { celsius: Number(process.env.PANEL_FAKE_CPU_TEMP), source: 'fake' };
  }
  let zones;
  try {
    zones = fs.readdirSync('/sys/class/thermal').filter((d) => /^thermal_zone\d+$/.test(d));
  } catch (e) {
    return null;
  }
  const readings = [];
  for (const z of zones) {
    let type = '';
    let milli = NaN;
    try { type = fs.readFileSync(`/sys/class/thermal/${z}/type`, 'utf8').trim(); } catch (e) {}
    try { milli = parseInt(fs.readFileSync(`/sys/class/thermal/${z}/temp`, 'utf8'), 10); } catch (e) {}
    if (!Number.isFinite(milli)) continue;
    const c = milli / 1000;
    if (c <= 0 || c > 150) continue; // ignore bogus/placeholder values
    readings.push({ type, celsius: Math.round(c * 10) / 10 });
  }
  if (!readings.length) return null;
  const rank = (t) => (/pkg|package|coretemp|k10temp|zen|x86/i.test(t) ? 3 : /cpu|soc|tctl/i.test(t) ? 2 : /acpitz/i.test(t) ? 1 : 0);
  readings.sort((a, b) => rank(b.type) - rank(a.type) || b.celsius - a.celsius);
  return { celsius: readings[0].celsius, source: readings[0].type || 'thermal_zone' };
}

function hostInfo() {
  const temp = cpuTemp();
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptimeSec: Math.round(os.uptime()),
    loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    cpus: os.cpus().length,
    cpuTempC: temp ? temp.celsius : null,
    cpuTempSource: temp ? temp.source : null,
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

module.exports = { hostInfo, cpuTemp, sdrDongles, reboot };
