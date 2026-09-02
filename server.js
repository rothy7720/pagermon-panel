'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const cfg = require('./lib/config');
const pm2 = require('./lib/pm2');
const { tailBytes } = require('./lib/logtail');
const { recentPages, stripAnsi } = require('./lib/parse');
const { buildFrame, sendToReader } = require('./lib/manual');
const readersh = require('./lib/readersh');
const rtl = require('./lib/rtl');
const system = require('./lib/system');

// ---------------------------------------------------------------- config -----
const CONFIG_PATH = process.argv[2] || process.env.PANEL_CONFIG || path.join(__dirname, 'config.json');
try {
  cfg.load(CONFIG_PATH);
} catch (e) {
  console.error(`\nCannot read config at ${CONFIG_PATH}\n${e.message}\n`);
  process.exit(1);
}

// No auth: the panel is expected to sit behind a firewall + VPN on a trusted LAN.

// --------------------------------------------------------------- helpers -----
function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (d) => {
      buf += d;
      if (buf.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const STATIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(STATIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(STATIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// -------------------------------------------------------------- decoders -----
function findDecoder(id) {
  return cfg.get().decoders.find((d) => d.id === id) || null;
}

function healthOf(procStatus, lastPageAt, staleMinutes) {
  if (procStatus === 'online') {
    if (lastPageAt == null) return 'idle';
    return Date.now() - lastPageAt > staleMinutes * 60000 ? 'idle' : 'active';
  }
  if (procStatus === 'stopped') return 'off';
  if (procStatus === 'launching' || procStatus === 'unknown') return 'unknown';
  return 'error'; // errored | missing
}

// ------------------------------------------------------------ dashboard ------
async function buildState() {
  const c = cfg.get();
  const refs = [...new Set(c.decoders.map((d) => d.pm2Ref).filter(Boolean))];

  let pm2Status = {};
  let pm2Error = null;
  try {
    pm2Status = await pm2.statusFor(c.pm2Bin, refs);
  } catch (e) {
    pm2Error = e.message || String(e);
  }

  const decoders = [];
  for (const d of c.decoders) {
    const st = pm2Status[d.pm2Ref] || { status: d.pm2Ref ? 'unknown' : 'unconfigured' };
    const logPath = d.logFile || st.outLogPath;
    let pages = [];
    let pagesError = null;
    let logInfo = null;
    try {
      const text = await tailBytes(logPath, c.logTailBytes);
      pages = recentPages(text, c.pagesPerProcess, { logPattern: c.logPattern });
      if (!pages.length) {
        // help debug an empty feed: does the file exist, and what's in it?
        let stat = null;
        try { stat = fs.statSync(logPath); } catch (e) { logInfo = { path: logPath, error: e.code || e.message }; }
        if (stat) {
          const lines = text.split(/\r?\n/).map(stripAnsi).filter((l) => l.trim());
          logInfo = { path: logPath, bytes: stat.size, mtime: stat.mtimeMs, lastLines: lines.slice(-4) };
        }
      }
    } catch (e) {
      pagesError = e.message || String(e);
    }
    const lastPageAt = pages.length ? pages[0].ts : null;

    let frequency = null;
    let device = null;
    if (d.configFile) {
      try { frequency = await readersh.readFrequency(d.configFile); }
      catch (e) { frequency = { error: e.message }; }
      try { device = await readersh.readDevice(d.configFile); }
      catch (e) { device = { error: e.message }; }
    }

    decoders.push({
      id: d.id,
      label: d.label,
      staleMinutes: d.staleMinutes,
      pm2Ref: d.pm2Ref,
      cwd: d.cwd,
      configFile: d.configFile || null,
      logFile: d.logFile || null,
      logPath, // what pages were actually read from
      logInfo, // set only when no pages were found — for debugging an empty feed
      frequency, // { token, pretty, method } | { error } | null
      device, // { value, explicit } | { error } | null  (rtl_fm -d)
      process: st,
      health: d.pm2Ref ? healthOf(st.status, lastPageAt, d.staleMinutes) : 'unconfigured',
      lastPageAt,
      pages,
      pagesError,
    });
  }

  // RTL-SDR devices, annotated with which decoder claims each one
  const rtlList = await rtl.listDevices(c.rtlTestBin, 4000);
  for (const dev of rtlList.devices || []) {
    const users = decoders.filter((d) => d.device && !d.device.error &&
      (d.device.value === String(dev.index) || (dev.serial && d.device.value === dev.serial)));
    dev.usedBy = users.map((d) => d.label);
  }
  if (rtlList.devices && rtlList.devices.length) {
    const serials = rtlList.devices.map((d) => d.serial).filter(Boolean);
    rtlList.duplicateSerials = serials.length !== new Set(serials).size;
  }

  return {
    now: Date.now(),
    host: system.hostInfo(),
    rtl: rtlList,
    sdr: (rtlList.devices || []).length ? undefined : await system.sdrDongles(), // lsusb fallback
    pm2Error,
    decoders,
  };
}

// ----------------------------------------------------------------- router ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method;

  try {
    if (!p.startsWith('/api/')) return serveStatic(res, p);

    // --- read ---
    if (p === '/api/state' && method === 'GET') {
      return send(res, 200, await buildState());
    }

    if (p === '/api/config' && method === 'GET') {
      return send(res, 200, { config: cfg.get(), path: cfg.path() });
    }

    if (p === '/api/pm2/processes' && method === 'GET') {
      try {
        return send(res, 200, { processes: await pm2.listAll(cfg.get().pm2Bin) });
      } catch (e) {
        return send(res, 200, { processes: [], error: e.message });
      }
    }

    // --- write config (settings page) ---
    if (p === '/api/config' && method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return send(res, 400, { error: 'expected a config object' });
      const before = cfg.get();
      const saved = cfg.save(body);
      const restartNeeded = saved.port !== before.port || saved.bind !== before.bind;
      return send(res, 200, { ok: true, config: saved, restartNeeded });
    }

    // --- per-decoder pm2 control ---
    const m = p.match(/^\/api\/decoder\/([^/]+)\/(start|stop|restart|pages)$/);
    if (m) {
      const d = findDecoder(m[1]);
      if (!d) return send(res, 404, { error: 'unknown decoder' });
      if (!d.pm2Ref) return send(res, 400, { error: 'decoder has no pm2 name/id set' });
      const action = m[2];
      const c = cfg.get();

      if (action === 'pages' && method === 'GET') {
        const st = (await pm2.statusFor(c.pm2Bin, [d.pm2Ref]))[d.pm2Ref];
        const text = await tailBytes(d.logFile || st.outLogPath, c.logTailBytes);
        const limit = Math.min(Number(url.searchParams.get('limit')) || c.pagesPerProcess, 200);
        return send(res, 200, { pages: recentPages(text, limit, { logPattern: c.logPattern }) });
      }
      if (method === 'POST') {
        const r = await pm2.control(c.pm2Bin, action, d.pm2Ref);
        return send(res, 200, { ok: true, action, stdout: r.stdout, stderr: r.stderr });
      }
    }

    // --- change a decoder's RX frequency (edits its reader.sh, optional restart) ---
    const fm = p.match(/^\/api\/decoder\/([^/]+)\/frequency$/);
    if (fm && method === 'POST') {
      const d = findDecoder(fm[1]);
      if (!d) return send(res, 404, { error: 'unknown decoder' });
      if (!d.configFile) return send(res, 400, { error: 'no config file set for this decoder (Settings)' });
      const body = await readBody(req);
      let result;
      try {
        result = await readersh.writeFrequency(d.configFile, body.frequency);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      let restarted = false;
      if (body.restart !== false && d.pm2Ref && !result.unchanged) {
        try { await pm2.control(cfg.get().pm2Bin, 'restart', d.pm2Ref); restarted = true; }
        catch (e) { return send(res, 200, { ok: true, ...result, restarted: false, restartError: e.message }); }
      }
      return send(res, 200, { ok: true, ...result, restarted });
    }

    // --- change which RTL-SDR a decoder uses (edits "-d" in its reader.sh) ---
    const dm = p.match(/^\/api\/decoder\/([^/]+)\/device$/);
    if (dm && method === 'POST') {
      const d = findDecoder(dm[1]);
      if (!d) return send(res, 404, { error: 'unknown decoder' });
      if (!d.configFile) return send(res, 400, { error: 'no config file set for this decoder (Settings)' });
      const body = await readBody(req);
      let result;
      try {
        result = await readersh.writeDevice(d.configFile, body.device);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      let restarted = false;
      if (body.restart !== false && d.pm2Ref && !result.unchanged) {
        try { await pm2.control(cfg.get().pm2Bin, 'restart', d.pm2Ref); restarted = true; }
        catch (e) { return send(res, 200, { ok: true, ...result, restarted: false, restartError: e.message }); }
      }
      return send(res, 200, { ok: true, ...result, restarted });
    }

    // --- list RTL-SDR devices (force a fresh probe) ---
    if (p === '/api/rtl/devices' && method === 'GET') {
      return send(res, 200, await rtl.listDevices(cfg.get().rtlTestBin, 4000, { fresh: true }));
    }

    // --- test message: address + message, always POCSAG512 / F3 ---
    if (p === '/api/test' && method === 'POST') {
      const body = await readBody(req);
      const d = findDecoder(body.decoderId);
      if (!d) return send(res, 400, { error: 'pick a decoder to send from' });
      if (!d.cwd) return send(res, 400, { error: 'that decoder has no working directory set in Settings' });
      const c = cfg.get();
      let frame;
      try {
        frame = buildFrame({
          address: body.address,
          message: body.message,
          baud: c.test.baud,
          func: c.test.function,
        });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      const result = await sendToReader(d, frame);
      return send(res, 200, { ok: result.code === 0, ...result });
    }

    if (p === '/api/reboot' && method === 'POST') {
      const body = await readBody(req);
      if (body.confirm !== 'REBOOT') return send(res, 400, { error: 'type REBOOT to confirm' });
      const r = await system.reboot(cfg.get().rebootCommand);
      return send(res, 200, { ok: true, ...r });
    }

    return send(res, 404, { error: 'no such endpoint' });
  } catch (e) {
    console.error(`[${method} ${p}]`, e);
    return send(res, 500, { error: e.message || 'internal error', stderr: e.stderr || undefined });
  }
});

const c0 = cfg.get();
server.listen(c0.port, c0.bind, () => {
  console.log(`pagermon-panel listening on http://${c0.bind}:${c0.port}`);
  console.log(`config: ${cfg.path()}`);
  console.log(`${c0.decoders.length} decoder(s): ${c0.decoders.map((d) => d.label).join(', ') || 'none configured'}`);
});
