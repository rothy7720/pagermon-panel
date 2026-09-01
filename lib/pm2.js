'use strict';

const { execFile } = require('child_process');

// `bin` may be a string ("pm2", "/usr/local/bin/pm2") or an array whose extra
// elements are fixed leading args (["node", "/opt/pm2/bin/pm2"], ["sudo", "pm2"]).
function splitBin(bin) {
  const parts = Array.isArray(bin) ? bin.slice() : [bin];
  return { cmd: parts[0], base: parts.slice(1) };
}

function run(bin, args, opts = {}) {
  const { cmd, base } = splitBin(bin);
  return new Promise((resolve, reject) => {
    execFile(cmd, [...base, ...args], { timeout: 15000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

// pm2 sometimes prints an update-notifier banner before the JSON. Grab the JSON
// array/object out of the output defensively.
function extractJson(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('pm2 jlist did not return JSON');
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

async function jlist(pm2Bin) {
  const { stdout } = await run(pm2Bin, ['jlist']);
  return extractJson(stdout);
}

// Slim list of everything pm2 knows about — for the settings-page picker.
async function listAll(pm2Bin) {
  const list = await jlist(pm2Bin);
  return list.map((p) => ({
    name: p.name,
    pmId: p.pm_id,
    status: (p.pm2_env || {}).status || 'unknown',
  }));
}

// Match a config "pm2Ref" (name OR numeric id) against a jlist entry.
function matches(p, ref) {
  if (ref == null || ref === '') return false;
  return p.name === ref || String(p.pm_id) === String(ref);
}

function procSummary(p) {
  if (!p) return null;
  const env = p.pm2_env || {};
  const monit = p.monit || {};
  return {
    name: p.name,
    pmId: p.pm_id,
    pid: p.pid || null,
    status: env.status || 'unknown',        // online | stopping | stopped | launching | errored | one-launch-status
    restarts: env.restart_time || 0,
    unstableRestarts: env.unstable_restarts || 0,
    uptimeMs: env.pm_uptime && env.status === 'online' ? Date.now() - env.pm_uptime : 0,
    cpu: monit.cpu != null ? monit.cpu : null,
    memoryBytes: monit.memory != null ? monit.memory : null,
    outLogPath: env.pm_out_log_path || null,
    errLogPath: env.pm_err_log_path || null,
  };
}

// refs: array of pm2Ref strings (name or id). Returns { ref -> summary }.
async function statusFor(pm2Bin, refs) {
  const list = await jlist(pm2Bin);
  const result = {};
  for (const ref of refs) {
    const hit = list.find((p) => matches(p, ref));
    result[ref] = procSummary(hit) || {
      name: ref, pmId: null, status: 'missing', pid: null, restarts: 0, uptimeMs: 0,
      cpu: null, memoryBytes: null, outLogPath: null, errLogPath: null,
    };
  }
  return result;
}

async function control(pm2Bin, action, ref) {
  if (!['start', 'stop', 'restart'].includes(action)) {
    throw new Error(`unsupported pm2 action: ${action}`);
  }
  const { stdout, stderr } = await run(pm2Bin, [action, String(ref)]);
  return { stdout, stderr };
}

module.exports = { jlist, listAll, statusFor, control, run };
