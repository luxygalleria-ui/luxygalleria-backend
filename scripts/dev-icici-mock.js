#!/usr/bin/env node
/**
 * LOCAL checkout with the ICICI MOCK, in order: mock gateway -> backend -> storefront.   npm run dev:icici-mock
 *
 *   1. scripts/icici-local-mock.js   API http://127.0.0.1:8442, payment page https://localhost:8443, returnURL https://localhost:8444
 *   2. backend (ts-node-dev)         http://localhost:5000, NODE_ENV=development (real *.icicibank.com hosts are refused)
 *   3. storefront (next dev)         http://localhost:3000, NEXT_PUBLIC_ICICI_MOCK_ORIGIN=https://localhost:8443, so the
 *                                    checkout may redirect to the mock page (next dev only; production builds never do)
 *
 * Each step starts only after the previous one answers its health check. Busy ports, a mock that refuses its config
 * (e.g. real UAT keys) or any service that exits stop everything with a clear message. Ctrl+C stops all three.
 * No real ICICI request is possible: the mock refuses to start unless .env points ICICI_PG_* at it with fake keys, and
 * ICICI_PG_ALLOW_REAL_GATEWAY_IN_DEV is removed from every child.
 *
 * Ports and paths (optional): MOCK_ICICI_API_PORT / MOCK_ICICI_PAGE_PORT / MOCK_ICICI_PROXY_PORT, PORT (backend),
 * FRONTEND_PORT, LUXY_FRONTEND_DIR (default ../luxy-frontend). Other variables pass through (process env wins over .env).
 * Real ICICI UAT instead of the mock: npm run dev:icici-uat (unchanged).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.resolve(process.env.LUXY_FRONTEND_DIR || path.join(ROOT, '..', 'luxy-frontend'));
let fileEnv = {};
try { fileEnv = require(path.join(ROOT, 'node_modules/dotenv')).parse(fs.readFileSync(path.join(ROOT, '.env'))); } catch { /* the mock reports it */ }
const num = (k, d) => Number(process.env[k] || d);
const API_PORT = num('MOCK_ICICI_API_PORT', 8442), PAGE_PORT = num('MOCK_ICICI_PAGE_PORT', 8443), PROXY_PORT = num('MOCK_ICICI_PROXY_PORT', 8444);
const BACKEND_PORT = num('PORT', fileEnv.PORT || 5000), FRONTEND_PORT = num('FRONTEND_PORT', 3000);
const MOCK_ORIGIN = `https://localhost:${PAGE_PORT}`;

const say = (msg) => console.log(`[dev:icici-mock] ${msg}`);
const children = [];
let stopping = false;

const stopAll = (code) => {
  if (stopping) return;
  stopping = true;
  say(code ? 'stopping everything (see the error above)' : 'stopping…');
  for (const c of children) if (c.exitCode === null) { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* already gone */ } }
  const force = setTimeout(() => { for (const c of children) if (c.exitCode === null) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } } }, 5000);
  const done = () => { if (children.every((c) => c.exitCode !== null || c.signalCode !== null)) { clearTimeout(force); process.exit(code); } };
  children.forEach((c) => c.once('exit', done));
  done();
};
const fail = (msg) => { console.error(`[dev:icici-mock] ERROR: ${msg}`); stopAll(1); };
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

/** Starts a service in its own process group (so Ctrl+C reaches everything it spawns), prefixing its output. */
const start = (name, cmd, args, opts) => {
  const c = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const pipe = (s, out) => { let buf = ''; s.on('data', (d) => { buf += d; const lines = buf.split('\n'); buf = lines.pop(); for (const l of lines) out.write(`[${name}] ${l}\n`); }); };
  pipe(c.stdout, process.stdout); pipe(c.stderr, process.stderr);
  c.on('error', (e) => fail(`${name} could not start: ${e.message}`));
  c.on('exit', (code, sig) => { if (!stopping) fail(`${name} exited (${sig || `code ${code}`})`); });
  children.push(c);
  return c;
};

