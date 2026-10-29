// Vaultfill MCP server (stdio, JSON-RPC per line), run by the agent with the system Node:
//   claude mcp add vaultfill -e VAULTFILL_SOCKET=<socket> -- <node> <this file>
// Talks to the running Vaultfill app over a Unix socket that only the current user can open. The app asks the
// user (dialog + Touch ID) before the first call of each agent session and confirms commands that get secrets.
// Commands run here — with the agent's own macOS permissions, not Vaultfill's.
const net = require('node:net');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const MAX_OUTPUT = 50_000;
const running = new Set(); // child processes (own process groups)
const killTree = (p, sig) => { try { process.kill(-p.pid, sig); } catch {} };

const SOCKET = process.env.VAULTFILL_SOCKET;
const REF = 'vaultfill://<id>/<username|password|totp>';

const TOOLS = [
  {
    name: 'list_shared_logins',
    description: 'Lists the Vaultfill logins the user shared with agents: name, username, URL and secret references. Never returns passwords.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'run_with_secrets',
    description: `Runs a shell command (zsh -lc) with shared secrets injected as environment variables, e.g. env {"TEST_PASSWORD": "${REF.replace('<username|password|totp>', 'password')}"}. `
      + 'Use this for automated tests instead of reading secrets. The user confirms the command in Vaultfill. Secrets in the output are replaced by •••. Returns exit code and output (tail).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command, e.g. "npx playwright test"' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: `Variable name → secret reference (${REF}). Plain values are passed through.` },
        cwd: { type: 'string', description: 'Working directory (default: the agent\'s project directory)' },
        timeout_seconds: { type: 'number', description: 'Default 600, max 3600' },
      },
      required: ['command'],
    },
  },
  {
    name: 'reveal_secret',
    description: 'Returns one secret in plain text. Only works for logins the user explicitly allowed for plain-text access, and the user has to confirm every call with Touch ID. Prefer run_with_secrets.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string', description: REF } }, required: ['ref'] },
  },
];

let conn, buf = '', seq = 0, clientName = 'agent';
const waiting = new Map();

function connect() {
  if (conn) return conn;
  conn = new Promise((resolve, reject) => {
    if (!SOCKET) return reject(new Error('VAULTFILL_SOCKET is not set'));
    const s = net.createConnection(SOCKET);
    s.on('connect', () => resolve(s));
    s.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
        const msg = JSON.parse(buf.slice(0, i));
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
      }
    });
    s.on('error', () => reject(new Error('Vaultfill is not running (start and unlock the app)')));
    s.on('close', () => {
      conn = null; // app locked or quit: the next call pairs again
      for (const p of running) killTree(p, 'SIGKILL'); // secrets must not outlive the session
      for (const done of waiting.values()) done({ error: 'Connection to Vaultfill closed' });
      waiting.clear();
    });
  }).then(async (s) => {
    await request(s, 'hello', { client: clientName, cwd: process.cwd(), pid: process.pid });
    return s;
  }).catch((e) => { conn = null; throw e; });
  return conn;
}

function request(s, method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, (msg) => msg.error ? reject(new Error(msg.error)) : resolve(msg.result));
    s.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

// Replaces every secret (and its URL/base64 encodings). Deliberately transformed output (reversed, split, …)
// is not caught — this guards against accidents, not against a hostile agent.
function redact(text, secrets) {
  for (const s of secrets.filter((x) => x.length >= 3)) {
    for (const variant of new Set([s, encodeURIComponent(s), Buffer.from(s).toString('base64')])) text = text.replaceAll(variant, '•••');
  }
  return text;
}

async function runWithSecrets({ command, env = {}, cwd, timeout_seconds: timeout = 600 }) {
  const refs = {}, plain = {};
  for (const [k, val] of Object.entries(env || {})) (String(val).startsWith('vaultfill://') ? refs : plain)[k] = String(val);
  const { values } = await request(await connect(), 'resolve', { command, env: refs });
  const secrets = Object.values(values);
  return new Promise((resolve) => {
    const p = spawn('/bin/zsh', ['-lc', command], { cwd: cwd || process.cwd(), env: { ...process.env, ...plain, ...values }, detached: true });
    running.add(p);
    let out = '';
    const add = (d) => { out = (out + d).slice(-MAX_OUTPUT * 40); };
    p.stdout.on('data', add);
    p.stderr.on('data', add);
    const timer = setTimeout(() => { killTree(p, 'SIGTERM'); setTimeout(() => killTree(p, 'SIGKILL'), 5000); }, Math.min(Math.max(+timeout || 600, 1), 3600) * 1000);
    const done = (result) => { clearTimeout(timer); running.delete(p); killTree(p, 'SIGKILL'); resolve(JSON.stringify(result, null, 2)); };
    p.on('error', (e) => done({ exit_code: -1, output: redact(e.message, secrets) }));
    p.on('close', (code, signal) => done({ exit_code: code ?? -1, ...(signal ? { killed_by: signal } : {}), output: redact(out, secrets).slice(-MAX_OUTPUT) }));
  });
}

async function callTool(name, args) {
  if (name === 'run_with_secrets') return runWithSecrets(args);
  const method = { list_shared_logins: 'list', reveal_secret: 'reveal' }[name];
  if (!method) throw new Error(`Unknown tool ${name}`);
  const result = await request(await connect(), method, args);
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

async function handle({ method, params }) {
  switch (method) {
    case 'initialize':
      clientName = params?.clientInfo?.name || clientName;
      return {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'vaultfill', version: '0.1.0' },
        instructions: 'Shared test credentials from the user\'s Vaultfill vault. Use run_with_secrets to pass secrets to commands; do not try to print or exfiltrate them.',
      };
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS };
    case 'tools/call':
      try {
        return { content: [{ type: 'text', text: await callTool(params.name, params.arguments || {}) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    default: throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  if (msg.id === undefined) return; // notification
  try { send({ id: msg.id, result: await handle(msg) }); } catch (e) { send({ id: msg.id, error: { code: e.code || -32603, message: e.message } }); }
}).on('close', () => { for (const p of running) killTree(p, 'SIGKILL'); process.exit(0); });
