import { $, el, icon, call, avatar, generatePassword } from './common.js';

const params = new URLSearchParams(location.search);
let st, view = ['new', 'settings'].includes(params.get('view')) ? params.get('view') : 'list';
let autoTouch = true; // Touch ID starts by itself only when the window opens, not after locking

const show = (msg, kind = 'err') => { $('#err').textContent = msg; $('#err').className = `err ${kind === 'info' ? 'info' : ''}`; };

async function run(fn) {
  show('');
  document.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try { return await fn(); } catch (e) { show(e.message); return null; } finally {
    document.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}

async function render() {
  st = await run(() => call({ type: 'status' }));
  if (!st) return;
  const v = st.pendingTotp !== undefined ? 'totp' : !st.loggedIn ? 'login' : !st.unlocked ? 'unlock' : view;
  for (const id of ['login', 'totp', 'unlock', 'list', 'new', 'settings', 'health', 'agents']) $(`#${id}`).hidden = id !== v;
  $('#bar').hidden = !['list', 'new', 'settings', 'health', 'agents'].includes(v);
  $('#drag').hidden = !$('#bar').hidden; // the header bar is the drag area when shown
  $('#barTitle').textContent = { list: 'Vaultfill', new: '', settings: 'Einstellungen', health: 'Sicherheit', agents: 'Agenten' }[v] ?? '';
  $('#healthBtn').hidden = v !== 'list';
  $('#gear').replaceChildren(icon(v === 'list' ? 'gear' : 'back'));
  $('#newBtn').hidden = v !== 'list';

  $('#totpHint').textContent = st.pendingTotp === 1 ? 'Code aus der E-Mail eingeben' : 'Code aus der Authenticator-App eingeben';
  $('#who').textContent = st.email;
  $('#touch').hidden = $('#or').hidden = !st.touchId;
  $('#touchOptIn').hidden = st.touchId || !st.touchIdAvailable;
  $('#info').textContent = `${st.count} Logins · synchronisiert ${new Date(st.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  $('#touchSwitch').checked = st.touchId;
  $('#touchSwitch').disabled = !st.touchIdAvailable;
  $('#touchSub').textContent = st.touchIdAvailable ? 'Entsperren per Fingerabdruck' : 'Auf diesem Mac nicht verfügbar';
  $('#loginSwitch').checked = st.openAtLogin;
  if (!recording) $('#shortcut').textContent = pretty(st.shortcut);

  if (v === 'list') search();
  if (v === 'health' && !healthRun) runHealth();
  if (v === 'agents' || v === 'settings') renderAgents();
  if (v === 'unlock' && st.touchId && autoTouch) touchUnlock();
  else if (v !== 'list') $(`#${v} input`)?.focus();
  autoTouch = false;
}

// --- list ----------------------------------------------------------------------------------

async function search() {
  const q = $('#q').value;
  const res = await run(() => call({ type: 'search', q }));
  if (!res) return;
  const act = (id, field, ic, title) => el('button', {
    type: 'button', className: 'icon-btn', title, ariaLabel: title,
    onclick: (e) => { e.stopPropagation(); copy(id, field); },
  }, icon(ic));
  $('#results').replaceChildren(...res.items.map((it) => el('li', { tabIndex: 0, dataset: { id: it.id } },
    avatar(it, st.server),
    el('span', { className: 'txt' }, el('div', { className: 'name', textContent: it.name }), el('div', { className: 'user', textContent: it.username || '—' })),
    el('span', { className: 'acts' },
      act(it.id, 'username', 'user', 'Benutzername kopieren (⌘C)'),
      act(it.id, 'password', 'key', 'Passwort kopieren (⌘⇧C)'),
      ...(it.totp ? [act(it.id, 'totp', 'clock', '2FA-Code kopieren')] : []),
      ...(it.host ? [el('button', { type: 'button', className: 'icon-btn', title: 'Website öffnen', ariaLabel: 'Website öffnen', onclick: () => call({ type: 'openUrl', url: `https://${it.host}` }) }, icon('link'))] : [])))));
  if (!res.items.length) $('#results').append(el('li', { className: 'empty', textContent: q ? 'Nichts gefunden' : 'Noch keine Logins' }));
}

async function copy(id, field) {
  if (await run(() => call({ type: 'copy', id, field }))) show(`${{ password: 'Passwort', totp: '2FA-Code', username: 'Benutzername' }[field]} kopiert`, 'info');
}

$('#q').addEventListener('input', search);
$('#q').addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); $('#results li[tabindex]')?.focus(); } });
$('#results').addEventListener('keydown', (e) => {
  const sib = e.key === 'ArrowDown' ? e.target.nextElementSibling : e.key === 'ArrowUp' ? e.target.previousElementSibling ?? $('#q') : null;
  if (sib) { e.preventDefault(); sib.focus(); }
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ',' && st?.unlocked) { e.preventDefault(); view = 'settings'; render(); return; }
  if (!(e.metaKey || e.ctrlKey) || $('#list').hidden) return;
  if (e.key.toLowerCase() === 'n') { e.preventDefault(); openNew(); return; }
  if (e.key.toLowerCase() !== 'c') return;
  const a = document.activeElement;
  if (getSelection().toString() || (a.selectionStart ?? 0) !== (a.selectionEnd ?? 0)) return;
  const id = (a.closest('li[data-id]') ?? $('#results li[data-id]'))?.dataset.id;
  if (id) { e.preventDefault(); copy(id, e.shiftKey ? 'password' : 'username'); }
});

