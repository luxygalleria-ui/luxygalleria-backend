#!/usr/bin/env node
/**
 * LOCAL MOCK of the ICICI Orange PG redirect flow, for `npm run dev`. Makes no outbound network request: everything it
 * talks to is this machine (127.0.0.1). Binds 127.0.0.1 only (never the LAN).
 *
 *   http://127.0.0.1:8442   gateway API  (backend -> mock): POST /tsp/pg/api/v2/initiateSale (JSON), POST /tsp/pg/api/command (form)
 *   http://localhost:8443   hosted payment page (browser), choose success / decline / pending UPI
 *   http://localhost:8444   the returnURL: proxies to the backend http://127.0.0.1:<PORT> (ICICI posts the result here)
 *
 * Config: ICICI_PG_* from luxy-backend/.env (process env wins). Signs and verifies with that FAKE key only, and refuses
 * to start if the key or merchant ID equals the real UAT values in .env.uat.local, or if .env is not pointed at it.
 * Plain http on 127.0.0.1 only (no TLS, so no "Your connection is not private" page). The backend accepts an http
 * payment page only in NODE_ENV=development on a loopback host; production keeps requiring https ICICI hosts.
 *
 * Run:   node scripts/icici-local-mock.js            (with npm run dev and the frontend)
 * Then:  checkout -> Pay -> on the mock page click Success / Decline / Pending UPI.
 * Control (127.0.0.1 only): /__stats  /__txns  /__txn?txn=  /__mode?initiate=ok|html|hang|refuse&outcome=|success|decline|pending
 *   /__bank?txn=&status=SUC|REJ|REQ   (what a later STATUS check answers, e.g. a pending UPI the bank confirms)
 *   /__advice?txn=&o=success|decline  (sends the signed server-to-server payment advice to the local backend)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
      redirectURI: `http://localhost:${PAGE_PORT}/tsp/pg/api/v2/authRedirect`, showOTPCapturePage: 'N', generateOTPURI: null,
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

// ---- hosted payment page markup (presentation only: the outcome still goes through /choose, unchanged)
/**
 * A clearly labelled LOCAL MOCK checkout page (not ICICI's page, no bank logos). The demo inputs have no `name` and sit
 * in no form, so nothing typed is ever submitted, stored or logged: "Pay securely" only shows a short processing state
 * and then opens the existing /choose?txn=&o= URL with the selected test outcome. Every dynamic value is escaped.
 */
