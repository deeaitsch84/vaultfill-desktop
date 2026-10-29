import { $, el, call, avatar } from './common.js';

let st, items = [], sel = 0, mode = 'search'; // search | unlock | login

const fit = () => call({ type: 'resizeSpot', height: $('.spot').offsetHeight });
const showErr = (msg) => { $('#err').textContent = msg; fit(); };

async function refresh() {
  st = await call({ type: 'status' });
  mode = !st.loggedIn ? 'login' : !st.unlocked ? 'unlock' : 'search';
  const q = $('#q');
  q.type = mode === 'unlock' ? 'password' : 'text';
  q.placeholder = { search: 'Search logins', unlock: st.touchId ? 'Master password or Touch ID …' : 'Master password', login: 'Not signed in – ⏎ opens Vaultfill' }[mode];
  $('#foot').hidden = mode !== 'search';
  await render();
}

async function render() {
  const q = $('#q').value.trim();
  if (mode === 'search') {
    items = (await call({ type: 'search', q, limit: 8 })).items;
    if (q) items.push({ create: true, name: `Save “${q}” as a new login`, username: '⌘N' });
  } else items = [];
  sel = Math.min(sel, Math.max(items.length - 1, 0));
  $('#results').replaceChildren(...items.map((it, i) => el('li', {
    role: 'option', ariaSelected: String(i === sel),
    onmousemove: () => { if (sel !== i) { sel = i; mark(); } },
    onclick: () => choose(i, false),
  },
  it.create ? el('span', { className: 'av plus', textContent: '+' }) : avatar(it, st.server),
  el('span', { className: 'txt' }, el('div', { className: 'name', textContent: it.name }), el('div', { className: 'user', textContent: it.username || '—' })),
  ...(it.host ? [el('span', { className: 'host', textContent: it.host })] : []),
  el('span', { className: 'enter', textContent: '↵' }))));
  if (mode === 'search' && !items.length) $('#results').append(el('li', { className: 'note', textContent: 'Type to search' }));
  fit();
}

const mark = () => [...$('#results').children].forEach((li, i) => li.setAttribute('aria-selected', String(i === sel)));

async function choose(i, passwordOnly) {
  const it = items[i];
  if (!it) return;
  try {
    if (it.create) return await call({ type: 'openMain', view: 'new', name: $('#q').value.trim() });
    await call({ type: 'autotype', id: it.id, passwordOnly });
  } catch (e) { showErr(e.message); }
}

async function copy(field) {
  const it = items[sel];
  if (!it || it.create) return;
  try {
    await call({ type: 'copy', id: it.id, field });
    await call({ type: 'hideSpot' });
  } catch (e) { showErr(e.message); }
}

async function submitUnlock() {
  try {
    await call({ type: 'unlock', password: $('#q').value });
    $('#q').value = '';
    await refresh();
  } catch (e) { showErr(e.message); $('#q').select(); }
}

async function touch() {
  try { await call({ type: 'unlockTouchId' }); await refresh(); } catch (e) { showErr(e.message); }
  $('#q').focus();
}

$('#q').addEventListener('input', () => { $('#err').textContent = ''; sel = 0; if (mode === 'search') render(); });
$('#q').addEventListener('keydown', (e) => {
  const cmd = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape') {
    e.preventDefault();
    if ($('#q').value) { $('#q').value = ''; render(); } else call({ type: 'hideSpot' });
  } else if (mode === 'login' && e.key === 'Enter') {
    call({ type: 'openMain' });
  } else if (mode === 'unlock' && e.key === 'Enter') {
    e.preventDefault();
    submitUnlock();
  } else if (mode !== 'search') {
    // nothing else while locked / logged out
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % Math.max(items.length, 1);
    mark();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    choose(sel, e.shiftKey);
  } else if (cmd && e.altKey && e.code === 'KeyC') { // ⌥ changes e.key (ç), so match the physical key
    e.preventDefault();
    copy('totp');
  } else if (cmd && e.key === ',') {
    e.preventDefault();
    call({ type: 'openMain', view: 'settings' });
  } else if (cmd && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    call({ type: 'openMain', view: 'new', name: $('#q').value.trim() });
  } else if (cmd && e.key.toLowerCase() === 'c' && $('#q').selectionStart === $('#q').selectionEnd) {
    e.preventDefault();
    copy(e.shiftKey ? 'password' : 'username');
  }
});

// Every open starts fresh; locked + Touch ID → prompt right away.
window.vf.on('vf:show', async () => {
  $('#q').value = '';
  $('#err').textContent = '';
  sel = 0;
  await refresh();
  $('#q').focus();
  if (mode === 'unlock' && st.touchId) touch();
});
window.vf.on('vf:changed', () => refresh());

refresh();