// --- new login -----------------------------------------------------------------------------

function openNew(name = '') {
  view = 'new';
  $('#new').reset();
  $('#new').name.value = name;
  $('#new').password.value = generatePassword();
  render();
}

$('#newBtn').addEventListener('click', () => openNew());
$('#genPw').addEventListener('click', () => { $('#new').password.value = generatePassword(); $('#new').password.type = 'text'; });
$('#showPw').addEventListener('click', () => { const p = $('#new').password; p.type = p.type === 'password' ? 'text' : 'password'; });
$('#cancelNew').addEventListener('click', () => { view = 'list'; render(); });
$('#new').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  if (await run(() => call({ type: 'create', ...f }))) {
    view = 'list';
    await render();
    show(`„${f.name}“ gespeichert`, 'info');
  }
});

// --- security check -----------------------------------------------------------------------

let healthRun = null; // result is kept until the vault changes
async function runHealth() {
  healthRun = run(() => call({ type: 'health' }));
  for (const id of ['nBreached', 'nReused', 'nWeak']) $(`#${id}`).textContent = '…';
  $('#healthHint').textContent = 'Prüfe … Datenlecks via Have I Been Pwned (nur ein Hash-Präfix verlässt den Mac)';
  $('#healthLists').replaceChildren();
  const r = await healthRun;
  if (!r) { healthRun = null; return; }
  $('#nBreached').textContent = r.breached.length;
  $('#nReused').textContent = r.reused.length;
  $('#nWeak').textContent = r.weak.length;
  $('#healthHint').textContent = r.hibpFailed ? 'Datenleck-Prüfung teilweise fehlgeschlagen (offline?).' : `${r.total} Passwörter geprüft.`;
  const section = (title, rows) => rows.length ? [el('h3', { textContent: title }), el('ul', {}, ...rows.map((it) => el('li', {},
    avatar(it, st.server),
    el('span', { className: 'txt' }, el('div', { className: 'name', textContent: it.name }), el('div', { className: 'user', textContent: it.username || '—' })),
    el('span', { className: 'badge', textContent: it.reason }),
    ...(it.host ? [el('button', { type: 'button', className: 'icon-btn', title: 'Website öffnen, um das Passwort zu ändern', ariaLabel: 'Website öffnen', onclick: () => call({ type: 'openUrl', url: `https://${it.host}` }) }, icon('link'))] : []))))] : [];
  $('#healthLists').replaceChildren(...section('Geleakt', r.breached), ...section('Mehrfach verwendet', r.reused), ...section('Schwach', r.weak));
  if (!r.breached.length && !r.reused.length && !r.weak.length) $('#healthLists').append(el('p', { className: 'hint', textContent: '✓ Alles im grünen Bereich.' }));
}

$('#healthBtn').addEventListener('click', () => { view = 'health'; render(); });

// --- agents (MCP) --------------------------------------------------------------------------

const ago = (ts) => new Date(ts).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
async function renderAgents() {
  const a = await run(() => call({ type: 'agentState' }));
  if (!a) return;
  $('#agentSub').textContent = a.shares.length ? `${a.shares.length} freigegeben · ${a.sessions.length} aktiv` : 'Test-Zugangsdaten für KI-Agenten freigeben';
  if ($('#agents').hidden) return;
  const level = (sh) => el('select', { ariaLabel: `Freigabe für ${sh.name}`, onchange: (e) => setShare(sh.id, e.target.value) },
    el('option', { value: 'use', textContent: 'Für Befehle', selected: sh.level === 'use' }),
    el('option', { value: 'reveal', textContent: 'Für Befehle + Klartext', selected: sh.level === 'reveal' }));
  $('#shares').replaceChildren(...a.shares.map((sh) => el('li', {},
    avatar(sh, null),
    el('span', { className: 'txt' }, el('div', { className: 'name', textContent: sh.name }), el('div', { className: 'user', textContent: sh.username || '—' })),
    level(sh),
    el('button', { type: 'button', className: 'icon-btn', title: 'Freigabe entfernen', ariaLabel: `Freigabe für ${sh.name} entfernen`, onclick: () => setShare(sh.id, null) }, icon('x')))));
  if (!a.shares.length) $('#shares').append(el('li', { className: 'none', textContent: 'Noch nichts freigegeben.' }));
  $('#sessions').replaceChildren(...a.sessions.map((x) => el('li', {},
    el('span', { className: 'txt' }, el('div', { className: 'name', textContent: x.client }), el('div', { className: 'user', textContent: `${x.cwd} · seit ${ago(x.since)}` })),
    el('button', { type: 'button', className: 'btn soft', textContent: 'Trennen', onclick: async () => { await run(() => call({ type: 'kickAgent', i: x.i })); renderAgents(); } }))));
  if (!a.sessions.length) $('#sessions').append(el('li', { className: 'none', textContent: 'Kein Agent verbunden.' }));
  $('#mcpCmd').textContent = a.command || 'Node.js nicht gefunden – bitte installieren (z. B. brew install node), dann Vaultfill neu starten.';
  $('#copyCmd').hidden = !a.command;
  $('#agentLog').replaceChildren(...a.log.map((l) => el('li', { className: 'log' }, `${ago(l.ts)} · `, el('b', { textContent: l.client }), ` · ${l.action}${l.name ? ` · ${l.name}` : ''}`)));
  if (!a.log.length) $('#agentLog').append(el('li', { className: 'none', textContent: 'Noch keine Zugriffe.' }));
}

