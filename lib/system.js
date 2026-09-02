'use strict';

const os = require('os');
const fs = require('fs');
const { exec, execFile } = require('child_process');

function rd(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return null; }
}
function milliToC(s) {
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return null;
  const c = n / 1000;
  return c > 0 && c < 150 ? Math.round(c * 10) / 10 : null;
}

// A real CPU-die sensor (coretemp/k10temp/…) under /sys/class/hwmon. On Intel
// NUCs the ACPI thermal zone is a fixed placeholder, so this is what's real.
function hwmonCpuTemp() {
  let dirs;
  try { dirs = fs.readdirSync('/sys/class/hwmon').filter((d) => /^hwmon\d+$/.test(d)); }
  catch (e) { return null; }

  for (const d of dirs) {
    const base = `/sys/class/hwmon/${d}`;
    const name = (rd(`${base}/name`) || '').toLowerCase();
    if (!/coretemp|k10temp|zenpower|cpu.?thermal|k8temp|via.?cputemp/.test(name)) continue;

    const temps = [];
    for (let i = 1; i <= 32; i++) {
      const c = milliToC(rd(`${base}/temp${i}_input`));
      if (c == null) continue;
      temps.push({ label: (rd(`${base}/temp${i}_label`) || '').toLowerCase(), celsius: c });
    }
    if (!temps.length) continue;
    const pick =
      temps.find((t) => /package|tdie|tctl/.test(t.label)) ||
      temps.reduce((a, b) => (b.celsius > a.celsius ? b : a)); // hottest core
    return { celsius: pick.celsius, source: name + (pick.label ? ` (${pick.label})` : '') };
  }
  return null;
}

function thermalZoneTemp() {
  let zones;
  try { zones = fs.readdirSync('/sys/class/thermal').filter((d) => /^thermal_zone\d+$/.test(d)); }
  catch (e) { return null; }
  const readings = [];
  for (const z of zones) {
    const c = milliToC(rd(`/sys/class/thermal/${z}/temp`));
    if (c == null) continue;
    readings.push({ type: (rd(`/sys/class/thermal/${z}/type`) || '').toLowerCase(), celsius: c });
  }
  if (!readings.length) return null;
  const rank = (t) => (/pkg|package|coretemp|k10temp|zen|x86/.test(t) ? 3 : /cpu|soc|tctl/.test(t) ? 2 : /acpitz/.test(t) ? 1 : 0);
  readings.sort((a, b) => rank(b.type) - rank(a.type) || b.celsius - a.celsius);
  return { celsius: readings[0].celsius, source: readings[0].type || 'thermal_zone' };
}

// CPU temperature (Linux). { celsius, source } or null. A real hwmon CPU sensor
// beats the thermal zone. Never throws.
function cpuTemp() {
  if (process.env.PANEL_FAKE_CPU_TEMP) {
    return { celsius: Number(process.env.PANEL_FAKE_CPU_TEMP), source: 'fake' };
  }
  return hwmonCpuTemp() || thermalZoneTemp();
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
