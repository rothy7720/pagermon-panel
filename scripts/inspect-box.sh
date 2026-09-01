#!/usr/bin/env bash
# Run this on the Ubuntu box and paste the whole output back.
# It gathers what the panel needs: node version, pm2 process names + paths,
# where each reader.js / reader.sh lives, and a sample of decoded log lines
# (so the page parser can be tuned). Read-only — it changes nothing.

set -u
line() { printf '\n===== %s =====\n' "$1"; }

line "node / npm"
node --version 2>&1
which node 2>&1
npm --version 2>&1

line "pm2 version + user"
whoami
pm2 --version 2>&1

line "pm2 list"
pm2 list 2>&1

line "pm2 processes (name / cwd / script / args)"
pm2 jlist 2>/dev/null | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  let list; try { list = JSON.parse(d.slice(d.indexOf("["), d.lastIndexOf("]")+1)); } catch(e){ console.log("could not parse pm2 jlist"); return; }
  for (const p of list) {
    const e = p.pm2_env || {};
    console.log("- name:      " + p.name + "   (pm_id " + p.pm_id + ", " + e.status + ")");
    console.log("  cwd:       " + (e.pm_cwd || ""));
    console.log("  script:    " + (e.pm_exec_path || ""));
    console.log("  interp:    " + (e.exec_interpreter || ""));
    console.log("  args:      " + JSON.stringify(e.args || []));
    console.log("  out_log:   " + (e.pm_out_log_path || ""));
    console.log("");
  }
});'

line "look for reader.js / reader.sh under each pm2 cwd"
for cwd in $(pm2 jlist 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{JSON.parse(d.slice(d.indexOf("["),d.lastIndexOf("]")+1)).forEach(p=>{const c=(p.pm2_env||{}).pm_cwd; if(c)console.log(c)})}catch(e){}})' | sort -u); do
  echo "-- $cwd"
  ls -la "$cwd" 2>&1 | grep -Ei 'reader\.(js|sh)|\.sh$|config' || echo "   (no reader.* / *.sh / config here)"
done

line "any *.sh containing rtl_fm on the box (frequency scripts)"
grep -rlsI --include='*.sh' -e 'rtl_fm' -e 'rtl_power' /home /opt /etc 2>/dev/null | head -20

line "frequency line from each of those"
for f in $(grep -rlsI --include='*.sh' -e 'rtl_fm' -e 'rtl_power' /home /opt /etc 2>/dev/null | head -20); do
  echo "-- $f"
  grep -nE 'rtl_fm|rtl_power|FREQ|FREQUENCY|-f ' "$f" 2>/dev/null | head -6
done

line "sample decoded lines from each pm2 log (last 60 lines, page-like only)"
for name in $(pm2 jlist 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{JSON.parse(d.slice(d.indexOf("["),d.lastIndexOf("]")+1)).forEach(p=>console.log(p.name))}catch(e){}})'); do
  echo "-- $name"
  pm2 logs "$name" --lines 60 --nostream 2>/dev/null | grep -Ei 'POCSAG|FLEX|Address:|Alpha:|Numeric:' | tail -12 || echo "   (no page-like lines in recent log)"
  echo ""
done

line "RTL-SDR dongles"
lsusb 2>/dev/null | grep -Ei 'rtl|realtek|dvb' || echo "lsusb found nothing / not installed"

line "done"
echo "Paste everything above back to continue."
