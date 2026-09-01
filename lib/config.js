'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  port: 8080,
  bind: '0.0.0.0',
  pm2Bin: 'pm2',
  rebootCommand: 'sudo /usr/sbin/reboot',
  logTailBytes: 200000,
  pagesPerProcess: 20,
  logPattern: null,
  test: { baud: 512, function: 3 },
  decoders: [],
};

let CONFIG_PATH = null;
let current = null;

function shortId(prefix) {
  return prefix + crypto.randomBytes(3).toString('hex');
}

// Fill in defaults + generate any missing ids. Mutates a copy, returns it.
function normalize(raw) {
  const c = { ...DEFAULTS, ...raw };
  c.test = { ...DEFAULTS.test, ...(raw.test || {}) };

  // one decoder == one pm2 reader process, with a custom label. No grouping.
  const src = Array.isArray(raw.decoders) ? raw.decoders : [];
  const seen = new Set();
  c.decoders = src.map((d, i) => {
    let id = String(d.id || '').trim() || shortId('d');
    while (seen.has(id)) id = shortId('d');
    seen.add(id);
    return {
      id,
      label: String(d.label || '').trim() || `Decoder ${i + 1}`,
      staleMinutes: Number.isFinite(+d.staleMinutes) && +d.staleMinutes > 0 ? +d.staleMinutes : 30,
      pm2Ref: String(d.pm2Ref || '').trim(),
      cwd: String(d.cwd || '').trim(),
      readerCmd: String(d.readerCmd || '').trim() || 'node ./reader.js',
      configFile: String(d.configFile || '').trim(), // path to reader.sh (holds the frequency)
      logFile: String(d.logFile || '').trim(),       // optional: read pages from here instead of the pm2 stdout log
    };
  });

  // numeric coercions / guards
  c.port = clampInt(c.port, 1, 65535, 8080);
  c.logTailBytes = clampInt(c.logTailBytes, 4096, 20 * 1024 * 1024, 200000);
  c.pagesPerProcess = clampInt(c.pagesPerProcess, 1, 200, 20);
  return c;
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(+v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function load(configPath) {
  CONFIG_PATH = configPath;
  let raw = {};
  if (fs.existsSync(CONFIG_PATH)) {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } else {
    // first run — write a starter file so the settings page has something to edit
    raw = { ...DEFAULTS };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
  }
  current = normalize(raw);
  return current;
}

function get() {
  if (!current) throw new Error('config not loaded');
  return current;
}

// Merge a partial update from the settings page, validate, persist, hot-swap.
function save(patch) {
  const merged = normalize({ ...current, ...patch });
  const tmp = CONFIG_PATH + '.tmp';
  const bak = CONFIG_PATH + '.bak';
  fs.writeFileSync(tmp, JSON.stringify(stripInternal(merged), null, 2));
  try { fs.copyFileSync(CONFIG_PATH, bak); } catch {}
  fs.renameSync(tmp, CONFIG_PATH);
  current = merged;
  return current;
}

// what we persist == what we keep in memory (ids and all), minus nothing for now
function stripInternal(c) {
  return c;
}

module.exports = { load, get, save, normalize, DEFAULTS, path: () => CONFIG_PATH };
