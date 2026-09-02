# PagerMon Panel

A local web control panel for the **decoder / forwarder** end of a PagerMon
setup — the remote site that receives POCSAG and forwards it to the PagerMon
server. Zero npm dependencies. Runs on Node 12+ (Node 12 is EOL — upgrade when you
can, but the panel does not require it).

This has nothing to do with the PagerMon server. It only watches and controls the
`reader.js` client processes running here under **pm2**.

## What it does

- **One card per decoder.** A decoder is one `reader.js` process under pm2, with
  a label you set. Add as many as you have. The card shows the decoder's RX
  frequency (read from its `reader.sh`) alongside the label.
- Per decoder: pm2 state, uptime, CPU/mem, restart count, time since last page,
  and an **active / idle / stopped / problem** light.
- **Start / Stop / Restart** any decoder.
- **Change a decoder's frequency** right from its card — edits the `-f` value (or
  a `FREQ=` line) in that decoder's `reader.sh`, keeps a `.bak`, and restarts the
  process so it takes effect.
- **RTL-SDR devices** — lists every dongle `rtl_test` sees (index, model, serial)
  and which decoder is using each. Pick a decoder's dongle from its card (edits
  the `-d` value in `reader.sh` and restarts). Warns if two dongles share a
  serial, since then `-d <index>` order isn't stable across replug/reboot.
- **Reboot the PC** (configurable command, typed `REBOOT` confirmation).
- **Send a test page** — address + message box, always sent as POCSAG512 /
  Function 3, piped straight into the chosen decoder's `reader.js` on stdin
  (same as `echo "POCSAG512: …" | node ./reader.js`).
- **Last 20 pages per decoder**, parsed from its pm2 stdout log.
- **Settings page** — edit everything from the browser: each decoder's label,
  pm2 name/id, working dir, `reader.sh` path and "go orange after N minutes idle"
  threshold; add/remove decoders. Saves back to `config.json` and hot-reloads
  (except port/bind).

### No login

The panel has no authentication — it's built to sit behind your firewall + VPN
on a trusted network. Don't expose it to the internet. Set `bind` to `127.0.0.1`
if you only ever reach it from the box itself.

### About an RSSI / signal indicator

There isn't a real one to read. `rtl_fm` / `multimon-ng` don't expose a
per-transmission signal level, and sampling it needs the SDR free (it isn't while
decoding). The panel's "is this actually hearing anything" signal is the
**time-since-last-page** light — it goes orange once a decoder has been silent
longer than its configured minutes.

## Setup (on the Ubuntu box)

```bash
git clone <this> pagermon-panel && cd pagermon-panel
node scripts/setup.js       # generates config.json from what pm2 is running
node server.js              # visit http://<box-ip>:8080
```

`scripts/setup.js` scans `pm2 jlist` for PagerMon client processes, finds each
one's `reader.sh`, reads the frequency + SDR device out of it, and writes a
`config.json`. Add `--print` to preview without writing, `--force` to overwrite.
Review the `label` fields afterwards; everything else comes off the box.

If you'd rather do it by hand: `cp config.example.json config.json` and edit, or
just start the server — a stub `config.json` is written on first run and you fill
it in from the Settings tab.

Then run it under pm2 like your decoders:

```bash
pm2 start ecosystem.config.js && pm2 save
```

Run it **as the same user that owns your pm2 daemon** — then pm2 control needs no
sudo. Only **Reboot** needs root; add a sudoers drop-in:

```bash
echo 'pager ALL=(root) NOPASSWD: /usr/sbin/reboot' | sudo tee /etc/sudoers.d/pagermon-panel
sudo chmod 440 /etc/sudoers.d/pagermon-panel
```

(replace `pager` with the real user; check the path with `which reboot`).

## config.json

Most of this is editable from the Settings page — you rarely hand-edit it.

