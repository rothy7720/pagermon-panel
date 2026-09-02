'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- format ----
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400); sec -= d * 86400;
  const h = Math.floor(sec / 3600); sec -= h * 3600;
  const m = Math.floor(sec / 60); sec -= m * 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}
const ago = (ts) => (ts ? fmtDur((Date.now() - ts) / 1000) + ' ago' : 'never');
function fmtBytes(b) {
  if (b == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const HEALTH_LABEL = { active: 'Active', idle: 'Idle', off: 'Stopped', error: 'Problem', unknown: 'Unknown', unconfigured: 'Not set up' };
const HEALTH_RANK = { error: 4, idle: 3, unknown: 2, unconfigured: 2, off: 1, active: 0 };

// ---------------------------------------------------------------- views -----
let pollTimer = null;
let currentView = 'dashboard';
let cardEditOpen = false; // pause a card's re-render while one of its inline editors is open
let rtlDevices = [];      // last-seen RTL-SDR device list, for the per-card picker

function switchView(name) {
  currentView = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $('#view-dashboard').classList.toggle('hidden', name !== 'dashboard');
  $('#view-settings').classList.toggle('hidden', name !== 'settings');
  if (name === 'settings') { stopPolling(); openSettings(); }
  else startPolling();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

// ============================================================ DASHBOARD =====
function freqRow(dec) {
  const row = el('div', 'freqrow');
  const f = dec.frequency;

  if (!dec.configFile) { row.append(el('span', 'fmuted', 'frequency — set a config file in Settings')); return row; }
  if (f && f.error) { row.append(el('span', 'fmuted', 'frequency — ' + f.error)); return row; }

  const label = el('span', 'fval');
  label.append(el('b', null, f ? f.pretty : '?'));
  if (f && f.method) label.append(el('span', 'fmeth', ` (${f.method})`));
  row.append(label);

  const edit = el('button', 'btn sm ghost', 'Change');
  row.append(edit);

  const form = el('span', 'feditor hidden');
  const input = el('input');
  input.value = f ? f.token : '';
  input.size = 12;
  const apply = el('button', 'btn sm primary', 'Set + restart');
  const cancel = el('button', 'btn sm ghost', 'Cancel');
  form.append(input, apply, cancel);
  row.append(form);

  edit.onclick = () => { edit.classList.add('hidden'); form.classList.remove('hidden'); input.focus(); cardEditOpen = true; };
  cancel.onclick = () => { form.classList.add('hidden'); edit.classList.remove('hidden'); cardEditOpen = false; };
  apply.onclick = async () => {
    apply.disabled = true; apply.textContent = '…';
    try {
      const r = await api(`/api/decoder/${dec.id}/frequency`, { method: 'POST', body: { frequency: input.value, restart: true } });
      cardEditOpen = false;
      await poll();
      if (r.restartError) alert('Frequency written but restart failed: ' + r.restartError);
    } catch (e) {
      alert('frequency change failed: ' + e.message);
      apply.disabled = false; apply.textContent = 'Set + restart';
    }
  };
  return row;
}

function deviceRow(dec) {
  const row = el('div', 'freqrow');
  const dv = dec.device;

  if (!dec.configFile) { row.append(el('span', 'fmuted', 'SDR device — set a config file in Settings')); return row; }
  if (dv && dv.error) { row.append(el('span', 'fmuted', 'SDR device — ' + dv.error)); return row; }

  const cur = dv ? String(dv.value) : '0';
  const meta = rtlDevices.find((x) => String(x.index) === cur || x.serial === cur);
  const label = el('span', 'fval');
  label.append(el('b', null, 'SDR #' + cur));
  const note = [];
  if (dv && !dv.explicit) note.push('default');
  if (meta && (meta.product || meta.vendor)) note.push(meta.product || meta.vendor);
  if (meta && meta.serial) note.push('SN ' + meta.serial);
  if (note.length) label.append(el('span', 'fmeth', ` (${note.join(', ')})`));
  row.append(label);

  const edit = el('button', 'btn sm ghost', 'Change');
  row.append(edit);

  const form = el('span', 'feditor hidden');
  let inputEl;
  if (rtlDevices.length) {
    inputEl = el('select');
    rtlDevices.forEach((x) => {
      const o = el('option', null, `#${x.index}  ${(x.product || x.vendor || '').trim()}${x.serial ? '  SN ' + x.serial : ''}`);
      o.value = String(x.index);
      inputEl.append(o);
    });
    if (![...inputEl.options].some((o) => o.value === cur)) {
      const o = el('option', null, cur + '  (current)'); o.value = cur; inputEl.append(o);
    }
    inputEl.value = cur;
  } else {
    inputEl = el('input'); inputEl.value = cur; inputEl.size = 6;
  }
  const apply = el('button', 'btn sm primary', 'Set + restart');
  const cancel = el('button', 'btn sm ghost', 'Cancel');
  form.append(inputEl, apply, cancel);
  row.append(form);

  edit.onclick = () => { edit.classList.add('hidden'); form.classList.remove('hidden'); inputEl.focus(); cardEditOpen = true; };
  cancel.onclick = () => { form.classList.add('hidden'); edit.classList.remove('hidden'); cardEditOpen = false; };
  apply.onclick = async () => {
    apply.disabled = true; apply.textContent = '…';
    try {
      const r = await api(`/api/decoder/${dec.id}/device`, { method: 'POST', body: { device: inputEl.value, restart: true } });
      cardEditOpen = false;
      await poll();
      if (r.restartError) alert('Device written but restart failed: ' + r.restartError);
    } catch (e) {
      alert('device change failed: ' + e.message);
      apply.disabled = false; apply.textContent = 'Set + restart';
    }
  };
  return row;
}

function renderRtl(rtlState, state) {
  const box = $('#rtlList');
  box.innerHTML = '';
  if (!rtlState) { box.textContent = 'looking…'; return; }
  if (!rtlState.available) {
    box.textContent = rtlState.error || 'rtl_test not available on this host';
    return;
  }
  if (!rtlState.devices.length) { box.textContent = 'no RTL-SDR devices found'; return; }

  if (rtlState.duplicateSerials) {
    box.append(el('div', 'rtlwarn', '⚠ Two or more dongles share a serial number — device order can shift on reboot/replug. Set unique serials with rtl_eeprom so "-d <serial>" is stable.'));
  }

  const tbl = el('div', 'rtltbl');
  rtlState.devices.forEach((d) => {
    const rowEl = el('div', 'rtlrow');
    rowEl.append(el('span', 'rtlidx', '#' + d.index));
    rowEl.append(el('span', 'rtlname', [d.vendor, d.product].filter(Boolean).join(' ') || 'RTL-SDR'));
    rowEl.append(el('span', 'rtlsn', d.serial ? 'SN ' + d.serial : ''));
    const used = (d.usedBy || []);
    rowEl.append(el('span', 'rtluse' + (used.length ? '' : ' free'), used.length ? '→ ' + used.join(', ') : 'unassigned'));
    tbl.append(rowEl);
  });
  box.append(tbl);
}

function decoderCard(dec) {
  const card = el('div', 'proc card-standalone');
  card.dataset.id = dec.id;

  const head = el('div', 'phead');
  head.append(el('span', `dot ${dec.health}`));
  const meta = el('div', 'meta');
  meta.append(el('h3', null, dec.label));
  const sub = [];
  if (dec.frequency && dec.frequency.pretty) sub.push(dec.frequency.pretty);
  sub.push(dec.pm2Ref ? `pm2: ${dec.pm2Ref}` : 'no pm2 name set');
  meta.append(el('div', 'ref', sub.join(' · ')));
  meta.append(el('div', 'st', `${HEALTH_LABEL[dec.health] || dec.health} · ${dec.process.status}`));
  head.append(meta);
  card.append(head);

  card.append(freqRow(dec));
  card.append(deviceRow(dec));

  const pr = dec.process;
  const stats = el('div', 'pstats');
  stats.innerHTML =
    `<span>uptime <b>${pr.status === 'online' ? fmtDur((pr.uptimeMs || 0) / 1000) : '–'}</b></span>` +
    `<span>cpu <b>${pr.cpu != null ? pr.cpu + '%' : '–'}</b></span>` +
    `<span>mem <b>${fmtBytes(pr.memoryBytes)}</b></span>` +
    `<span>restarts <b>${pr.restarts ?? 0}</b></span>` +
    `<span>last page <b>${ago(dec.lastPageAt)}</b></span>`;
  card.append(stats);

  const ctl = el('div', 'pctl');
  const on = pr.status === 'online';
  const mk = (label, action, disabled) => {
    const b = el('button', 'btn sm' + (action === 'start' ? ' primary' : ''), label);
    b.disabled = disabled || !dec.pm2Ref;
    b.onclick = () => decoderAction(dec.id, action, b);
    return b;
  };
  ctl.append(mk('Start', 'start', on), mk('Stop', 'stop', !on), mk('Restart', 'restart', false));
  card.append(ctl);

  const feed = el('div', 'feed');
  if (dec.pagesError) feed.append(el('div', 'empty', 'log error: ' + dec.pagesError));
  else if (!dec.pages.length) {
    const e = el('div', 'empty');
    const li = dec.logInfo;
    if (!li) e.textContent = 'no pages in recent log';
    else if (li.error) e.textContent = `log not found: ${li.path} (${li.error})`;
    else {
      e.append(el('div', null, `no pages matched in ${li.path} (${fmtBytes(li.bytes)})`));
      (li.lastLines || []).forEach((l) => e.append(el('div', 'logline', l)));
    }
    feed.append(e);
  }
  else for (const pg of dec.pages) {
    const row = el('div', 'row');
    const rh = el('div', 'rhead');
    rh.append(el('span', pg.tsApprox ? 'approx' : null, (pg.tsApprox ? '~' : '') + fmtTime(pg.ts)));
    const bits = [pg.mode, pg.address];
    if (pg.function != null) bits.push('F' + pg.function);
    rh.append(el('span', null, bits.join(' · ')));
    row.append(rh);
    row.append(el('div', 'rmsg', pg.message || '(empty)'));
    feed.append(row);
  }
  card.append(feed);
  return card;
}

function renderDashboard(state) {
  const h = state.host;
  const host = $('#host');
  host.textContent = `${h.hostname} · up ${fmtDur(h.uptimeSec)} · load ${h.loadavg[0]}`;
  if (h.cpuTempC != null) {
    host.append(' · ');
    host.append(el('span', 'temp' + (h.cpuTempC >= 85 ? ' hot' : h.cpuTempC >= 75 ? ' warm' : ''),
      `${h.cpuTempC}°C`));
  }
  if (state.sdr && state.sdr.length) host.append(` · ${state.sdr.length} SDR`);

  const warn = $('#pm2Warn');
  warn.classList.toggle('hidden', !state.pm2Error);
  if (state.pm2Error) warn.textContent = 'pm2 error: ' + state.pm2Error;

  const worst = state.decoders.reduce(
    (w, d) => ((HEALTH_RANK[d.health] ?? 2) > (HEALTH_RANK[w] ?? 2) ? d.health : w),
    state.decoders.length ? 'active' : 'unconfigured'
  );
  $('#overall').querySelector('.dot').className = 'dot ' + worst;
  $('#overallText').textContent = state.decoders.length ? (HEALTH_LABEL[worst] || worst) : 'no decoders';

  renderRtl(state.rtl, state);
  rtlDevices = (state.rtl && state.rtl.devices) || [];

  const box = $('#decoders');
  if (!state.decoders.length) {
    box.innerHTML = '';
    box.append(el('div', 'panel muted', 'No decoders yet. Open Settings to add one.'));
  } else {
    const wanted = state.decoders.map((d) => d.id);
    $$('.proc', box).forEach((c) => { if (!wanted.includes(c.dataset.id)) c.remove(); });

    const rtlSig = JSON.stringify(rtlDevices.map((x) => [x.index, x.serial]));
    state.decoders.forEach((d, i) => {
      // rebuild a card only when its structure / status / pages / freq / device change;
      // live numbers refresh in place; a card being edited is left alone
      const sig = JSON.stringify([
        d.label, d.health, d.pm2Ref, d.process.status, d.frequency, d.device, d.configFile, rtlSig,
        d.pagesError, d.pages.map((x) => x.ts + '|' + x.message),
      ]);
      let card = $(`.proc[data-id="${d.id}"]`, box);
      const editingHere = cardEditOpen && card && $('.feditor:not(.hidden)', card);

      if (!card || (card.dataset.sig !== sig && !editingHere)) {
        const fresh = decoderCard(d);
        fresh.dataset.sig = sig;
        if (card) {
          const f = $('.feed', card), scroll = f ? f.scrollTop : 0;
          card.replaceWith(fresh);
          const nf = $('.feed', fresh); if (nf) nf.scrollTop = scroll;
          card = fresh;
        } else {
          const after = $$('.proc', box)[i];
          after ? box.insertBefore(fresh, after) : box.append(fresh);
          card = fresh;
        }
      }

      const pr = d.process;
      const bs = $$('.pstats b', card);
      if (bs.length === 5) {
        bs[0].textContent = pr.status === 'online' ? fmtDur((pr.uptimeMs || 0) / 1000) : '–';
        bs[1].textContent = pr.cpu != null ? pr.cpu + '%' : '–';
        bs[2].textContent = fmtBytes(pr.memoryBytes);
        bs[3].textContent = pr.restarts ?? 0;
        bs[4].textContent = ago(d.lastPageAt);
      }
    });
  }

  // test dropdown
  const sel = $('#tDecoder');
  const opts = state.decoders.map((d) => ({ id: d.id, label: d.label, cwd: d.cwd }));
  const sig = opts.map((o) => o.id + o.label).join('|');
  if (sel.dataset.sig !== sig) {
    const keep = sel.value;
    sel.innerHTML = '';
    opts.forEach((o) => {
      const opt = el('option', null, o.label + (o.cwd ? '' : ' (no working dir set)'));
      opt.value = o.id;
      sel.append(opt);
    });
    if (opts.some((o) => o.id === keep)) sel.value = keep;
    sel.dataset.sig = sig;
  }

  $('#foot').textContent = 'updated ' + new Date().toLocaleTimeString() + ' · polling every 2s';
}

async function decoderAction(id, action, btn) {
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try { await api(`/api/decoder/${id}/${action}`, { method: 'POST' }); await poll(); }
  catch (e) { alert(`${action} failed: ${e.message}`); }
  finally { btn.textContent = orig; }
}

// test form
$('#testForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('#testResult');
  out.className = 'result';
  out.textContent = 'sending…';
  try {
    const r = await api('/api/test', {
      method: 'POST',
      body: { decoderId: $('#tDecoder').value, address: $('#tAddress').value.trim(), message: $('#tMessage').value },
    });
    out.classList.add(r.ok ? 'ok' : 'bad');
    out.textContent =
      `sent:\n${r.sent}\n\nexit ${r.code}` +
      (r.stdout ? `\n\n── stdout ──\n${r.stdout}` : '') +
      (r.stderr ? `\n\n── stderr ──\n${r.stderr}` : '');
    poll();
  } catch (err) {
    out.classList.add('bad');
    out.textContent = 'error: ' + err.message;
  }
});

$('#rtlRescan').addEventListener('click', async (e) => {
  const btn = e.target; btn.disabled = true; btn.textContent = '…';
  try {
    await api('/api/rtl/devices'); // forces a fresh probe + refreshes the server cache
    await poll();                  // re-render with usedBy annotations
  } catch (err) { $('#rtlList').textContent = 'rescan failed: ' + err.message; }
  finally { btn.disabled = false; btn.textContent = 'Rescan'; }
});

// reboot
$('#rebootBtn').addEventListener('click', async () => {
  if (!confirm('Reboot the whole PC now? Every decoder drops until it comes back.')) return;
  if (prompt('Type REBOOT to confirm:') !== 'REBOOT') return;
  try {
    await api('/api/reboot', { method: 'POST', body: { confirm: 'REBOOT' } });
    $('#overallText').textContent = 'reboot issued…';
    $('#overall').querySelector('.dot').className = 'dot error';
  } catch (e) { alert('reboot failed: ' + e.message); }
});

// polling
async function poll() {
  try {
    renderDashboard(await api('/api/state'));
  } catch (e) {
    $('#overallText').textContent = 'connection lost';
    $('#overall').querySelector('.dot').className = 'dot error';
  }
}
function startPolling() {
  if (currentView !== 'dashboard') return;
  poll();
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 2000);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

// ============================================================= SETTINGS =====
let draft = null;

async function openSettings() {
  $('#saveMsg').textContent = 'loading…';
  try {
    const { config } = await api('/api/config');
    draft = config;
    $('#sBind').value = config.bind ?? '';
    $('#sPort').value = config.port ?? '';
    $('#sPm2Bin').value = Array.isArray(config.pm2Bin) ? JSON.stringify(config.pm2Bin) : (config.pm2Bin ?? '');
    $('#sReboot').value = config.rebootCommand ?? '';
    $('#sPages').value = config.pagesPerProcess ?? '';
    $('#sTail').value = config.logTailBytes ?? '';
    $('#sLogPattern').value = config.logPattern ?? '';
    renderDecodersEditor();
    $('#saveMsg').textContent = '';
    loadPm2Options();
  } catch (e) {
    $('#saveMsg').textContent = 'failed to load config: ' + e.message;
  }
}

async function loadPm2Options() {
  try {
    const { processes } = await api('/api/pm2/processes');
    const dl = $('#pm2Options');
    dl.innerHTML = '';
    processes.forEach((p) => {
      const o = el('option'); o.value = p.name; o.label = `${p.name} (id ${p.pmId}, ${p.status})`;
      dl.append(o);
    });
  } catch { /* pm2 not reachable — datalist just stays empty */ }
}

function renderDecodersEditor() {
  const box = $('#decodersEditor');
  box.innerHTML = '';
  draft.decoders.forEach((d, i) => box.append(decoderEditor(d, i)));
}

function field(labelText, value, oninput, opts = {}) {
  const l = el('label', opts.cls || null);
  l.append(document.createTextNode(labelText));
  const input = el(opts.textarea ? 'textarea' : 'input');
  input.value = value ?? '';
  if (opts.placeholder) input.placeholder = opts.placeholder;
  if (opts.list) input.setAttribute('list', opts.list);
  if (opts.inputmode) input.inputMode = opts.inputmode;
  input.addEventListener('input', () => oninput(input.value));
  l.append(input);
  if (opts.hint) l.append(el('small', null, opts.hint));
  return l;
}

function decoderEditor(d, i) {
  const wrap = el('div', 'grp');

  const top = el('div', 'grpTop');
  top.append(field('Label', d.label, (v) => { d.label = v; }, { placeholder: 'EAS Channel 1' }));
  top.append(field('Go orange after (minutes idle)', d.staleMinutes, (v) => { d.staleMinutes = +v || 0; }, { inputmode: 'numeric', placeholder: '30' }));
  const del = el('button', 'btn sm danger', 'Delete');
  del.onclick = () => { draft.decoders.splice(i, 1); renderDecodersEditor(); };
  top.append(del);
  wrap.append(top);

  const row = el('div', 'procRow');
  row.append(field('pm2 name / id', d.pm2Ref, (v) => { d.pm2Ref = v; }, { list: 'pm2Options', placeholder: 'EAS1' }));
  row.append(field('Working dir (has reader.js)', d.cwd, (v) => { d.cwd = v; }, { placeholder: '/home/ben/pagermon/client' }));
  row.append(field('Reader command', d.readerCmd, (v) => { d.readerCmd = v; }, { placeholder: 'node ./reader.js' }));
  row.append(field('Config file (reader.sh — holds frequency)', d.configFile, (v) => { d.configFile = v; }, { placeholder: '/home/ben/pagermon/client/reader.sh' }));
  wrap.append(row);

  const row2 = el('div', 'procRow2');
  row2.append(field('Page log override (optional — leave blank to use the pm2 stdout log)', d.logFile, (v) => { d.logFile = v; }, { placeholder: '/home/ben/pagermon/client/decoded.log' }));
  wrap.append(row2);
  return wrap;
}

$('#addDecoderBtn').addEventListener('click', () => {
  draft.decoders.push({ label: `Decoder ${draft.decoders.length + 1}`, staleMinutes: 30, pm2Ref: '', cwd: '', readerCmd: 'node ./reader.js', configFile: '', logFile: '' });
  renderDecodersEditor();
});

$('#saveBtn').addEventListener('click', async () => {
  draft.bind = $('#sBind').value.trim() || '0.0.0.0';
  draft.port = +$('#sPort').value || 8080;
  const pm2raw = $('#sPm2Bin').value.trim();
  try { draft.pm2Bin = pm2raw.startsWith('[') ? JSON.parse(pm2raw) : (pm2raw || 'pm2'); }
  catch { draft.pm2Bin = pm2raw || 'pm2'; }
  draft.rebootCommand = $('#sReboot').value.trim();
  draft.pagesPerProcess = +$('#sPages').value || 20;
  draft.logTailBytes = +$('#sTail').value || 200000;
  draft.logPattern = $('#sLogPattern').value.trim() || null;

  $('#saveBtn').disabled = true;
  $('#saveMsg').textContent = 'saving…';
  try {
    const r = await api('/api/config', { method: 'POST', body: draft });
    draft = r.config;
    renderDecodersEditor();
    $('#saveMsg').textContent = r.restartNeeded
      ? 'Saved. Restart the panel process for the new port/bind to take effect.'
      : 'Saved. ✓';
  } catch (e) {
    $('#saveMsg').textContent = 'save failed: ' + e.message;
  } finally {
    $('#saveBtn').disabled = false;
  }
});

// ================================================================ boot ======
startPolling();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else if (currentView === 'dashboard') startPolling();
});
