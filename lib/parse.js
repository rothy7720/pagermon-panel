'use strict';

// Pull decoded pages out of a PagerMon client's log text. Handles:
//   - pagermon reader.js:  "2026-09-02 10:04:26: 1003472: @@ALERT ..."
//     (optionally with a second pm2 --time timestamp prefixed)
//   - raw multimon-ng:     "POCSAG512: Address: 1213680  Function: 0  Alpha: MSG"
//   - multimon-ng FLEX
// Non-page chatter (startup lines, "Sending ... 200", etc.) is skipped.
// If your logs look different, set "logPattern" in config.json — a regex with
// named groups: addr (required), and optionally msg, baud, func, kind, mode.

const BUILTIN_PATTERNS = [
  // multimon-ng POCSAG (most common when the tap sees raw multimon output)
  /POCSAG(?<baud>\d{3,4})[:\-]?\s*Address:\s*(?<addr>\d+)\s*Function:\s*(?<func>\d)\s*(?<kind>Alpha|Numeric|Skyper)?:?\s?(?<msg>.*)$/i,
  // multimon-ng FLEX
  /FLEX[:\s].*?\[(?<addr>\d+)\]\s*(?<baud>\d+)?\/?\d*\/?\w*\s+(?<func>\d)?\s*(?<kind>ALN|NUM|ALPHANUM)?\s*(?<msg>.*)$/i,
  // pagermon client reader.js: one or two "YYYY-MM-DD[ T]HH:MM:SS:" timestamp
  // prefixes (its own, plus pm2 --time), then "<capcode>: <message>"
  /^(?:\s*\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d:\s*){0,3}(?<addr>\d{4,10}):\s+(?<msg>\S.*)$/,
];

// ISO-ish timestamp at the start of a log line, e.g.
// "2026-09-02T11:14:07.512Z", "2026-09-02 11:14:07", "[2026-09-02T11:14:07]"
const TS_RE = /^[\[\s]*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;

function compileUserPattern(src) {
  if (!src) return null;
  try {
    return new RegExp(src, 'i');
  } catch (e) {
    console.warn('[parse] invalid logPattern in config, ignoring:', e.message);
    return null;
  }
}

function cleanMessage(s) {
  if (!s) return '';
  return s
    .replace(/<EOT>\s*$/i, '')
    .replace(/\s+$/g, '')
    .replace(/^\s+/g, '')
    .trim();
}

// Parse a block of log text into page objects, oldest -> newest.
function parsePages(text, opts = {}) {
  const userPattern = compileUserPattern(opts.logPattern);
  const patterns = userPattern ? [userPattern, ...BUILTIN_PATTERNS] : BUILTIN_PATTERNS;
  const lines = String(text).split(/\r?\n/);
  const out = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    let m = null;
    for (const re of patterns) {
      m = line.match(re);
      if (m && m.groups && m.groups.addr) break;
      m = null;
    }
    if (!m) continue;

    const g = m.groups;
    const tsMatch = line.match(TS_RE);
    const ts = tsMatch ? new Date(tsMatch[1]).getTime() : null;

    let mode = g.mode || null;
    if (!mode) mode = g.baud ? `POCSAG${g.baud}` : (/FLEX/i.test(line) ? 'FLEX' : 'POCSAG');

    out.push({
      ts: Number.isFinite(ts) ? ts : null,
      address: g.addr,
      function: g.func != null && g.func !== '' ? Number(g.func) : null,
      mode,
      kind: (g.kind || 'Alpha'),
      message: cleanMessage(g.msg),
      raw: line.trim(),
    });
  }

  return out;
}

// Newest-first, capped, with a synthetic timestamp fallback so the UI can still
// order lines that had no timestamp in the log.
function recentPages(text, limit, opts = {}) {
  const pages = parsePages(text, opts);
  let synthetic = Date.now();
  for (let i = pages.length - 1; i >= 0; i--) {
    if (pages[i].ts == null) {
      pages[i].ts = synthetic;
      pages[i].tsApprox = true;
    }
    synthetic = pages[i].ts - 1;
  }
  return pages.slice(-limit).reverse();
}

module.exports = { parsePages, recentPages };
