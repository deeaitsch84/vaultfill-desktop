// Dev smoke run against a throwaway Vaultwarden: drives the real app (IPC handlers, windows) and saves screenshots.
//   VF_SMOKE=<out dir> VF_SERVER=https://localhost:8222 VF_USERDATA=<tmp> NODE_EXTRA_CA_CERTS=<cert> npx electron .
import { app } from 'electron';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { register } from './helpers.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run(ctx) {
  const out = process.env.VF_SMOKE, server = process.env.VF_SERVER, h = ctx.handlers;
  const shot = async (win, name) => writeFile(join(out, name), (await win.capturePage()).toPNG());
  const typeInSpot = (text) => ctx.spotWin.webContents.executeJavaScript(
    `{ const q = document.querySelector('#q'); q.value = ${JSON.stringify(text)}; q.dispatchEvent(new Event('input')); }`);
  const log = [];
  try {
    const email = `smoke-${Date.now()}@example.com`, password = 'correct horse battery staple';
    await register(server, email, password, { kdf: 0, kdfIterations: 600000 });
    log.push(['login', await h.login({ server, email, password })]);
    for (const [name, username, uri, pw] of [
      ['GitHub', 'dhaseloff', 'https://github.com', 'password123'], ['GitHub – bot', 'bot@alemo.de', 'github.com', 'password123'],
      ['Grafana', 'admin', 'https://grafana.com', 'tY8u-Jq3w-Zp5n-Rk2m'], ['Bitbucket', 'dennis@alemo.de', 'https://bitbucket.org', 'Sommer2024']]) {
      await h.create({ name, username, password: pw, uri });
    }
    // --- MCP: proxy started like Claude Code would, approval/Touch ID auto-confirmed
    const ids = Object.fromEntries(h.search({ q: '' }).items.map((i) => [i.name, i.id]));
    await h.setShare({ id: ids.GitHub, level: 'use' });
    await h.setShare({ id: ids.Bitbucket, level: 'reveal' });
    let approvals = 0;
    ctx.hooks.approveAgent = async () => { approvals++; return true; };
    ctx.hooks.confirmReveal = async () => true;
    const { command } = h.agentState();
    const sock = /VAULTFILL_SOCKET='([^']+)'/.exec(command)[1];
    const mcp = spawn(process.execPath, [join(process.cwd(), 'mcp.cjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VAULTFILL_SOCKET: sock } });
    let mbuf = '';
    const replies = new Map();
    mcp.stdout.on('data', (d) => { mbuf += d; for (let i; (i = mbuf.indexOf('\n')) >= 0; mbuf = mbuf.slice(i + 1)) { const m = JSON.parse(mbuf.slice(0, i)); replies.get(m.id)?.(m); } });
    let rid = 0;
    const rpc = (method, params) => new Promise((r) => { const id = ++rid; replies.set(id, r); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
    const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
    await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'smoke-agent' }, capabilities: {} });
    log.push(['mcp tools', (await rpc('tools/list', {})).result.tools.map((t) => t.name)]);
    const listed = JSON.parse((await tool('list_shared_logins', {})).content[0].text);
    log.push(['mcp list', listed.map((l) => `${l.name}/${l.username}/${l.plaintext_allowed}`), JSON.stringify(listed).includes('password123') ? 'LEAK' : 'no secrets']);
    const ghRef = listed.find((l) => l.name === 'GitHub').refs.password, bbRef = listed.find((l) => l.name === 'Bitbucket').refs.password;
    const ran = await tool('run_with_secrets', { command: 'echo "raw=$PW"; node -e "console.log(\'url=\' + encodeURIComponent(process.env.PW) + \' b64=\' + Buffer.from(process.env.PW).toString(\'base64\'))"; printf %s "$PW" | rev; echo; exit 3', env: { PW: ghRef } });
    log.push(['mcp run', ran.content[0].text]);
    log.push(['mcp reveal use-only', (await tool('reveal_secret', { ref: ghRef })).content[0].text]);
    log.push(['mcp reveal allowed', (await tool('reveal_secret', { ref: bbRef })).content[0].text]);
    log.push(['mcp unshared', (await tool('run_with_secrets', { command: 'true', env: { X: `vaultfill://${ids.Grafana}/password` } })).content[0].text]);
    log.push(['mcp approvals', approvals]);
    log.push(['mcp agentState', h.agentState().sessions.map((x) => x.client), h.agentState().log.map((l) => l.action)]);
    h.lock();
    log.push(['mcp after lock', (await tool('list_shared_logins', {})).content[0].text]);
    await h.unlock({ password });
    mcp.stdin.end();

    const hc = await h.health();
    log.push(['health', { breached: hc.breached.map((x) => x.name), reused: hc.reused.map((x) => x.name), weak: hc.weak.map((x) => x.name), hibpFailed: hc.hibpFailed }]);
    log.push(['status', h.status()]);
    log.push(['search git', h.search({ q: 'git' }).items.map((i) => i.name)]);
    ctx.showMain();
    await wait(2000);
    await shot(ctx.mainWin, 'main.png');
    ctx.toggleSpot();
    await wait(800);
    await typeInSpot('git');
    await wait(800);
    await shot(ctx.spotWin, 'spot.png');
    ctx.toggleSpot();
    h.lock();
    ctx.toggleSpot();
    await wait(800);
    await shot(ctx.spotWin, 'spot-locked.png');
    log.push(['unlock', await h.unlock({ password })]);
    log.push(['unlocked', h.status().unlocked]);
    ctx.toggleSpot();
    h.openMain({ view: 'new', name: 'Neue Seite' });
    await wait(1000);
    await shot(ctx.mainWin, 'new.png');
    await ctx.mainWin.webContents.executeJavaScript("document.querySelector('#cancelNew').click(); setTimeout(() => document.querySelector('#gear').click(), 300)");
    await wait(1200);
    await shot(ctx.mainWin, 'settings.png');
    await ctx.mainWin.webContents.executeJavaScript("document.querySelector('#gear').click(); setTimeout(() => document.querySelector('#healthBtn').click(), 300)");
    await wait(6000);
    await shot(ctx.mainWin, 'health.png');
    await ctx.mainWin.webContents.executeJavaScript("document.querySelector('#gear').click(); setTimeout(() => document.querySelector('#gear').click(), 300); setTimeout(() => document.querySelector('#agentsBtn').click(), 700)");
    await wait(2000);
    await shot(ctx.mainWin, 'agents.png');
  } catch (e) {
    log.push(['FAIL', e.stack]);
  }
  await writeFile(join(out, 'smoke.json'), JSON.stringify(log, null, 2));
  app.exit(0);
}