/** True if something already accepts connections on the port (IPv4 or IPv6 loopback). */
const busy = (port) => Promise.all(['127.0.0.1', '::1'].map((host) => new Promise((resolve) => {
  const s = net.connect({ port, host });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
  s.setTimeout(1000, () => { s.destroy(); resolve(false); });
}))).then((r) => r.some(Boolean));

/** Waits until url answers (any HTTP status if anyStatus, else 2xx), or the service exits, or the timeout passes. */
const waitFor = async (name, url, child, timeoutMs, anyStatus = false) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (stopping || child.exitCode !== null) return false;
    try { const r = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'manual' }); if (anyStatus || r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`${name} did not answer ${url} within ${Math.round(timeoutMs / 1000)} s`);
  return false;
};

(async () => {
  if (!fs.existsSync(path.join(FRONTEND_DIR, 'package.json'))) return fail(`storefront not found at ${FRONTEND_DIR} (set LUXY_FRONTEND_DIR)`);
  const ports = [[API_PORT, 'mock gateway API'], [PAGE_PORT, 'mock payment page'], [PROXY_PORT, 'mock returnURL proxy'], [BACKEND_PORT, 'backend'], [FRONTEND_PORT, 'storefront']];
  const taken = [];
  for (const [p, what] of ports) if (await busy(p)) taken.push(`${p} (${what})`);
  if (taken.length) return fail(`port(s) already in use: ${taken.join(', ')}. Stop the other process first (e.g. a separate npm run dev or next dev; find it with: lsof -nP -iTCP:<port> -sTCP:LISTEN)`);

  // Children never get the real-gateway opt-in; the backend always runs in development (its guards depend on it)
  const base = { ...process.env };
  delete base.ICICI_PG_ALLOW_REAL_GATEWAY_IN_DEV;
  delete base.DOTENV_CONFIG_PATH;

  say(`1/3 ICICI mock gateway (API :${API_PORT}, page :${PAGE_PORT}, returnURL :${PROXY_PORT})`);
  const mock = start('mock', process.execPath, [path.join(__dirname, 'icici-local-mock.js')], { cwd: ROOT, env: { ...base, MOCK_BACKEND_PORT: String(BACKEND_PORT) } });
  if (!await waitFor('mock gateway', `http://127.0.0.1:${API_PORT}/__stats`, mock, 15_000)) return;
  say('    mock gateway is up');

  say(`2/3 backend on :${BACKEND_PORT} (NODE_ENV=development)`);
  const backend = start('api', path.join(ROOT, 'node_modules/.bin/ts-node-dev'), ['--respawn', '--transpile-only', 'src/server.ts'],
    { cwd: ROOT, env: { ...base, NODE_ENV: 'development', PORT: String(BACKEND_PORT) } });
  if (!await waitFor('backend', `http://127.0.0.1:${BACKEND_PORT}/api/v1/health`, backend, 90_000)) return;
  say('    backend is up');

  say(`3/3 storefront on :${FRONTEND_PORT} (mock payment page ${MOCK_ORIGIN} allowed under next dev)`);
  const web = start('web', path.join(FRONTEND_DIR, 'node_modules/.bin/next'), ['dev', '--port', String(FRONTEND_PORT), '--webpack'],
    { cwd: FRONTEND_DIR, env: { ...base, NODE_ENV: 'development', NEXT_PUBLIC_ICICI_MOCK_ORIGIN: MOCK_ORIGIN, NEXT_PUBLIC_API_URL: `http://localhost:${BACKEND_PORT}/api/v1` } });
  if (!await waitFor('storefront', `http://localhost:${FRONTEND_PORT}/`, web, 180_000, true)) return;

  say('READY');
  say(`  shop:        http://localhost:${FRONTEND_PORT}  (sign in, add to cart, checkout, pay)`);
  say(`  mock page:   ${MOCK_ORIGIN}  (accept the self-signed certificate once for :${PAGE_PORT} and :${PROXY_PORT})`);
  say(`  mock state:  http://127.0.0.1:${API_PORT}/__stats   outcome: /__mode?outcome=success|decline|pending`);
  say('  Ctrl+C stops all three.');
})().catch((e) => fail(e?.message || String(e)));