const paymentPageHtml = (txnNo, t) => {
  const choose = (o) => esc(`/choose?txn=${encodeURIComponent(txnNo)}&o=${o}`);
  const amount = esc(t.amount);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,">
<title>Luxy Galleria · Local mock payment</title>
<style>
:root{--navy:#0b1f3a;--navy2:#1b3458;--ink:#22324a;--muted:#6b7a90;--line:#e3e8ef;--soft:#f6f8fb;--orange:#e8772e;--orange2:#fff3ea;--ok:#1f8a4c;--bad:#c0392b;--warn:#b7791f}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.notice{background:var(--orange2);color:#8a3d0c;border-bottom:1px solid #f6d3b8;text-align:center;padding:.6rem 1rem;font-weight:600;font-size:13px;letter-spacing:.02em}
.top{border-bottom:1px solid var(--line);background:#fff}.top .in{max-width:960px;margin:0 auto;padding:1rem 1.25rem;display:flex;align-items:center;justify-content:space-between;gap:1rem}
.brand{display:flex;align-items:center;gap:.7rem}.mark{width:36px;height:36px;border-radius:9px;background:var(--navy);color:#fff;display:grid;place-items:center;font-weight:800;letter-spacing:.04em}
.brand b{display:block;color:var(--navy);font-size:16px}.brand small{color:var(--muted);font-size:12px}
.badge{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--orange);border:1px solid #f3c39f;border-radius:999px;padding:.25rem .6rem;white-space:nowrap}
.wrap{max-width:960px;margin:1.5rem auto 3rem;padding:0 1.25rem;display:grid;grid-template-columns:1fr 320px;gap:1.5rem;align-items:start}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 6px 24px rgba(11,31,58,.06)}
.pay{padding:1.25rem}.h{color:var(--navy);font-size:18px;font-weight:700;margin:0 0 1rem}
.tabs{display:flex;gap:.4rem;background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:.3rem;margin-bottom:1.1rem}
.tab{flex:1;border:0;background:transparent;border-radius:9px;padding:.65rem .5rem;font:inherit;font-weight:600;color:var(--muted);cursor:pointer}
.tab[aria-selected="true"]{background:#fff;color:var(--navy);box-shadow:0 1px 4px rgba(11,31,58,.12)}
.panel{display:none}.panel.on{display:block}
label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin:.2rem 0 .35rem;text-transform:uppercase;letter-spacing:.04em}
input,select{width:100%;border:1px solid var(--line);border-radius:10px;padding:.75rem .85rem;font:inherit;color:var(--navy);background:#fff;outline:none}
input:focus,select:focus{border-color:var(--navy2);box-shadow:0 0 0 3px rgba(27,52,88,.12)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:.8rem}.f{margin-bottom:.85rem}
.demo{font-size:12px;color:var(--muted);margin:-.2rem 0 .9rem}.demo b{color:var(--orange)}
.qr{display:flex;gap:1rem;align-items:center;border:1px dashed var(--line);border-radius:12px;padding:.9rem;margin:.2rem 0 .9rem;background:var(--soft)}
.qrbox{width:96px;height:96px;flex:none;border-radius:8px;background:#fff;border:1px solid var(--line);
  background-image:linear-gradient(90deg,var(--navy) 50%,transparent 50%),linear-gradient(var(--navy) 50%,transparent 50%);background-size:12px 12px,12px 12px;opacity:.85}
.banks{display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-bottom:.9rem}
.bank{border:1px solid var(--line);border-radius:10px;padding:.7rem .8rem;cursor:pointer;display:flex;gap:.55rem;align-items:center;font-weight:600;color:var(--navy);background:#fff}
.bank input{width:auto;margin:0}.bank:has(input:checked){border-color:var(--navy2);box-shadow:0 0 0 3px rgba(27,52,88,.1)}
.btn{width:100%;border:0;border-radius:12px;padding:.95rem 1rem;font:inherit;font-weight:700;font-size:16px;cursor:pointer;background:var(--navy);color:#fff}
.btn:hover{background:var(--navy2)}.btn[disabled]{opacity:.7;cursor:wait}
.btn.ghost{background:#fff;color:var(--navy);border:1px solid var(--line);font-size:14px;padding:.75rem}
.two{display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-bottom:.9rem}
.secure{display:flex;align-items:center;justify-content:center;gap:.4rem;color:var(--muted);font-size:12px;margin-top:.75rem}
.sum{padding:1.25rem}.sum dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:.55rem .8rem;font-size:14px}.sum dt{color:var(--muted)}.sum dd{margin:0;text-align:right;color:var(--navy);font-weight:600;word-break:break-all}
.total{border-top:1px solid var(--line);margin-top:1rem;padding-top:1rem;display:flex;justify-content:space-between;align-items:baseline}
.total span{color:var(--muted)}.total b{font-size:26px;color:var(--navy)}
.test{margin-top:1rem;padding:1rem 1.25rem;background:var(--soft);border-radius:16px;border:1px solid var(--line)}
.test h3{margin:0 0 .25rem;font-size:13px;color:var(--navy);text-transform:uppercase;letter-spacing:.06em}.test p{margin:0 0 .7rem;font-size:12px;color:var(--muted)}
.seg{display:flex;gap:.4rem}.seg a{flex:1;text-align:center;text-decoration:none;border:1px solid var(--line);background:#fff;border-radius:9px;padding:.55rem .3rem;font-size:13px;font-weight:600;color:var(--ink)}
.seg a[aria-pressed="true"]{border-color:var(--navy2);color:var(--navy);box-shadow:0 0 0 3px rgba(27,52,88,.1)}
.seg a.s::before{content:"● ";color:var(--ok)}.seg a.d::before{content:"● ";color:var(--bad)}.seg a.p::before{content:"● ";color:var(--warn)}
.proc{display:none;position:fixed;inset:0;background:rgba(255,255,255,.92);align-items:center;justify-content:center;flex-direction:column;gap:1rem;color:var(--navy);font-weight:600;z-index:9}
.proc.on{display:flex}.spin{width:44px;height:44px;border-radius:50%;border:4px solid var(--line);border-top-color:var(--orange);animation:r 0.9s linear infinite}@keyframes r{to{transform:rotate(360deg)}}
@media (max-width:760px){.wrap{grid-template-columns:1fr;margin-top:1rem}.badge{display:none}.row,.banks{grid-template-columns:1fr 1fr}}
@media (max-width:380px){.row,.banks,.two{grid-template-columns:1fr}}
</style></head><body>
<div class="notice" role="note">LOCAL TEST ENVIRONMENT — No real money will be charged.</div>
<header class="top"><div class="in"><div class="brand"><div class="mark">LG</div><div><b>Luxy Galleria</b><small>Secure checkout · local mock payment gateway</small></div></div>
<span class="badge">Local mock · not a bank page</span></div></header>
<main class="wrap" data-txn="${esc(encodeURIComponent(txnNo))}">
<section class="card pay" aria-label="Payment">
  <h1 class="h">Choose a payment method</h1>
  <div class="tabs" role="tablist">
    <button class="tab" role="tab" aria-selected="true" data-tab="card">Card</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="upi">UPI</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="nb">Net Banking</button>
  </div>
  <!-- Demo inputs: no name attribute and no form, so nothing typed here is ever submitted, stored or logged -->
  <div class="panel on" data-panel="card">
    <p class="demo"><b>Demo only.</b> Do not enter real card details; any value works and none is sent.</p>
    <div class="f"><label for="cn">Card number (demo)</label><input id="cn" inputmode="numeric" autocomplete="off" placeholder="4111 1111 1111 1111"></div>
    <div class="row"><div class="f"><label for="ce">Expiry (demo)</label><input id="ce" autocomplete="off" placeholder="12/30"></div>
      <div class="f"><label for="cv">CVV (demo)</label><input id="cv" inputmode="numeric" autocomplete="off" placeholder="123" maxlength="4"></div></div>
    <div class="f"><label for="ch">Cardholder name (demo)</label><input id="ch" autocomplete="off" placeholder="Demo Customer"></div>
  </div>
  <div class="panel" data-panel="upi">
    <p class="demo"><b>Demo only.</b> Do not enter a real UPI ID; nothing is sent.</p>
    <div class="f"><label for="vpa">UPI ID (demo)</label><input id="vpa" autocomplete="off" placeholder="demo@upi"></div>
    <div class="qr"><div class="qrbox" aria-hidden="true"></div><div><b style="color:var(--navy)">Scan to pay (simulated)</b><div class="demo" style="margin:.3rem 0 0">A placeholder pattern, not a real QR code.</div></div></div>
    <div class="two"><button class="btn ghost" type="button" data-go="success">Approve in UPI app</button><button class="btn ghost" type="button" data-go="pending">Leave pending</button></div>
  </div>
  <div class="panel" data-panel="nb">
    <p class="demo"><b>Demo only.</b> Fictional banks; no bank is contacted and no login is asked for.</p>
    <div class="banks" role="radiogroup" aria-label="Demo bank">
      ${['Demo National Bank', 'Sample Co-operative Bank', 'Test Federal Bank', 'Example Gramin Bank'].map((b, i) => `<label class="bank"><input type="radio" name="demo-bank" ${i === 0 ? 'checked' : ''}>${esc(b)}</label>`).join('')}
    </div>
  </div>
  <button class="btn" type="button" id="pay-now">Pay securely ₹${amount}</button>
  <div class="secure">🔒 Local mock gateway · nothing leaves this computer</div>
</section>
<aside>
  <section class="card sum" aria-label="Order summary">
    <h2 class="h" style="font-size:16px">Order summary</h2>
    <dl><dt>Merchant</dt><dd>Luxy Galleria</dd><dt>Order reference</dt><dd id="order-ref">${esc(txnNo)}</dd><dt>Currency</dt><dd>INR</dd></dl>
    <div class="total"><span>Amount payable</span><b id="amount">₹${amount}</b></div>
  </section>
  <section class="test" aria-label="Test outcome">
    <h3>Test outcome</h3><p>Local testing only: what "Pay securely" will simulate. Each link also completes the payment directly.</p>
    <div class="seg">
      <a id="pay-success" class="s" href="${choose('success')}" data-o="success" aria-pressed="true">Success</a>
      <a id="pay-decline" class="d" href="${choose('decline')}" data-o="decline" aria-pressed="false">Declined</a>
      <a id="pay-pending" class="p" href="${choose('pending')}" data-o="pending" aria-pressed="false">Pending</a>
    </div>
  </section>
</aside>
</main>
<div class="proc" id="proc" role="status" aria-live="polite"><div class="spin"></div><div>Processing your payment…</div><div style="font-size:12px;color:var(--muted)">Local mock · no real money</div></div>
<script>
(() => {
  const txn = document.querySelector('main').dataset.txn; // already URL-encoded on the server
  let outcome = 'success';
  const go = (o) => { document.getElementById('proc').classList.add('on'); document.getElementById('pay-now').disabled = true;
    setTimeout(() => { location.href = '/choose?txn=' + txn + '&o=' + encodeURIComponent(o); }, 1200); };
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('on', p.dataset.panel === t.dataset.tab));
  }));
  // The test-outcome links select what "Pay securely" simulates (they still work as plain links without script)
  document.querySelectorAll('.seg a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); outcome = a.dataset.o;
    document.querySelectorAll('.seg a').forEach((x) => x.setAttribute('aria-pressed', String(x === a))); }));
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
  document.getElementById('pay-now').addEventListener('click', () => go(outcome));
})();
</script>
</body></html>`;
};

// ---- hosted payment page (browser), plain http on loopback (no self-signed certificate warning)
const page = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PAGE_PORT}`);
  if (url.pathname === '/tsp/pg/api/v2/authRedirect') {
    stats.pages++;
    const txnNo = String(url.searchParams.get('tranCtx') || '').replace(/^CTX-/, '');
    const t = txns.get(txnNo);
    if (!t) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('Unknown tranCtx'); }
    if (autoOutcome) { res.writeHead(302, { Location: `/choose?txn=${encodeURIComponent(txnNo)}&o=${autoOutcome}` }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(paymentPageHtml(txnNo, t));
  }
  if (url.pathname === '/choose') {
    const txnNo = String(url.searchParams.get('txn') || ''); const o = String(url.searchParams.get('o') || '');
    const t = txns.get(txnNo);
    if (!t || !['success', 'decline', 'pending'].includes(o)) { res.writeHead(400); return res.end(); }
    t.outcome = o; const fields = resultFor(t, txnNo, o); t.lastResult = fields;
    log(`customer chose ${o} for ${txnNo} -> posting to returnURL`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><link rel="icon" href="data:,"></head><body onload="document.forms[0].submit()"><p>Returning to the shop…</p><form method="POST" action="${esc(t.returnURL)}">${
      Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}<noscript><button>Continue</button></noscript></form></body></html>`);
  }
  if (await control(url, res) === null) { stats.unknownPaths.push(`${req.method} ${url.pathname}`); res.writeHead(404); res.end(); }
});

// ---- returnURL -> local backend (http://127.0.0.1:<PORT>)
const proxy = http.createServer((req, res) => {
  const up = http.request({ host: HOST, port: BACKEND_PORT, method: req.method, path: req.url,
    headers: { ...req.headers, host: `localhost:${BACKEND_PORT}`, 'x-forwarded-proto': 'http' } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end(`Local backend on port ${BACKEND_PORT} not reachable: ${e.code || e.message}`); });
  req.pipe(up);
});

let up = 0;
const ready = () => { if (++up === 3) log(`ready: API http://${HOST}:${API_PORT}  page http://localhost:${PAGE_PORT}  returnURL proxy http://localhost:${PROXY_PORT} -> backend :${BACKEND_PORT}`); };
for (const [srv, port] of [[api, API_PORT], [page, PAGE_PORT], [proxy, PROXY_PORT]]) {
  srv.on('error', (e) => refuse(`port ${port}: ${e.code || e.message}`));
  srv.listen(port, HOST, ready);
}
