// Vaultfill desktop: menu-bar app with a Spotlight-style quick search (global shortcut).
// State on disk (encrypted vault, tokens, settings) is sealed with safeStorage (macOS Keychain);
// the decrypted user key and index (no passwords) live only in memory while unlocked.
import {
  app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, safeStorage,
  systemPreferences, powerMonitor, clipboard, shell, screen, dialog,
} from 'electron';
import { spawn } from 'node:child_process';
import { createServer as createSocketServer } from 'node:net';
import { readFile, writeFile, unlink, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as v from './vault.js';

const dir = dirname(fileURLToPath(import.meta.url));
if (process.env.VF_USERDATA) app.setPath('userData', process.env.VF_USERDATA);
const STATE_FILE = () => join(app.getPath('userData'), 'state.bin');
const IDLE_LOCK_SECONDS = 30 * 60;
const CLIPBOARD_CLEAR_MS = 30e3;
const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space';

let state = {}; // persisted
let mem = {};   // unlocked session: userKey, orgKeys, index; plus pending 2FA
let mainWin, spotWin, tray;

// --- persistence ------------------------------------------------------------------------

async function load() {
  try { state = JSON.parse(safeStorage.decryptString(await readFile(STATE_FILE()))); } catch { state = {}; }
}
const save = () => writeFile(STATE_FILE(), safeStorage.encryptString(JSON.stringify(state)), { mode: 0o600 });

const broadcast = () => [mainWin, spotWin].forEach((w) => w && !w.isDestroyed() && w.webContents.send('vf:changed'));

// --- vault ------------------------------------------------------------------------------

async function accessToken() {
  if (state.accessToken && Date.now() < state.tokenExp - 60e3) return state.accessToken;
  const t = await v.token(state.server, { grant_type: 'refresh_token', client_id: 'desktop', refresh_token: state.refreshToken });
  Object.assign(state, { accessToken: t.access_token, tokenExp: Date.now() + t.expires_in * 1000, refreshToken: t.refresh_token || state.refreshToken });
  await save();
  return t.access_token;
}

async function sync() {
  state.vault = await v.sync(state.server, await accessToken());
  state.lastSync = Date.now();
  await save();
  if (mem.userKey) Object.assign(mem, await v.decryptVault(state.vault, v.toKey(v.unb64(mem.userKey))));
  broadcast();
}

const userKey = () => {
  if (!mem.userKey) throw new Error('Vault gesperrt');
  return v.toKey(v.unb64(mem.userKey));
};

async function openVault(key) {
  Object.assign(mem, await v.decryptVault(state.vault, key));
  broadcast();
}

function lock() {
  mem = {};
  endAgentSessions();
  broadcast();
}

// --- login (password or SSO via system browser) -----------------------------------------

const DEVICE = () => ({ scope: 'api offline_access', client_id: 'desktop', deviceType: '7', deviceIdentifier: state.deviceId, deviceName: 'macos' });

async function finishLogin(p, grant, { totp, provider } = {}) {
  state.deviceId ??= crypto.randomUUID();
  const form = { ...grant, ...DEVICE() };
  if (totp) Object.assign(form, { twoFactorToken: totp.replace(/\s/g, ''), twoFactorProvider: String(provider), twoFactorRemember: '1' });
  else if (state.twoFactorRemember) Object.assign(form, { twoFactorToken: state.twoFactorRemember, twoFactorProvider: '5' });

  let t;
  try {
    t = await v.token(p.server, form);
  } catch (e) {
    const providers = (e.data?.twoFactorProviders || []).map(Number);
    if (!providers.length) throw e;
    const prov = [0, 1].find((x) => providers.includes(x)); // authenticator app, email
    if (prov === undefined) throw new Error('Nur TOTP- oder E-Mail-2FA wird unterstützt');
    mem.pending = { ...p, grant, provider: prov };
    return { needTotp: true, provider: prov };
  }
  const key = v.toKey(await v.decrypt(t.key, await v.stretch(v.unb64(p.mk))));
  Object.assign(state, {
    server: p.server, email: p.email, kdf: p.kdf, accessToken: t.access_token, tokenExp: Date.now() + t.expires_in * 1000,
    refreshToken: t.refresh_token, twoFactorRemember: t.twoFactorToken || state.twoFactorRemember,
  });
  delete mem.pending;
  await sync();
  await openVault(key);
  connectHub();
  return {};
}

async function login({ server, email, password, totp }) {
  if (totp && mem.pending) return finishLogin(mem.pending, mem.pending.grant, { totp, provider: mem.pending.provider });
  server = await v.resolveServer(server);
  email = email.trim().toLowerCase();
  const kdf = await v.prelogin(server, email);
  const mk = await v.makeMasterKey(password, email, kdf);
  const p = { server, email, kdf, mk: v.b64(mk) };
  try {
    return await finishLogin(p, { grant_type: 'password', username: email, password: await v.masterPasswordHash(mk, password) });
  } catch (e) {
    if (!/SSO sign-in is required/i.test(e.message)) throw e;
  }
  return startSso(p);
}

// SSO runs in our own window: Vaultwarden redirects to <server>/sso-connector.html?code=…&state=…
// (same target as the web vault), which we intercept. Unlike a localhost redirect from the system
// browser this is not subject to Chrome's local-network blocking. The IdP session persists.
async function startSso(p) {
  const rand = () => v.b64url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = rand(), ssoState = rand(), redirect = `${p.server}/sso-connector.html`;
  const challenge = v.b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const win = new BrowserWindow({
    width: 520, height: 720, title: 'Vaultfill – Anmeldung', autoHideMenuBar: true,
    webPreferences: { partition: 'persist:sso', sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setUserAgent(app.userAgentFallback.replace(/ (Electron|vaultfill-desktop|Vaultfill)\/\S+/g, '')); // IdPs dislike unknown browsers
  return new Promise((resolve, reject) => {
    let done = false;
    const onNav = async (e, url) => {
      if (done || !url.startsWith(redirect)) return;
      done = true;
      e.preventDefault();
      win.destroy();
      showMain();
      const q = new URL(url).searchParams;
      try {
        if (q.get('state') !== ssoState) throw new Error('SSO: state stimmt nicht');
        resolve(await finishLogin(p, { grant_type: 'authorization_code', code: q.get('code'), code_verifier: verifier, redirect_uri: redirect }));
      } catch (err) { reject(err); }
    };
    win.webContents.on('will-redirect', onNav);
    win.webContents.on('will-navigate', onNav);
    win.on('closed', () => { if (!done) reject(new Error('Anmeldung abgebrochen')); });
    win.loadURL(`${p.server}/identity/connect/authorize?${new URLSearchParams({
      client_id: 'browser', redirect_uri: redirect, response_type: 'code', response_mode: 'query', scope: 'api offline_access',
      state: ssoState, code_challenge: challenge, code_challenge_method: 'S256',
    })}`);
  });
}

// --- unlock -------------------------------------------------------------------------------

async function unlock({ password }) {
  let key;
  try { key = v.toKey(await v.decrypt(state.vault.profile.key, await v.stretch(await v.makeMasterKey(password, state.email, state.kdf)))); }
  catch { throw new Error('Falsches Master-Passwort'); }
  await openVault(key);
  sync().catch((e) => console.warn('sync', e));
  return {};
}

// Touch ID gates a Keychain-sealed copy of the user key (same model as Bitwarden desktop biometrics).
async function unlockTouchId() {
  if (!state.touchKey) throw new Error('Touch ID nicht eingerichtet');
  try { await systemPreferences.promptTouchID('Vaultfill entsperren'); } catch { throw new Error('Touch ID abgebrochen'); }
  await openVault(v.toKey(v.unb64(state.touchKey)));
  sync().catch((e) => console.warn('sync', e));
  return {};
}

async function setTouchId({ on }) {
  if (on) {
    if (!systemPreferences.canPromptTouchID()) throw new Error('Touch ID ist auf diesem Mac nicht verfügbar');
    try { await systemPreferences.promptTouchID('Touch ID für Vaultfill aktivieren'); } catch { throw new Error('Touch ID abgebrochen'); }
    state.touchKey = mem.userKey ?? v.b64(v.keyBytes(userKey()));
  } else delete state.touchKey;
  await save();
  return {};
}

function status() {
  return {
    loggedIn: !!state.vault, unlocked: !!mem.index, email: state.email, server: state.server, count: mem.index?.length,
    lastSync: state.lastSync, pendingTotp: mem.pending?.provider, touchId: !!state.touchKey,
    touchIdAvailable: systemPreferences.canPromptTouchID(), shortcut: state.shortcut || DEFAULT_SHORTCUT,
    openAtLogin: app.getLoginItemSettings().openAtLogin,
  };
}

// --- search, copy, type, create -------------------------------------------------------

const hostOf = (uri) => { try { return new URL(/:\/\//.test(uri) ? uri : `https://${uri}`).hostname; } catch { return null; } };

function search({ q = '', limit = 50 }) {
  const lastUsed = state.lastUsed || {};
  const needle = q.trim().toLowerCase();
  const hits = (mem.index || []).filter((e) => !needle || [e.name, e.username, ...e.uris.map((u) => u.uri)].some((s) => s?.toLowerCase().includes(needle)));
  return {
    items: hits
      .toSorted((a, b) => (lastUsed[b.id] || 0) - (lastUsed[a.id] || 0) || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((e) => ({ id: e.id, name: e.name, username: e.username, totp: e.totp, host: e.uris.map((u) => hostOf(u.uri)).find(Boolean) || null })),
  };
}

async function credentials(id) {
  const c = state.vault.ciphers.find((x) => x.id === id);
  const k = await v.itemKey(c, mem);
  state.lastUsed = { ...state.lastUsed, [id]: Date.now() };
  save();
  return { username: await v.decryptStr(c.login.username, k), password: await v.decryptStr(c.login.password, k) };
}

async function totpOf(id) {
  const c = state.vault.ciphers.find((x) => x.id === id);
  if (!c.login.totp) throw new Error('Kein 2FA-Schlüssel hinterlegt');
  return v.totp(await v.decryptStr(c.login.totp, await v.itemKey(c, mem)));
}

let clipTimer;
async function copy({ id, field }) {
  const value = field === 'totp' ? (await totpOf(id)).code : (await credentials(id))[field];
  clipboard.writeText(value);
  clearTimeout(clipTimer);
  if (field === 'password') clipTimer = setTimeout(() => clipboard.readText() === value && clipboard.clear(), CLIPBOARD_CLEAR_MS);
  return {};
}

// Types into the app that was frontmost before the quick search opened.
// The script goes through stdin so the password never shows up in the process list.
async function autotype({ id, passwordOnly }) {
  if (!systemPreferences.isTrustedAccessibilityClient(false)) {
    systemPreferences.isTrustedAccessibilityClient(true); // shows the macOS prompt
    throw new Error('Bitte Vaultfill unter Systemeinstellungen → Datenschutz → Bedienungshilfen erlauben');
  }
  const cred = await credentials(id);
  hideSpot();
  app.hide(); // macOS re-activates the previous app
  await new Promise((r) => setTimeout(r, 250));
  const str = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lines = [...(passwordOnly || !cred.username ? [] : [`keystroke ${str(cred.username)}`, 'keystroke tab']), `keystroke ${str(cred.password)}`];
  await new Promise((resolve, reject) => {
    const p = spawn('osascript', ['-']);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => code ? reject(new Error(`Tippen fehlgeschlagen: ${err.trim()}`)) : resolve());
    p.stdin.end(`tell application "System Events"\n${lines.join('\n')}\nend tell\n`);
  });
  return {};
}

// Password check: reused and weak locally; breached via HIBP k-anonymity (each distinct password once, 8 in parallel).
async function health() {
  const all = [];
  for (const e of mem.index || []) {
    const c = state.vault.ciphers.find((x) => x.id === e.id);
    const pw = await v.decryptStr(c.login.password, await v.itemKey(c, mem));
    if (pw) all.push({ e, pw });
  }
  const uses = new Map();
  for (const { pw } of all) uses.set(pw, (uses.get(pw) || 0) + 1);
  const unique = [...uses.keys()], leaks = new Map();
  for (let i = 0; i < unique.length; i += 8) {
    await Promise.all(unique.slice(i, i + 8).map(async (pw) => leaks.set(pw, await v.pwnedCount(pw).catch(() => -1))));
  }
  const row = ({ e }, reason) => ({ id: e.id, name: e.name, username: e.username, host: e.uris.map((u) => hostOf(u.uri)).find(Boolean) || null, reason });
  return {
    total: all.length,
    hibpFailed: [...leaks.values()].some((n) => n < 0),
    breached: all.filter((x) => leaks.get(x.pw) > 0).toSorted((a, b) => leaks.get(b.pw) - leaks.get(a.pw))
      .map((x) => row(x, `${leaks.get(x.pw).toLocaleString('de-DE')}× in Datenlecks`)),
    // same password next to each other (sorted locally, the password itself never leaves main)
    reused: all.filter((x) => uses.get(x.pw) > 1).toSorted((a, b) => uses.get(b.pw) - uses.get(a.pw) || (a.pw < b.pw ? -1 : a.pw > b.pw ? 1 : 0))
      .map((x) => row(x, `${uses.get(x.pw)}× dasselbe Passwort`)),
    weak: all.filter((x) => v.isWeak(x.pw)).map((x) => row(x, x.pw.length < 10 ? `nur ${x.pw.length} Zeichen` : 'leicht zu erraten')),
  };
}

async function create({ name, username, password, uri }) {
  if (!name?.trim()) throw new Error('Name fehlt');
  await v.createLogin(state.server, await accessToken(), { name: name.trim(), username, password, uri: uri?.trim() }, userKey(), state.vault.profile.id);
  await sync();
  return {};
}

// --- live sync (Vaultwarden SignalR hub, MessagePack) -----------------------------------

const PING = new Uint8Array([0x02, 0x91, 0x06]);
let ws, connecting, pingTimer, syncTimer;

async function connectHub() {
  if (ws || connecting || !state.refreshToken) return; // callers overlap (start, login); token fetch is async
  connecting = true;
  let token;
  try { token = await accessToken(); } catch { return setTimeout(connectHub, 60e3); } finally { connecting = false; }
  const server = state.server;
  const sock = (ws = new WebSocket(`${server.replace(/^http/, 'ws')}/notifications/hub?access_token=${encodeURIComponent(token)}`));
  sock.binaryType = 'arraybuffer';
  // handlers use their own socket: a reconnect may already have replaced the global `ws`
  sock.onopen = () => {
    sock.send('{"protocol":"messagepack","version":1}\x1e');
    pingTimer = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send(PING), 20e3);
  };
  sock.onmessage = ({ data }) => {
    const b = new Uint8Array(data);
    if (b.length === 3 && ((b[0] === 0x7b && b[1] === 0x7d) || (b[1] === 0x91 && b[2] === 0x06))) return; // handshake / ping
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => sync().catch((e) => console.warn('sync', e)), 1500);
  };
  sock.onclose = () => {
    clearInterval(pingTimer);
    if (ws === sock) ws = null;
    if (state.refreshToken) setTimeout(connectHub, 30e3);
  };
}

// --- settings -----------------------------------------------------------------------------

function registerShortcut(accel) {
  globalShortcut.unregisterAll();
  return globalShortcut.register(accel, toggleSpot);
}

async function setShortcut({ accel }) {
  const old = state.shortcut || DEFAULT_SHORTCUT;
  let ok = false;
  try { ok = registerShortcut(accel); } catch {}
  if (!ok) { registerShortcut(old); throw new Error(`${accel} ist nicht verfügbar`); }
  state.shortcut = accel;
  await save();
  return {};
}

async function logout() {
  const { deviceId } = state;
  state = { deviceId };
  mem = {};
  endAgentSessions();
  await save();
  ws?.close();
  broadcast();
  return {};
}

// --- agent access (MCP) ---------------------------------------------------------------------
// mcp.cjs connects over a user-only Unix socket. Each connection is one agent session that the user
// approves once (dialog + Touch ID); it ends when the agent exits or the vault locks. Shares are opt-in
// per entry: 'use' (secrets only via run_with_secrets, output redacted) or 'reveal' (plain text, Touch ID per call).

const AGENT_SOCKET = () => join(app.getPath('userData'), 'agent.sock');
const MAX_OUTPUT = 50_000;
const sessions = new Map(); // socket → { client, cwd, since }
const hooks = { approveAgent, confirmReveal }; // replaced by the smoke test

async function approveAgent({ client, cwd }) {
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    type: 'question', buttons: ['Erlauben', 'Ablehnen'], defaultId: 1, cancelId: 1,
    message: `Agent „${client}“ möchte auf freigegebene Logins zugreifen`,
    detail: `Ordner: ${cwd}\n\nGilt, bis der Agent beendet oder Vaultfill gesperrt wird.`,
  });
  if (response !== 0) return false;
  if (!systemPreferences.canPromptTouchID()) return true;
  try { await systemPreferences.promptTouchID(`Agent „${client}“ Zugriff erlauben`); return true; } catch { return false; }
}

async function confirmReveal(session, name) {
  const why = `Agent „${session.client}“ möchte das Passwort von „${name}“ im Klartext`;
  if (systemPreferences.canPromptTouchID()) {
    try { await systemPreferences.promptTouchID(why); return true; } catch { return false; }
  }
  app.focus({ steal: true });
  return (await dialog.showMessageBox({ type: 'warning', buttons: ['Erlauben', 'Ablehnen'], defaultId: 1, cancelId: 1, message: why })).response === 0;
}

function agentLog(session, action, name = '') {
  state.agentLog = [{ ts: Date.now(), client: session.client, action, name }, ...(state.agentLog || [])].slice(0, 100);
  save();
  broadcast();
}

function sharedEntry(id, need) {
  const level = state.agentShares?.[id];
  const e = mem.index?.find((x) => x.id === id);
  if (!e || !level || (need === 'reveal' && level !== 'reveal')) throw new Error(`Eintrag ${id} ist für Agenten nicht ${need === 'reveal' ? 'im Klartext ' : ''}freigegeben`);
  return e;
}

async function secretOf(ref, need) {
  const m = /^vaultfill:\/\/([^/]+)\/(username|password|totp)$/.exec(ref);
  if (!m) throw new Error(`Ungültige Referenz ${ref} (erwartet vaultfill://<id>/<username|password|totp>)`);
  const e = sharedEntry(m[1], need);
  const c = state.vault.ciphers.find((x) => x.id === e.id);
  const value = m[2] === 'totp' ? (await totpOf(e.id)).code : await v.decryptStr(c.login[m[2]], await v.itemKey(c, mem));
  return { e, field: m[2], value };
}

// Replaces every secret (and its URL/base64 encodings) in tool output. Deliberately transformed output
// (reversed, split, …) is not caught — this guards against accidents, not against a hostile agent.
function redact(text, secrets) {
  for (const s of secrets.filter((x) => x.length >= 3)) {
    for (const variant of new Set([s, encodeURIComponent(s), Buffer.from(s).toString('base64')])) text = text.replaceAll(variant, '•••');
  }
  return text;
}

const agentMethods = {
  list: () => (mem.index || []).filter((e) => state.agentShares?.[e.id]).map((e) => ({
    name: e.name, username: e.username, url: e.uris[0]?.uri || null, plaintext_allowed: state.agentShares[e.id] === 'reveal',
    refs: { username: `vaultfill://${e.id}/username`, password: `vaultfill://${e.id}/password`, ...(e.totp ? { totp: `vaultfill://${e.id}/totp` } : {}) },
  })),

  async run({ command, env = {}, cwd, timeout_seconds: timeout = 600 }, session) {
    if (typeof command !== 'string' || !command.trim()) throw new Error('command fehlt');
    const injected = {}, secrets = [], used = new Set();
    for (const [k, ref] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Ungültiger Variablenname ${k}`);
      if (!String(ref).startsWith('vaultfill://')) { injected[k] = String(ref); continue; }
      const { e, value } = await secretOf(String(ref), 'use');
      injected[k] = value;
      secrets.push(value);
      used.add(e.name);
    }
    agentLog(session, `Befehl: ${command.slice(0, 120)}`, [...used].join(', '));
    return new Promise((resolve) => {
      const p = spawn('/bin/zsh', ['-lc', command], { cwd: cwd || session.cwd, env: { ...process.env, ...injected } });
      let out = '';
      const add = (d) => { out = (out + d).slice(-MAX_OUTPUT * 2); };
      p.stdout.on('data', add);
      p.stderr.on('data', add);
      const timer = setTimeout(() => p.kill('SIGTERM'), Math.min(Math.max(timeout, 1), 3600) * 1000);
      p.on('error', (err) => { clearTimeout(timer); resolve({ exit_code: -1, output: redact(err.message, secrets) }); });
      p.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ exit_code: code ?? -1, ...(signal ? { killed_by: signal } : {}), output: redact(out, secrets).slice(-MAX_OUTPUT) });
      });
    });
  },

  async reveal({ ref }, session) {
    const { e, field, value } = await secretOf(String(ref), 'reveal');
    if (field !== 'username' && !(await hooks.confirmReveal(session, e.name))) throw new Error('Vom Benutzer abgelehnt');
    agentLog(session, `Klartext: ${field}`, e.name);
    return value;
  },
};

async function onAgentMessage(sock, line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const reply = (r) => sock.writable && sock.write(`${JSON.stringify({ id: msg.id, ...r })}\n`);
  try {
    if (!mem.index) throw new Error('Vaultfill ist gesperrt – bitte entsperren');
    let session = sessions.get(sock);
    if (msg.method === 'hello') {
      if (!session) {
        const p = msg.params || {};
        const info = { client: String(p.client || 'agent').slice(0, 80), cwd: String(p.cwd || '?').slice(0, 300) };
        if (!(await hooks.approveAgent(info))) throw new Error('Zugriff vom Benutzer abgelehnt');
        session = { ...info, since: Date.now() };
        sessions.set(sock, session);
        agentLog(session, 'verbunden');
      }
      return reply({ result: {} });
    }
    if (!session) throw new Error('Nicht gekoppelt');
    if (!agentMethods[msg.method]) throw new Error(`Unbekannte Methode ${msg.method}`);
    reply({ result: await agentMethods[msg.method](msg.params || {}, session) });
  } catch (e) {
    reply({ error: e.message });
  }
}

async function startAgentServer() {
  await unlink(AGENT_SOCKET()).catch(() => {});
  const srv = createSocketServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) onAgentMessage(sock, buf.slice(0, i));
    });
    sock.on('close', () => { if (sessions.delete(sock)) broadcast(); });
    sock.on('error', () => {});
  });
  await new Promise((r) => srv.listen(AGENT_SOCKET(), r));
  await chmod(AGENT_SOCKET(), 0o600); // only this macOS user may connect
}

function endAgentSessions() {
  for (const sock of sessions.keys()) sock.destroy();
  sessions.clear();
}

function agentState() {
  const byId = new Map((mem.index || []).map((e) => [e.id, e]));
  const mcp = join(dir, 'mcp.cjs');
  return {
    shares: Object.entries(state.agentShares || {}).filter(([id]) => byId.has(id))
      .map(([id, level]) => ({ id, level, name: byId.get(id).name, username: byId.get(id).username })),
    sessions: [...sessions.entries()].map(([sock, s], i) => ({ i, client: s.client, cwd: s.cwd, since: s.since })),
    log: (state.agentLog || []).slice(0, 30),
    command: `claude mcp add vaultfill -e ELECTRON_RUN_AS_NODE=1 -e VAULTFILL_SOCKET='${AGENT_SOCKET()}' -- '${process.execPath}' '${mcp}'`,
  };
}

async function setShare({ id, level }) {
  if (!mem.index?.some((e) => e.id === id)) throw new Error('Unbekannter Eintrag');
  state.agentShares = { ...state.agentShares };
  if (['use', 'reveal'].includes(level)) state.agentShares[id] = level; else delete state.agentShares[id];
  await save();
  broadcast();
  return {};
}

function kickAgent({ i }) {
  [...sessions.keys()][i]?.destroy();
  return {};
}

// --- windows ------------------------------------------------------------------------------

const webPreferences = { preload: join(dir, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false };

// view: optional { view: 'new', name } — opens the main window on that screen
function showMain(view) {
  if (!mainWin || mainWin.isDestroyed()) {
    mainWin = new BrowserWindow({
      width: 400, height: 600, minWidth: 360, minHeight: 420, show: false, title: 'Vaultfill',
      titleBarStyle: 'hiddenInset', vibrancy: 'sidebar', backgroundColor: '#00000000', webPreferences,
    });
    mainWin.loadFile(join(dir, 'ui/app.html'), { query: view ? { view: view.view, name: view.name || '' } : {} });
    mainWin.once('ready-to-show', () => mainWin.show());
  } else {
    mainWin.show();
    if (view) mainWin.webContents.send('vf:view', view);
  }
  app.focus({ steal: true });
}

function createSpot() {
  spotWin = new BrowserWindow({
    width: 680, height: 120, show: false, frame: false, transparent: true, resizable: false, movable: false,
    hasShadow: true, alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, backgroundColor: '#00000000', webPreferences,
  });
  spotWin.setAlwaysOnTop(true, 'floating');
  spotWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  spotWin.loadFile(join(dir, 'ui/spotlight.html'));
  spotWin.on('blur', hideSpot);
}

function hideSpot() {
  if (spotWin?.isVisible()) spotWin.hide();
}

function toggleSpot() {
  if (spotWin.isVisible()) { hideSpot(); app.hide(); return; }
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const [w] = spotWin.getSize();
  spotWin.setPosition(Math.round(workArea.x + (workArea.width - w) / 2), Math.round(workArea.y + workArea.height * 0.2));
  spotWin.webContents.send('vf:show');
  spotWin.show();
  spotWin.focus();
}

// --- IPC ------------------------------------------------------------------------------------

const handlers = {
  status, login, unlock, unlockTouchId, setTouchId, search, copy, autotype, create, setShortcut, logout, health,
  agentState, setShare, kickAgent,
  sync: async () => { await sync(); return {}; },
  lock: () => { lock(); return {}; },
  setOpenAtLogin: ({ on }) => { app.setLoginItemSettings({ openAtLogin: !!on }); return {}; },
  openMain: ({ view, name }) => { hideSpot(); showMain(view && { view, name }); return {}; },
  hideSpot: () => { hideSpot(); app.hide(); return {}; },
  resizeSpot: ({ height }) => {
    spotWin.setSize(680, Math.min(Math.max(Math.round(height), 60), 600));
    spotWin.invalidateShadow?.(); // macOS: shadow follows the new (rounded, transparent) shape
    return {};
  },
  openUrl: ({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return {}; },
};

ipcMain.handle('vf', async (e, msg) => {
  if (!e.senderFrame?.url.startsWith(pathToFileURL(join(dir, 'ui')).href + '/')) return { error: 'forbidden' };
  try { return (await handlers[msg?.type]?.(msg)) ?? { error: 'unknown' }; } catch (err) { return { error: err.message }; }
});

// --- app ------------------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showMain());
app.on('window-all-closed', () => {}); // keep running in the menu bar
app.on('activate', () => showMain());

app.whenReady().then(async () => {
  app.dock?.hide();
  await load();
  createSpot();
  if (!registerShortcut(state.shortcut || DEFAULT_SHORTCUT)) console.warn('shortcut not available');

  const img = nativeImage.createFromPath(join(dir, 'icons/trayTemplate.png'));
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Vaultfill');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Schnellsuche', accelerator: state.shortcut || DEFAULT_SHORTCUT, click: toggleSpot },
    { label: 'Vaultfill öffnen', click: () => showMain() },
    { label: 'Neuer Login …', enabled: !!mem.index, click: () => showMain({ view: 'new' }) },
    { label: 'Einstellungen …', accelerator: 'Command+,', enabled: !!mem.index, click: () => showMain({ view: 'settings' }) },
    { type: 'separator' },
    { label: mem.index ? 'Sperren' : 'Gesperrt', enabled: !!mem.index, click: lock },
    { label: 'Beenden', role: 'quit' },
  ]);
  tray.on('click', () => tray.popUpContextMenu(menu()));
  tray.on('right-click', () => tray.popUpContextMenu(menu()));

  powerMonitor.on('lock-screen', lock);
  setInterval(() => { if (mem.index && powerMonitor.getSystemIdleTime() >= IDLE_LOCK_SECONDS) lock(); }, 60e3);
  setInterval(() => { if (state.refreshToken) sync().catch((e) => console.warn('sync', e)); }, 30 * 60e3);
  connectHub();
  if (!state.vault) showMain();

  await startAgentServer();
  if (process.env.VF_SMOKE) (await import('./test/smoke.js')).run({ handlers, hooks, showMain, toggleSpot, get mainWin() { return mainWin; }, spotWin });
});
