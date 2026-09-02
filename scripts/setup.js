#!/usr/bin/env node
'use strict';

// One-shot config generator for a new decoder site.
//   node scripts/setup.js             # write config.json from what pm2 is running
//   node scripts/setup.js --force     # overwrite an existing config.json
//   node scripts/setup.js --print     # just show what it would write
//   node scripts/setup.js --fix-logs  # print the pm2 commands to give each
//                                     # decoder its own log file (they share one
//                                     # when the scripts are all named reader.sh)
//
// It scans `pm2 jlist` for PagerMon client processes, finds each one's reader.sh,
// reads the frequency + SDR device out of it, and writes a config.json. Review
// the labels afterwards — everything else it fills in from the box.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pm2 = require(path.join(ROOT, 'lib/pm2'));
const readersh = require(path.join(ROOT, 'lib/readersh'));

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const PRINT = args.includes('--print');
const FIX_LOGS = args.includes('--fix-logs');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');

function isPanelOrModule(p) {
  const n = (p.name || '').toLowerCase();
  return n === 'pagermon-panel' || n.startsWith('pm2-') || (p.pm2_env && p.pm2_env.axm_options && p.pm2_env.pmx_module);
}

function looksLikeClient(p) {
  const env = p.pm2_env || {};
  const script = path.basename(env.pm_exec_path || '');
  const cwd = (env.pm_cwd || '').toLowerCase();
  return /^reader\.(sh|js)$/i.test(script) || /pagermon|multimon|pocsag|\/client/.test(cwd);
}

function readerShFor(p) {
  const env = p.pm2_env || {};
  const script = env.pm_exec_path || '';
  if (/\.sh$/i.test(script) && fs.existsSync(script)) return script;
  const guess = path.join(env.pm_cwd || '', 'reader.sh');
  return fs.existsSync(guess) ? guess : '';
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'decoder';
}

(async () => {
  if (fs.existsSync(CONFIG_PATH) && !FORCE && !PRINT) {
    console.error(`\n${CONFIG_PATH} already exists. Re-run with --force to overwrite, or --print to preview.\n`);
    process.exit(1);
  }

  // start from an existing config.json if there is one (keeps port, pm2Bin,
  // rtlTestBin, test{}, …), else the example file, else bare defaults.
  const baseFile = process.env.PANEL_CONFIG
    || (fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_PATH);
  let base = {};
  try { base = JSON.parse(fs.readFileSync(baseFile, 'utf8')); } catch {}
  const pm2Bin = base.pm2Bin || 'pm2';

  let list;
  try {
    list = await pm2.jlist(pm2Bin);
  } catch (e) {
    console.error(`\nCould not run "${Array.isArray(pm2Bin) ? pm2Bin.join(' ') : pm2Bin} jlist": ${e.message}`);
    console.error('Is pm2 on PATH for this user? Set "pm2Bin" in config.example.json if not.\n');
    process.exit(1);
  }

  const candidates = list.filter((p) => !isPanelOrModule(p) && looksLikeClient(p));
  if (!candidates.length) {
    console.error('\nNo PagerMon client processes found in pm2. Nothing to do.');
    console.error('pm2 processes seen: ' + list.map((p) => p.name).join(', ') + '\n');
    process.exit(1);
  }

  const logPaths = {};
  candidates.forEach((p) => {
    const lp = (p.pm2_env || {}).pm_out_log_path;
    if (lp) logPaths[lp] = (logPaths[lp] || 0) + 1;
  });

  if (FIX_LOGS) {
    const pm2cmd = Array.isArray(pm2Bin) ? pm2Bin.join(' ') : pm2Bin;
    const need = candidates.filter((p) => {
      const lp = (p.pm2_env || {}).pm_out_log_path || '';
      return path.basename(lp) !== `${p.name}-out.log`;
    });
    if (!need.length) {
      console.log('\nEvery decoder already has its own <name>-out.log. Nothing to do.\n');
      return;
    }
    console.log('\n# Give each decoder its own pm2 log file. Brief downtime per decoder.\n');
    console.log(`${pm2cmd} delete ${need.map((p) => p.name).join(' ')}`);
    for (const p of need) {
      const env = p.pm2_env || {};
      const script = env.pm_exec_path || path.join(env.pm_cwd || '', 'reader.sh');
      console.log(
        `${pm2cmd} start ${script} --name ${p.name} --cwd ${env.pm_cwd || '.'} --time ` +
        `-o $HOME/.pm2/logs/${p.name}-out.log -e $HOME/.pm2/logs/${p.name}-err.log`
      );
    }
    console.log(`${pm2cmd} save\n`);
    console.log('Then re-run:  node scripts/setup.js --force\n');
    return;
  }

  const decoders = [];
  const notes = [];
  for (const p of candidates) {
    const env = p.pm2_env || {};
    const cfgFile = readerShFor(p);
    let freq = null;
    let dev = null;
    if (cfgFile) {
      freq = await readersh.readFrequency(cfgFile).catch(() => null);
      dev = await readersh.readDevice(cfgFile).catch(() => null);
    } else {
      notes.push(`- ${p.name}: no reader.sh found (looked in ${env.pm_cwd}); frequency/device editing won't work until you set "configFile".`);
    }

    const sharedLog = env.pm_out_log_path && logPaths[env.pm_out_log_path] > 1;
    if (sharedLog) {
      notes.push(`- ${p.name}: shares its pm2 log (${env.pm_out_log_path}) with another decoder — pages can't be told apart. Run "node scripts/setup.js --fix-logs" for the commands to split them.`);
    }

    decoders.push({
      id: slug(p.name),
      label: p.name,
      staleMinutes: 30,
      pm2Ref: p.name,
      cwd: env.pm_cwd || '',
      readerCmd: /\.js$/i.test(env.pm_exec_path || '') ? `node ${path.basename(env.pm_exec_path)}` : 'node ./reader.js',
      configFile: cfgFile,
      logFile: '',
      _detected: { frequency: freq && freq.pretty, device: dev && dev.value },
    });
  }

  const out = { ...base, decoders: decoders.map(({ _detected, ...d }) => d) };

  console.log('\nDetected decoders:\n');
  decoders.forEach((d) => {
    console.log(`  ${d.label}  (pm2: ${d.pm2Ref})`);
    console.log(`    dir:    ${d.cwd || '(unknown)'}`);
    console.log(`    config: ${d.configFile || '(none — set manually)'}`);
    console.log(`    freq:   ${d._detected.frequency || '?'}    device: #${d._detected.device != null ? d._detected.device : '?'}`);
    console.log('');
  });
  if (notes.length) console.log('Notes:\n' + notes.join('\n') + '\n');

  if (PRINT) {
    console.log('--- config.json ---\n' + JSON.stringify(out, null, 2) + '\n');
    return;
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${CONFIG_PATH}\n`);
  console.log('Next:');
  console.log('  1. Review the "label" fields (they default to the pm2 name).');
  console.log('  2. Make sure the reader.sh files are writable by this user:  sudo chown -R $USER ~/pagermon');
  console.log('  3. node server.js        # test on http://<box-ip>:8080');
  console.log('  4. pm2 start ecosystem.config.js && pm2 save');
  console.log("  5. reboot button:  echo \"$USER ALL=(root) NOPASSWD: /usr/sbin/reboot\" | sudo tee /etc/sudoers.d/pagermon-panel && sudo chmod 440 /etc/sudoers.d/pagermon-panel\n");
})();
