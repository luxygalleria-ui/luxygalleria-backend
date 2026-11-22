#!/usr/bin/env node
/**
 * LOCAL MOCK of the ICICI Orange PG redirect flow, for `npm run dev`. Makes no outbound network request: everything it
 * talks to is this machine (127.0.0.1). Binds 127.0.0.1 only (never the LAN).
 *
 *   http://127.0.0.1:8442   gateway API  (backend -> mock): POST /tsp/pg/api/v2/initiateSale (JSON), POST /tsp/pg/api/command (form)
 *   https://localhost:8443  hosted payment page (browser), choose success / decline / pending UPI
 *   https://localhost:8444  the https returnURL: proxies to the backend http://127.0.0.1:<PORT> (ICICI posts the result here)
 *
 * Config: ICICI_PG_* from luxy-backend/.env (process env wins). Signs and verifies with that FAKE key only, and refuses
 * to start if the key or merchant ID equals the real UAT values in .env.uat.local, or if .env is not pointed at it.
 * TLS: a self-signed localhost certificate in the OS temp folder (created with openssl on first run). The browser asks
 * once to accept it for localhost:8443 and localhost:8444.
 *
 * Run:   node scripts/icici-local-mock.js            (with npm run dev and the frontend)
 * Then:  checkout -> Pay -> on the mock page click Success / Decline / Pending UPI.
 * Control (127.0.0.1 only): /__stats  /__txns  /__txn?txn=  /__mode?initiate=ok|html|hang|refuse&outcome=|success|decline|pending
 *   /__bank?txn=&status=SUC|REJ|REQ   (what a later STATUS check answers, e.g. a pending UPI the bank confirms)
 *   /__advice?txn=&o=success|decline  (sends the signed server-to-server payment advice to the local backend)
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const parseEnv = (file) => {
  try { return require(path.join(ROOT, 'node_modules/dotenv')).parse(fs.readFileSync(file)); } catch { return {}; }
};
const fileEnv = parseEnv(process.env.MOCK_ENV_PATH || path.join(ROOT, '.env'));
const get = (k) => (process.env[k] ?? fileEnv[k] ?? '').trim();

const HOST = '127.0.0.1';
const API_PORT = Number(process.env.MOCK_ICICI_API_PORT || 8442);
const PAGE_PORT = Number(process.env.MOCK_ICICI_PAGE_PORT || 8443);
const PROXY_PORT = Number(process.env.MOCK_ICICI_PROXY_PORT || 8444);
const BACKEND_PORT = Number(process.env.MOCK_BACKEND_PORT || get('PORT') || 5000);
const KEY = get('ICICI_PG_SECRET_KEY');
const MID = get('ICICI_PG_MERCHANT_ID');
const AGG = get('ICICI_PG_AGGREGATOR_ID');

const refuse = (why) => { console.error(`icici-local-mock: refusing to start: ${why}`); process.exit(2); };
if (!KEY || !MID) refuse('ICICI_PG_SECRET_KEY / ICICI_PG_MERCHANT_ID are not set (the mock signs with the local fake values from .env)');
const uat = parseEnv(process.env.MOCK_UAT_ENV_PATH || path.join(ROOT, '.env.uat.local'));
if ((uat.ICICI_PG_SECRET_KEY && uat.ICICI_PG_SECRET_KEY.trim() === KEY) || (uat.ICICI_PG_MERCHANT_ID && uat.ICICI_PG_MERCHANT_ID.trim() === MID)) {
  refuse('the configured key or merchant ID is the REAL UAT one: the mock only runs with fake local values');
}
for (const k of ['ICICI_PG_INITIATE_SALE_URL', 'ICICI_PG_COMMAND_URL']) {
  let u; try { u = new URL(get(k)); } catch { refuse(`${k} is not a URL`); }
  if (!['localhost', '127.0.0.1'].includes(u.hostname) || Number(u.port) !== API_PORT) refuse(`${k} does not point at this mock (http://localhost:${API_PORT})`);
}

// ---- TLS for the browser-facing servers
const tlsDir = path.join(os.tmpdir(), 'luxy-icici-mock-tls');
const keyPem = path.join(tlsDir, 'key.pem'), certPem = path.join(tlsDir, 'cert.pem');
if (!fs.existsSync(keyPem) || !fs.existsSync(certPem)) {
  fs.mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPem, '-out', certPem, '-days', '30',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  } catch { refuse('could not create a local TLS certificate (openssl is required)'); }
}
const tls = { key: fs.readFileSync(keyPem), cert: fs.readFileSync(certPem) };

// ---- ICICI hash V1 (same rule as src/utils/iciciPg.ts): non-empty values by sorted key, HMAC-SHA256, lowercase hex
const hashV1 = (p) => crypto.createHmac('sha256', KEY).update(Object.keys(p)
  .filter((k) => k !== 'secureHash' && p[k] !== null && p[k] !== undefined && p[k] !== '').sort()
  .map((k) => String(p[k])).join('').replace(/[^\x00-\x7F]/gu, '?'), 'ascii').digest('hex');
const sign = (p) => ({ ...p, secureHash: hashV1(p) });
const verified = (p) => {
  const given = Buffer.from(String(p.secureHash || '').toLowerCase()), want = Buffer.from(hashV1(p));
  return given.length === want.length && crypto.timingSafeEqual(given, want);
};

const txns = new Map(); // merchantTxnNo -> { amount, returnURL, outcome, bankStatus, txnID, request, lastResult }
const stats = { initiate: 0, initiateBadHash: 0, command: 0, commandBadHash: 0, pages: 0, advices: 0, unknownPaths: [] };
let initiateMode = 'ok'; // ok | html | hang | refuse
let autoOutcome = (process.env.MOCK_ICICI_OUTCOME || '').trim(); // '' = customer chooses on the page
let n = 0;

const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const log = (msg) => console.log(`[icici-mock] ${new Date().toISOString().slice(11, 19)} ${msg}`);

/** The signed result ICICI posts to returnURL (and in the payment advice), per scenario. */
const resultFor = (t, txnNo, outcome) => {
  const base = { merchantId: MID, ...(AGG ? { aggregatorID: AGG } : {}), merchantTxnNo: txnNo, amount: t.amount, txnID: t.txnID, paymentDateTime: '20261121120000' };
  if (outcome === 'success') return sign({ ...base, responseCode: '0000', respDescription: 'Transaction successful', paymentMode: 'CARD' });
  if (outcome === 'pending') return sign({ ...base, responseCode: 'R1000', respDescription: 'Request initiated', paymentMode: 'UPI' });
  return sign({ ...base, responseCode: 'E005', respDescription: 'Declined by bank', paymentMode: 'CARD' });
};

