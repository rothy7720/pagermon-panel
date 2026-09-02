'use strict';

// Read / change the RX frequency in a PagerMon client's reader.sh (or any shell
// script that drives rtl_fm). Two patterns are supported, tried in this order:
//
//   1. a shell variable assignment:   FREQ=148.5375M   (also FREQUENCY / freq / RTL_FREQ)
//   2. an inline flag on the rtl_fm / rtl_power line:   rtl_fm ... -f 148.5375M ...
//
// A token is digits with an optional decimal and an optional k/M/G suffix.

const fs = require('fs');
const fsp = fs.promises;

const TOKEN = '[0-9]+(?:\\.[0-9]+)?[kKmMgG]?';
const VAR_RE = new RegExp(
  `^([ \\t]*(?:export[ \\t]+)?)(FREQ|FREQUENCY|freq|frequency|RTL_FREQ|RX_FREQ)([ \\t]*=[ \\t]*)(["']?)(${TOKEN})(["']?)([ \\t]*(?:#.*)?)$`,
  'm'
);
const INLINE_RE = new RegExp(
  `((?:rtl_fm|rtl_power)[^\\n|]*?(?:-f|--freq)[ =]+)(["']?)(${TOKEN})(["']?)`
);
// rtl_fm / rtl_power "-d <index-or-serial>"
const RTL_LINE_RE = /(?:rtl_fm|rtl_power)[^\n|]*/;
const DEV_RE = /(-d[ =]+)(["']?)([^\s"'|]+)(["']?)/;

function isToken(s) {
  return new RegExp(`^${TOKEN}$`).test(String(s || ''));
}

// "148.5375M" | "148537500" | "148537.5k"  ->  Hz (number) or null
function toHz(tok) {
  const m = String(tok).match(/^([0-9]*\.?[0-9]+)([kKmMgG]?)$/);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, g: 1e9 }[m[2].toLowerCase()] || 1;
  return parseFloat(m[1]) * mult;
}

function prettyFreq(tok) {
  const hz = toHz(tok);
  if (hz == null) return String(tok);
  return (hz / 1e6).toFixed(4).replace(/\.?0+$/, '') + ' MHz';
}

// What the user typed in the box -> a token rtl_fm accepts.
// A bare number below 10000 is assumed to be MHz.
function normalizeInput(raw) {
  let s = String(raw || '').trim().replace(/\s*mhz\s*$/i, 'M').replace(/\s*hz\s*$/i, '');
  s = s.replace(/\s+/g, '');
  if (/^[0-9]+(\.[0-9]+)?$/.test(s) && parseFloat(s) < 10000) s += 'M';
  if (!isToken(s)) throw new Error(`"${raw}" is not a valid frequency`);
  return s;
}

async function readFrequency(file) {
  if (!file) return null;
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (e) {
    return { error: e.code === 'ENOENT' ? 'config file not found' : e.message };
  }
  const v = text.match(VAR_RE);
  if (v) return { token: v[5], pretty: prettyFreq(v[5]), method: `${v[2]}=` };
  const i = text.match(INLINE_RE);
  if (i) return { token: i[3], pretty: prettyFreq(i[3]), method: 'rtl_fm -f' };
  return { error: 'no frequency found in that file' };
}

async function writeFrequency(file, rawInput) {
  if (!file) throw new Error('no config file set for this process');
  const tok = normalizeInput(rawInput);
  let text = await fsp.readFile(file, 'utf8');
  const before = text;

  if (VAR_RE.test(text)) {
    text = text.replace(VAR_RE, (_m, p1, name, eq, q1, _old, q2, rest) => `${p1}${name}${eq}${q1}${tok}${q2}${rest}`);
  } else if (INLINE_RE.test(text)) {
    text = text.replace(INLINE_RE, (_m, pre, q1, _old, q2) => `${pre}${q1}${tok}${q2}`);
  } else {
    throw new Error('could not find a frequency to change in that file');
  }
  if (text === before) return { token: tok, pretty: prettyFreq(tok), unchanged: true };

  await fsp.copyFile(file, file + '.bak').catch(() => {});
  await fsp.writeFile(file, text);
  return { token: tok, pretty: prettyFreq(tok) };
}

// ---- SDR device (-d) --------------------------------------------------------

function isDeviceRef(s) {
  return /^[A-Za-z0-9_.:-]{1,32}$/.test(String(s || ''));
}

async function readDevice(file) {
  if (!file) return null;
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (e) {
    return { error: e.code === 'ENOENT' ? 'config file not found' : e.message };
  }
  const line = text.match(RTL_LINE_RE);
  if (!line) return { error: 'no rtl_fm line in that file' };
  const d = line[0].match(DEV_RE);
  if (d) return { value: d[3], explicit: true };
  return { value: '0', explicit: false }; // rtl_fm defaults to device 0
}

async function writeDevice(file, rawRef) {
  if (!file) throw new Error('no config file set for this decoder');
  const ref = String(rawRef == null ? '' : rawRef).trim();
  if (!isDeviceRef(ref)) throw new Error(`"${rawRef}" is not a valid device index or serial`);

  let text = await fsp.readFile(file, 'utf8');
  const line = text.match(RTL_LINE_RE);
  if (!line) throw new Error('could not find an rtl_fm line to change in that file');
  const before = text;

  let newLine;
  if (DEV_RE.test(line[0])) {
    newLine = line[0].replace(DEV_RE, (_m, pre, q1, _old, q2) => `${pre}${q1}${ref}${q2}`);
  } else {
    // insert "-d <ref> " right after the command name
    newLine = line[0].replace(/^((?:rtl_fm|rtl_power)\s+)/, `$1-d ${ref} `);
  }
  text = text.slice(0, line.index) + newLine + text.slice(line.index + line[0].length);
  if (text === before) return { value: ref, unchanged: true };

  await fsp.copyFile(file, file + '.bak').catch(() => {});
  await fsp.writeFile(file, text);
  return { value: ref };
}

module.exports = {
  readFrequency, writeFrequency, prettyFreq, normalizeInput, isToken,
  readDevice, writeDevice, isDeviceRef,
};