async function setShare(id, level) {
  await run(() => call({ type: 'setShare', id, level }));
  $('#shareQ').value = '';
  $('#shareHits').replaceChildren();
  renderAgents();
}

$('#agentsBtn').addEventListener('click', () => { view = 'agents'; render(); });
$('#copyCmd').addEventListener('click', async () => { await navigator.clipboard.writeText($('#mcpCmd').textContent); show('Befehl kopiert – im Terminal ausführen', 'info'); });
$('#shareQ').addEventListener('input', async () => {
  const q = $('#shareQ').value.trim();
  const res = q ? await run(() => call({ type: 'search', q, limit: 6 })) : { items: [] };
  $('#shareHits').replaceChildren(...(res?.items || []).map((it) => el('li', { tabIndex: 0, style: 'cursor:pointer', onclick: () => setShare(it.id, 'use'), onkeydown: (e) => e.key === 'Enter' && setShare(it.id, 'use') },
    avatar(it, st.server),
    el('span', { className: 'txt' }, el('div', { className: 'name', textContent: it.name }), el('div', { className: 'user', textContent: it.username || '—' })),
    el('span', { className: 'badge', textContent: 'freigeben' }))));
});

// --- settings ------------------------------------------------------------------------------

$('#gear').addEventListener('click', () => { view = view === 'list' ? 'settings' : 'list'; render(); });
$('#touchSwitch').addEventListener('change', async (e) => { await run(() => call({ type: 'setTouchId', on: e.target.checked })); render(); });
$('#loginSwitch').addEventListener('change', async (e) => { await run(() => call({ type: 'setOpenAtLogin', on: e.target.checked })); render(); });

// Shortcut recorder: click, press the combination; Esc cancels.
const pretty = (a) => a.replace('CommandOrControl', '⌘').replace('Command', '⌘').replace('Control', '⌃').replace('Alt', '⌥').replace('Shift', '⇧').replace('Space', 'Leertaste').replaceAll('+', ' ');
let recording = false;
$('#shortcut').addEventListener('click', () => {
  recording = true;
  $('#shortcut').classList.add('rec');
  $('#shortcut').textContent = 'Tasten drücken …';
});
document.addEventListener('keydown', async (e) => {
  if (!recording) return;
  e.preventDefault();
  if (e.key === 'Escape') { recording = false; $('#shortcut').classList.remove('rec'); return render(); }
  const key = e.code === 'Space' ? 'Space' : e.code.replace(/^Key|^Digit/, '');
  if (['Meta', 'Control', 'Alt', 'Shift'].some((m) => e.key === m)) return; // wait for the actual key
  const mods = [e.metaKey && 'Command', e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  if (!mods.length) return show('Mindestens eine Sondertaste (⌘ ⌥ ⌃ ⇧) verwenden');
  recording = false;
  $('#shortcut').classList.remove('rec');
  await run(() => call({ type: 'setShortcut', accel: [...mods, key].join('+') }));
  render();
}, true);

// --- auth ----------------------------------------------------------------------------------

async function touchUnlock() {
  if (await run(() => call({ type: 'unlockTouchId' }))) render();
}
$('#touch').addEventListener('click', touchUnlock);

$('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pending = run(() => call({ type: 'login', ...Object.fromEntries(new FormData(e.target)) }));
  show('Anmelden … bei SSO im Anmeldefenster fortfahren', 'info'); // after run() cleared the message line
  if (await pending) render();
});
$('#totp').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await run(() => call({ type: 'login', totp: e.target.totp.value }))) render();
});
$('#unlock').addEventListener('submit', async (e) => {
  e.preventDefault();
  const enableTouch = e.target.enableTouch.checked;
  if (!(await run(() => call({ type: 'unlock', password: e.target.password.value })))) return;
  e.target.reset();
  if (enableTouch) await run(() => call({ type: 'setTouchId', on: true })); // shows the Touch ID prompt once
  render();
});

document.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !(await run(() => call({ type: act })))) return;
  view = 'list';
  render();
});

window.vf.on('vf:changed', () => { healthRun = null; if (view !== 'new') render(); });
window.vf.on('vf:view', (d) => { if (d?.view === 'new') openNew(d.name); else { view = d?.view || 'list'; render(); } });

if (view === 'new') openNew(params.get('name') || '');
else render();