/** Control endpoints, served on every mock port (all bound to 127.0.0.1). */
const control = async (url, res) => {
  const txn = String(url.searchParams.get('txn') || '');
  if (url.pathname === '/__stats') return json(res, 200, { ...stats, initiateMode, autoOutcome });
  if (url.pathname === '/__txns') return json(res, 200, [...txns.keys()]);
  if (url.pathname === '/__txn') return json(res, txns.has(txn) ? 200 : 404, txns.get(txn) || {});
  if (url.pathname === '/__mode') {
    const m = url.searchParams.get('initiate'); const o = url.searchParams.get('outcome');
    if (m !== null) { if (!['ok', 'html', 'hang', 'refuse'].includes(m)) return json(res, 400, { error: 'initiate=ok|html|hang|refuse' }); initiateMode = m; }
    if (o !== null) { if (!['', 'success', 'decline', 'pending'].includes(o)) return json(res, 400, { error: 'outcome=|success|decline|pending' }); autoOutcome = o; }
    return json(res, 200, { initiateMode, autoOutcome });
  }
  if (url.pathname === '/__bank') {
    const t = txns.get(txn); const s = url.searchParams.get('status');
    if (!t || !['SUC', 'REJ', 'REQ'].includes(s)) return json(res, 400, { ok: false });
    t.bankStatus = s; log(`bank status ${txn} -> ${s}`); return json(res, 200, { ok: true });
  }
  if (url.pathname === '/__advice') { // server-to-server payment advice, to the LOCAL backend only
    const t = txns.get(txn); const o = url.searchParams.get('o') || 'success';
    if (!t || !['success', 'decline'].includes(o)) return json(res, 400, { ok: false });
    if (o === 'success') t.bankStatus = 'SUC';
    const body = new URLSearchParams(resultFor(t, txn, o)).toString();
    const status = await new Promise((resolve) => {
      const r = http.request({ host: HOST, port: BACKEND_PORT, method: 'POST', path: '/api/v1/payments/icici/payment-advice',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (x) => { x.resume(); resolve(x.statusCode); });
      r.on('error', () => resolve(0)); r.end(body);
    });
    stats.advices++; log(`advice ${txn} ${o} -> backend ${status}`);
    return json(res, 200, { ok: status === 200, backendStatus: status });
  }
  return null;
};

// ---- gateway API (backend -> mock), plain http on 127.0.0.1
const api = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${API_PORT}`);
  const raw = await readBody(req);
  if (url.pathname === '/tsp/pg/api/v2/initiateSale' && req.method === 'POST') {
    stats.initiate++;
    let p = {}; try { p = JSON.parse(raw || '{}'); } catch { /* refused below */ }
    if (!verified(p) || p.merchantId !== MID || (AGG && p.aggregatorID !== AGG)) {
      stats.initiateBadHash++; log(`initiateSale REFUSED (secureHash / merchant) ${p.merchantTxnNo || '-'}`);
      return json(res, 200, sign({ responseCode: 'P1006', respDescription: 'Invalid secure hash', merchantId: MID }));
    }
    if (initiateMode === 'html') { res.writeHead(403, { 'Content-Type': 'text/html' }); return res.end('<html>Request Rejected</html>'); }
    if (initiateMode === 'hang') return log(`initiateSale ${p.merchantTxnNo}: hanging (mode=hang)`);
    if (initiateMode === 'refuse') return json(res, 200, sign({ responseCode: 'P1001', respDescription: 'Mock refusal', merchantId: MID, merchantTxnNo: p.merchantTxnNo }));
    txns.set(p.merchantTxnNo, { amount: p.amount, returnURL: p.returnURL, outcome: null, bankStatus: null, txnID: `MOCKTXN${++n}`, request: p });
    log(`initiateSale ${p.merchantTxnNo} amount ${p.amount} -> R1000`);
    return json(res, 200, sign({ responseCode: 'R1000', merchantId: MID, aggregatorID: null, merchantTxnNo: p.merchantTxnNo,
      redirectURI: `https://localhost:${PAGE_PORT}/tsp/pg/api/v2/authRedirect`, showOTPCapturePage: 'N', generateOTPURI: null,
      verifyOTPURI: null, authorizeURI: null, tranCtx: `CTX-${p.merchantTxnNo}` }));
  }
  if (url.pathname === '/tsp/pg/api/command' && req.method === 'POST') {
    stats.command++;
    const p = Object.fromEntries(new URLSearchParams(raw));
    if (!verified(p) || p.merchantId !== MID) { stats.commandBadHash++; return json(res, 200, sign({ responseCode: 'P1006', respDescription: 'Invalid secure hash', merchantId: MID })); }
    const t = txns.get(p.originalTxnNo);
    if (!t) return json(res, 200, sign({ responseCode: 'E001', respDescription: 'Transaction not found', merchantId: MID }));
    if (p.transactionType === 'REFUND') {
      log(`REFUND ${p.originalTxnNo} amount ${p.amount} -> processed`);
      return json(res, 200, sign({ responseCode: '000', respDescription: 'Request processed successfully', merchantId: MID, merchantTxnNo: p.merchantTxnNo, txnID: `MOCKRF${++n}` }));
    }
    if (p.transactionType !== 'STATUS') return json(res, 200, sign({ responseCode: 'E002', respDescription: 'Unsupported transactionType', merchantId: MID }));
    const s = t.bankStatus || (t.outcome === 'success' ? 'SUC' : t.outcome === 'decline' ? 'REJ' : 'REQ');
    log(`STATUS ${p.originalTxnNo} -> ${s}`);
    return json(res, 200, sign({ responseCode: '000', respDescription: 'Request processed', merchantId: MID, merchantTxnNo: p.merchantTxnNo,
      originalTxnNo: p.originalTxnNo, txnStatus: s, txnResponseCode: s === 'SUC' ? '0000' : s === 'REQ' ? 'R1000' : 'E005', txnID: t.txnID, amount: t.amount }));
  }
  if (await control(url, res) === null) { stats.unknownPaths.push(`${req.method} ${url.pathname}`); json(res, 404, { error: 'unknown mock path' }); }
});

