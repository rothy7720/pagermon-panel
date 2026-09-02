'use strict';

// Enumerate RTL-SDR dongles via `rtl_test`. rtl_test prints the device list to
// stderr immediately, then tries to open device 0 and either errors (device
// busy — the normal case here, rtl_fm has it) or runs a test loop forever, so it
// must be killed. We give it a short timeout and just scrape the list.
//
//   Found 2 device(s):
//     0:  Realtek, RTL2838UHIDIR, SN: 00000001
//     1:  Realtek, RTL2838UHIDIR, SN: 00000001

const { execFile } = require('child_process');

function splitBin(bin) {
  const parts = Array.isArray(bin) ? bin.slice() : [bin];
  return { cmd: parts[0], base: parts.slice(1) };
}

function run(bin, args, timeout) {
  const { cmd, base } = splitBin(bin);
  return new Promise((resolve) => {
    execFile(cmd, [...base, ...args], { timeout, killSignal: 'SIGKILL', maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      // err is expected (timeout kill, or "device busy" exit) — we only want the text
      resolve(`${stdout || ''}\n${stderr || ''}`);
    });
  });
}

function parse(text) {
  const out = [];
  const countM = text.match(/Found (\d+) device\(s\)/i);
  const count = countM ? Number(countM[1]) : null;
  const re = /^\s*(\d+):\s*(.+?)(?:,\s*(.+?))?(?:,\s*SN:\s*(\S+))?\s*$/gm;
  let m;
  while ((m = re.exec(text))) {
    // guard against matching unrelated "N: ..." lines
    if (!/realtek|rtl|generic|elonics|fitipower|rafael|SN:/i.test(m[0]) && out.length >= (count || 0)) continue;
    out.push({
      index: Number(m[1]),
      vendor: (m[2] || '').trim() || null,
      product: (m[3] || '').trim() || null,
      serial: (m[4] || '').trim() || null,
    });
  }
  return { count: count != null ? count : out.length, devices: out };
}

// Cache the result — rtl_test spawns a process and briefly opens USB devices,
// so we don't want it running on every 2s dashboard poll.
let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 20000;

async function listDevices(rtlTestBin, timeoutMs, opts = {}) {
  if (!opts.fresh && _cache && Date.now() - _cacheAt < CACHE_MS) return _cache;
  const result = await _listDevicesUncached(rtlTestBin, timeoutMs);
  _cache = result;
  _cacheAt = Date.now();
  return result;
}

async function _listDevicesUncached(rtlTestBin, timeoutMs) {
  const bin = rtlTestBin || 'rtl_test';
  let text;
  try {
    text = await run(bin, [], timeoutMs || 4000);
  } catch (e) {
    return { available: false, error: e.message, devices: [] };
  }
  if (/not found|ENOENT|command not found/i.test(text) && !/Found \d+ device/i.test(text)) {
    return { available: false, error: `${Array.isArray(bin) ? bin.join(' ') : bin} not found`, devices: [] };
  }
  const { count, devices } = parse(text);
  return { available: true, count, devices, raw: text.trim().slice(0, 2000) };
}

module.exports = { listDevices, parse };
