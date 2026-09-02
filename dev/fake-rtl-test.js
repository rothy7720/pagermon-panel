#!/usr/bin/env node
// Dev stand-in for `rtl_test` — prints the device list the way rtl_test does
// (to stderr), then exits like it would when device 0 is busy.
'use strict';
process.stderr.write(
  'Found 2 device(s):\n' +
  '  0:  Realtek, RTL2838UHIDIR, SN: 00000420\n' +
  '  1:  Realtek, RTL2838UHIDIR, SN: 00000069\n' +
  '\n' +
  'Using device 0: Generic RTL2832U OEM\n' +
  'usb_claim_interface error -6\n'
);
process.exit(1);
