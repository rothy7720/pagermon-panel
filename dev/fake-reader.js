#!/usr/bin/env node
// Dev-only stand-in for a PagerMon client's reader.js: reads one frame on stdin,
// echoes what it "would send", appends it to the matching out.log, exits.
'use strict';
const fs = require('fs');
const path = require('path');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const line = input.trim();
  const ts = new Date().toISOString();
  const logFile = path.join(__dirname, 'logs', 'pagermon-eas1-out.log');
  try {
    fs.appendFileSync(logFile, `${ts} ${line}\n${ts} info: [fake-reader] would POST to pagermon server\n`);
  } catch {}
  process.stdout.write(`[fake-reader] received: ${line}\n[fake-reader] parsed + queued for server\n`);
  process.exit(0);
});
