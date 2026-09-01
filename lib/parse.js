'use strict';

// Pull decoded POCSAG/FLEX pages out of raw client log text.
//
// The pm2 log for a PagerMon client contains a mix of:
//   - multimon-ng lines:  "POCSAG512: Address: 1213680  Function: 0  Alpha:   MESSAGE"
//   - reader.js chatter:  timestamps, "sending", HTTP responses, etc.
//
// We only care about the decoded frames. Parsing is deliberately lenient so it
// keeps working across client/multimon versions. If your logs look different,
// set "logPattern" in config.json (named groups: baud, addr, func, kind, msg).

const BUILTIN_PATTERNS = [
  // multimon-ng POCSAG (most common)
  /POCSAG(?<baud>\d{3,4})[:\-]?\s*Address:\s*(?<addr>\d+)\s*Function:\s*(?<func>\d)\s*(?<kind>Alpha|Numeric|Skyper)?:?\s?(?<msg>.*)$/i,
  // multimon-ng FLEX
  /FLEX[:\s].*?\[(?<addr>\d+)\]\s*(?<baud>\d+)?\/?\d*\/?\w*\s+(?<func>\d)?\s*(?<kind>ALN|NUM|ALPHANUM)?\s*(?<msg>.*)$/i,
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

    out.push({
      ts: Number.isFinite(ts) ? ts : null,
      address: g.addr,
      function: g.func != null ? Number(g.func) : null,
      mode: (g.baud ? `POCSAG${g.baud}` : 'FLEX'),
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