// ---- hosted payment page (browser), https
const page = https.createServer(tls, async (req, res) => {
  const url = new URL(req.url, `https://localhost:${PAGE_PORT}`);
  if (url.pathname === '/tsp/pg/api/v2/authRedirect') {
    stats.pages++;
    const txnNo = String(url.searchParams.get('tranCtx') || '').replace(/^CTX-/, '');
    const t = txns.get(txnNo);
    if (!t) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('Unknown tranCtx'); }
    if (autoOutcome) { res.writeHead(302, { Location: `/choose?txn=${encodeURIComponent(txnNo)}&o=${autoOutcome}` }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><title>MOCK ICICI payment</title><style>body{font-family:system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem}
      a{display:block;margin:.6rem 0;padding:.8rem 1rem;border:1px solid #999;border-radius:.5rem;text-decoration:none;color:#111}</style></head><body>
      <h1>MOCK ICICI payment page</h1><p><strong>Local test gateway: no real money moves.</strong></p>
      <p>Order ${esc(txnNo)} &middot; <span id="amount">INR ${esc(t.amount)}</span></p>
      <a id="pay-success" href="/choose?txn=${encodeURIComponent(txnNo)}&o=success">Pay successfully (card)</a>
      <a id="pay-decline" href="/choose?txn=${encodeURIComponent(txnNo)}&o=decline">Decline (bank refuses)</a>
      <a id="pay-pending" href="/choose?txn=${encodeURIComponent(txnNo)}&o=pending">Pending UPI (approve later via /__bank or /__advice)</a>
      </body></html>`);
  }
  if (url.pathname === '/choose') {
    const txnNo = String(url.searchParams.get('txn') || ''); const o = String(url.searchParams.get('o') || '');
    const t = txns.get(txnNo);
    if (!t || !['success', 'decline', 'pending'].includes(o)) { res.writeHead(400); return res.end(); }
    t.outcome = o; const fields = resultFor(t, txnNo, o); t.lastResult = fields;
    log(`customer chose ${o} for ${txnNo} -> posting to returnURL`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><body onload="document.forms[0].submit()"><p>Returning to the shop…</p><form method="POST" action="${esc(t.returnURL)}">${
      Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}<noscript><button>Continue</button></noscript></form></body></html>`);
  }
  if (await control(url, res) === null) { stats.unknownPaths.push(`${req.method} ${url.pathname}`); res.writeHead(404); res.end(); }
});

// ---- https returnURL -> local backend (http://127.0.0.1:<PORT>)
const proxy = https.createServer(tls, (req, res) => {
  const up = http.request({ host: HOST, port: BACKEND_PORT, method: req.method, path: req.url,
    headers: { ...req.headers, host: `localhost:${BACKEND_PORT}`, 'x-forwarded-proto': 'https' } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end(`Local backend on port ${BACKEND_PORT} not reachable: ${e.code || e.message}`); });
  req.pipe(up);
});

let up = 0;
const ready = () => { if (++up === 3) log(`ready: API http://${HOST}:${API_PORT}  page https://localhost:${PAGE_PORT}  returnURL proxy https://localhost:${PROXY_PORT} -> backend :${BACKEND_PORT}`); };
for (const [srv, port] of [[api, API_PORT], [page, PAGE_PORT], [proxy, PROXY_PORT]]) {
  srv.on('error', (e) => refuse(`port ${port}: ${e.code || e.message}`));
  srv.listen(port, HOST, ready);
}
