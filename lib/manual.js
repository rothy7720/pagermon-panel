'use strict';

const { spawn } = require('child_process');

// Build the multimon-ng-style line that reader.js expects on stdin. Test pages
// are always POCSAG512 / Function 3 (alpha) unless config.test overrides.
//   POCSAG512: Address: 1213680  Function: 3  Alpha: <message><EOT>
function buildFrame({ address, message, baud = 512, func = 3 }) {
  const addr = String(address || '').trim();
  if (!/^\d+$/.test(addr)) throw new Error('address must be numeric');
  const rate = String(baud).replace(/[^\d]/g, '') || '512';
  const fn = String(func).replace(/[^\d]/g, '') || '3';
  let msg = String(message == null ? '' : message);
  if (!/<EOT>\s*$/i.test(msg)) msg += '<EOT>';
  return `POCSAG${rate}: Address: ${addr}  Function: ${fn}  Alpha: ${msg}`;
}

// Feed one frame to a decoder's reader.js. Mirrors:
//   echo "POCSAG512: ..." | node ./reader.js
// but pipes via stdin so there is no shell-quoting to get wrong.
function sendToReader(decoder, frameLine) {
  return new Promise((resolve, reject) => {
    const cmd = decoder.readerCmd || 'node ./reader.js';
    const parts = cmd.split(/\s+/);
    const bin = parts[0];
    const args = parts.slice(1);

    const child = spawn(bin, args, {
      cwd: decoder.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 20000,
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout: out.trim(), stderr: err.trim(), sent: frameLine });
    });

    child.stdin.write(frameLine + '\n');
    child.stdin.end();
  });
}

module.exports = { buildFrame, sendToReader };
