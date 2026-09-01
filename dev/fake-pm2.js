#!/usr/bin/env node
// Dev-only stand-in for `pm2` so the panel can be exercised on a machine
// without pm2 / reader.js. Not used in production.
'use strict';
const path = require('path');
const fs = require('fs');

const stateFile = path.join(__dirname, 'fake-pm2-state.json');
const logDir = path.join(__dirname, 'logs');
fs.mkdirSync(logDir, { recursive: true });

const defaults = {
  'pagermon-eas1': { status: 'online' },
  'pagermon-eas2': { status: 'stopped' },
};
let state;
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = defaults; }
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

const [cmd, name] = process.argv.slice(2);

if (cmd === 'jlist') {
  const now = Date.now();
  const list = Object.entries(state).map(([n, s], i) => ({
    name: n,
    pm_id: i,
    pid: s.status === 'online' ? 1000 + i : 0,
    monit: { cpu: s.status === 'online' ? 3 + i : 0, memory: s.status === 'online' ? 48e6 + i * 1e6 : 0 },
    pm2_env: {
      status: s.status,
      restart_time: 2,
      unstable_restarts: 0,
      pm_uptime: now - 3600_000 * (i + 1),
      pm_out_log_path: path.join(logDir, `${n}-out.log`),
      pm_err_log_path: path.join(logDir, `${n}-err.log`),
    },
  }));
  process.stdout.write(JSON.stringify(list));
  process.exit(0);
}

if (['start', 'stop', 'restart'].includes(cmd) && name) {
  if (!state[name]) { console.error(`no such process: ${name}`); process.exit(1); }
  state[name].status = cmd === 'stop' ? 'stopped' : 'online';
  save();
  console.log(`[fake-pm2] ${cmd} ${name} -> ${state[name].status}`);
  process.exit(0);
}

console.error(`[fake-pm2] unhandled: ${process.argv.slice(2).join(' ')}`);
process.exit(1);