```jsonc
{
  "port": 8080,
  "bind": "0.0.0.0",                 // 127.0.0.1 = box-only
  "pm2Bin": "pm2",                   // path, or an array e.g. ["sudo","pm2"]
  "rtlTestBin": "rtl_test",          // used to enumerate RTL-SDR dongles
  "rebootCommand": "sudo /usr/sbin/reboot",
  "logTailBytes": 200000,
  "pagesPerProcess": 20,
  "logPattern": null,               // advanced: regex override for page parsing
  "test": { "baud": 512, "function": 3 },
  "decoders": [
    {
      "id": "eas1",
      "label": "EAS Channel 1",
      "staleMinutes": 30,            // light goes orange after this much silence
      "pm2Ref": "EAS1",              // pm2 process name OR numeric id
      "cwd": "/home/ben/pagermon/client",                // dir containing reader.js
      "readerCmd": "node ./reader.js",
      "configFile": "/home/ben/pagermon/client/reader.sh",  // holds the -f frequency
      "logFile": ""                 // optional: read pages from here instead of the pm2 stdout log
    }
  ]
}
```

The pm2 log path for each decoder is discovered automatically from `pm2 jlist`.
Set **`logFile`** only if that's not where the decoded pages land — e.g. two pm2
apps whose scripts share a name write to the same log, or `reader.js` is silent
and you `tee` the multimon-ng output to a file instead.

### Frequency editing

If `configFile` points at the decoder's `reader.sh`, the panel reads the current
RX frequency from it and lets you change it from the card. It looks for, in order:

1. a shell variable — `FREQ=148.5375M` (also `FREQUENCY` / `RTL_FREQ` / `RX_FREQ`)
2. an inline flag on the `rtl_fm` / `rtl_power` line — `-f 148.5375M` or `--freq=…`

A bare number under 10000 you type in the box is taken as MHz (`148.5375` →
`148.5375M`). The original file is copied to `reader.sh.bak` before the change,
and the pm2 process is restarted so it re-tunes.

### SDR device selection

Same mechanism: the card shows which dongle the decoder uses (`-d` on the
`rtl_fm` line, or `#0` if absent), and the picker rewrites it. The **RTL-SDR
devices** panel lists what `rtl_test` finds and which decoder claims each.

If two dongles report the same serial (common — they ship as `00000001`), give
them unique ones so `-d` is stable:

```bash
# with the decoders stopped:  pm2 stop EAS1 RFS_LW
rtl_eeprom -d 0 -s EAS_01
rtl_eeprom -d 1 -s RFS_01
```

then reference them as `-d EAS_01` etc. (the panel accepts a serial in the box).

## Tuning the page parser

The panel scrapes decoded frames from each decoder's stdout log with built-in
regexes (multimon-ng POCSAG + FLEX). If a decoder's page list stays empty even
though it's decoding, grab a sample:

```bash
pm2 logs pagermon-eas1 --lines 60 --nostream
```

and set `logPattern` in the Settings page (a regex with named groups `baud`,
`addr`, `func`, `kind`, `msg`), or edit `BUILTIN_PATTERNS` in `lib/parse.js`.

## API (all under `/api`, no auth)

| method | path | body | notes |
|---|---|---|---|
| GET  | `/api/state` | | full dashboard payload |
| GET  | `/api/config` | | current config |
| POST | `/api/config` | full config object | validates, writes `config.json` (+ `.bak`), hot-reloads |
| GET  | `/api/pm2/processes` | | everything pm2 knows — for the settings picker |
| POST | `/api/decoder/:id/start\|stop\|restart` | | pm2 control for one decoder |
| GET  | `/api/decoder/:id/pages?limit=20` | | parsed pages for one decoder |
| POST | `/api/decoder/:id/frequency` | `{frequency, restart?}` | edits `reader.sh`, restarts the decoder |
| POST | `/api/decoder/:id/device` | `{device, restart?}` | sets the `-d` dongle in `reader.sh`, restarts |
| GET  | `/api/rtl/devices` | | RTL-SDR dongles per `rtl_test` |
| POST | `/api/test` | `{decoderId, address, message}` | POCSAG512/F3 into that decoder's reader.js |
| POST | `/api/reboot` | `{confirm:"REBOOT"}` | runs `rebootCommand` |

## Local development

`dev/` has a fake pm2 (`fake-pm2.js`), a fake `reader.js`, sample logs and
`config.dev.json`, so you can run the whole thing on any machine:

```bash
node server.js ./dev/config.dev.json   # http://127.0.0.1:8090
```
