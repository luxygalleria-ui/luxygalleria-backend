/**
 * scripts/icici-local-mock.js: signs/verifies like ICICI with the FAKE key, deterministic success / decline / pending
 * UPI, STATUS + advice + returnURL proxy, localhost-only binding, no outbound requests, refuses real UAT values.
 * Runs the script as a child process on spare ports with a tiny fake backend. No database, no network.
 * Run: npx ts-node --transpile-only src/tests/iciciMock.test.ts
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import { spawn, spawnSync, ChildProcess } from 'child_process';

const KEY = 'mock_test_fake_key_not_real';
const MID = 'MOCKTEST0000001';
const AGG = 'AMOCKTEST000001';
Object.assign(process.env, { ICICI_PG_SECRET_KEY: KEY, ICICI_PG_MERCHANT_ID: MID });
import { signed, verifyV1 } from '../utils/iciciPg';

const SCRIPT = path.resolve(__dirname, '../../scripts/icici-local-mock.js');
const [API, PAGE, PROXY, BACKEND] = [18442, 18443, 18444, 18445];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icici-mock-test-'));
const uatFile = path.join(tmp, 'uat.env');
fs.writeFileSync(uatFile, 'ICICI_PG_SECRET_KEY=a-different-real-looking-key\nICICI_PG_MERCHANT_ID=100000000000999\n');
const baseEnv = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: os.tmpdir(),
  MOCK_ENV_PATH: path.join(tmp, 'no-such.env'), MOCK_UAT_ENV_PATH: uatFile,
  MOCK_ICICI_API_PORT: String(API), MOCK_ICICI_PAGE_PORT: String(PAGE), MOCK_ICICI_PROXY_PORT: String(PROXY), MOCK_BACKEND_PORT: String(BACKEND),
  ICICI_PG_SECRET_KEY: KEY, ICICI_PG_MERCHANT_ID: MID, ICICI_PG_AGGREGATOR_ID: AGG,
  ICICI_PG_INITIATE_SALE_URL: `http://localhost:${API}/tsp/pg/api/v2/initiateSale`, ICICI_PG_COMMAND_URL: `http://localhost:${API}/tsp/pg/api/command`,
  ...extra,
});

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`  ✅ ${name}`); };

const req = (proto: 'http' | 'https', port: number, method: string, p: string, body?: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const r = (proto === 'https' ? https : http).request({ host: '127.0.0.1', port, method, path: p, rejectUnauthorized: false,
      headers: { ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}), ...headers } } as https.RequestOptions, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text: t }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
const apiJson = async (p: string, obj: object) => JSON.parse((await req('http', API, 'POST', p, JSON.stringify(obj), { 'Content-Type': 'application/json' })).text);
const apiForm = async (p: string, obj: Record<string, string>) => JSON.parse((await req('http', API, 'POST', p, new URLSearchParams(obj).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' })).text);
const ctl = async (p: string) => JSON.parse((await req('http', API, 'GET', p)).text);
const formFields = (html: string) => Object.fromEntries([...html.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]));

const run = async () => {
  // Fake local backend behind the returnURL proxy / advice target
  const got: { path: string; body: string }[] = [];
  const backend = http.createServer((r, s) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { got.push({ path: r.url!, body: b }); s.writeHead(302, { Location: 'http://localhost:3000/order-success' }); s.end(); }); }).listen(BACKEND, '127.0.0.1');
  let mock: ChildProcess | null = null;
  try {
    console.log('Refuses unsafe configuration');
    await test('refuses the real UAT key / merchant, and a backend not pointed at the mock (secret never printed)', async () => {
      const uatKey = spawnSync(process.execPath, [SCRIPT], { env: baseEnv({ ICICI_PG_SECRET_KEY: 'a-different-real-looking-key' }), encoding: 'utf8', timeout: 20_000 });
      assert.strictEqual(uatKey.status, 2); assert.match(uatKey.stderr, /REAL UAT/); assert.ok(!(uatKey.stdout + uatKey.stderr).includes('a-different-real-looking-key'));
      const uatMid = spawnSync(process.execPath, [SCRIPT], { env: baseEnv({ ICICI_PG_MERCHANT_ID: '100000000000999' }), encoding: 'utf8', timeout: 20_000 });
      assert.strictEqual(uatMid.status, 2);
      const real = spawnSync(process.execPath, [SCRIPT], { env: baseEnv({ ICICI_PG_INITIATE_SALE_URL: 'https://pgpayuat.icicibank.com/tsp/pg/api/v2/initiateSale' }), encoding: 'utf8', timeout: 20_000 });
      assert.strictEqual(real.status, 2); assert.match(real.stderr, /does not point at this mock/);
      const none = spawnSync(process.execPath, [SCRIPT], { env: baseEnv({ ICICI_PG_SECRET_KEY: '' }), encoding: 'utf8', timeout: 20_000 });
      assert.strictEqual(none.status, 2);
    });

    mock = spawn(process.execPath, [SCRIPT], { env: baseEnv() });
    let out = '';
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`mock did not start: ${out}`)), 30_000);
      mock!.stdout!.on('data', (c) => { out += c; if (out.includes('ready:')) { clearTimeout(t); resolve(); } });
      mock!.stderr!.on('data', (c) => (out += c));
      mock!.on('exit', (c) => reject(new Error(`mock exited ${c}: ${out}`)));
    });

    console.log('Network exposure');
    await test('binds 127.0.0.1 only: unreachable on every LAN address', async () => {
      const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
      for (const ip of lan) for (const port of [API, PAGE, PROXY]) {
        await assert.rejects(new Promise((res, rej) => { const s = require('net').connect(port, ip); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', rej); }), /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/, `${ip}:${port} reachable`);
      }
    });
    await test('no outbound requests: no fetch, and every request it makes targets 127.0.0.1', async () => {
      const src = fs.readFileSync(SCRIPT, 'utf8');
      assert.ok(!/\bfetch\(/.test(src), 'uses fetch');
      const calls = [...src.matchAll(/\bhttps?\.request\(\{([^}]*)/g)];
      assert.ok(calls.length >= 2 && calls.every((c) => /host:\s*HOST\b/.test(c[1])), 'a request not pinned to HOST');
      assert.ok(/const HOST = '127\.0\.0\.1'/.test(src));
    });

    console.log('Gateway API (backend formats)');
    const sale = (txn: string, amount = '640.00') => signed({ merchantId: MID, aggregatorID: AGG, merchantTxnNo: txn, amount, currencyCode: '356', payType: '0',
      customerEmailID: 'buyer@example.test', transactionType: 'SALE', txnDate: '20261121235959', returnURL: `https://localhost:${PROXY}/api/v1/payments/icici/callback` });
    await test('initiateSale: signed request -> signed R1000 with an https redirectURI and tranCtx', async () => {
      const r = await apiJson('/tsp/pg/api/v2/initiateSale', sale('LGT1'));
      assert.strictEqual(r.responseCode, 'R1000'); assert.ok(verifyV1(r), 'response signed with the fake key');
      assert.strictEqual(r.redirectURI, `https://localhost:${PAGE}/tsp/pg/api/v2/authRedirect`); assert.strictEqual(r.tranCtx, 'CTX-LGT1');
    });
    await test('initiateSale: bad hash, wrong merchant or wrong aggregator refused (P1006), nothing registered', async () => {
      const before = (await ctl('/__stats')).initiateBadHash;
      for (const bad of [{ ...sale('LGBAD1'), secureHash: 'f'.repeat(64) }, signed({ ...sale('LGBAD2'), merchantId: 'OTHER', secureHash: undefined as any }), signed({ ...sale('LGBAD3'), aggregatorID: 'AOTHER', secureHash: undefined as any })]) {
        const r = await apiJson('/tsp/pg/api/v2/initiateSale', bad);
        assert.strictEqual(r.responseCode, 'P1006');
      }
      assert.strictEqual((await ctl('/__stats')).initiateBadHash - before, 3);
      assert.ok(!(await ctl('/__txns')).some((t: string) => t.startsWith('LGBAD')));
    });

    console.log('Scenarios');
    const status = (txn: string) => apiForm('/tsp/pg/api/command', signed({ merchantId: MID, aggregatorID: AGG, merchantTxnNo: txn, originalTxnNo: txn, transactionType: 'STATUS' }) as Record<string, string>);
    await test('success: hosted page -> signed result form-posted to returnURL; STATUS SUC', async () => {
      assert.strictEqual((await status('LGT1')).txnStatus, 'REQ', 'before the customer acts');
      const pg = await req('https', PAGE, 'GET', '/tsp/pg/api/v2/authRedirect?tranCtx=CTX-LGT1');
      assert.strictEqual(pg.status, 200); for (const id of ['pay-success', 'pay-decline', 'pay-pending']) assert.ok(pg.text.includes(`id="${id}"`));
      const ch = await req('https', PAGE, 'GET', '/choose?txn=LGT1&o=success');
      assert.ok(ch.text.includes(`action="https://localhost:${PROXY}/api/v1/payments/icici/callback"`));
      const f = formFields(ch.text);
      assert.ok(verifyV1(f)); assert.deepStrictEqual([f.responseCode, f.merchantId, f.aggregatorID, f.merchantTxnNo, f.amount], ['0000', MID, AGG, 'LGT1', '640.00']);
      const s = await status('LGT1'); assert.ok(verifyV1(s)); assert.deepStrictEqual([s.responseCode, s.txnStatus, s.txnResponseCode, s.amount], ['000', 'SUC', '0000', '640.00']);
    });
    await test('decline: E005 result; STATUS REJ', async () => {
      await apiJson('/tsp/pg/api/v2/initiateSale', sale('LGT2'));
      const f = formFields((await req('https', PAGE, 'GET', '/choose?txn=LGT2&o=decline')).text);
      assert.ok(verifyV1(f)); assert.strictEqual(f.responseCode, 'E005');
      assert.strictEqual((await status('LGT2')).txnStatus, 'REJ');
    });
    await test('pending UPI: R1000 result, STATUS REQ; bank confirms (/__bank) -> SUC; signed advice reaches the local backend', async () => {
      await apiJson('/tsp/pg/api/v2/initiateSale', sale('LGT3'));
      const f = formFields((await req('https', PAGE, 'GET', '/choose?txn=LGT3&o=pending')).text);
      assert.ok(verifyV1(f)); assert.deepStrictEqual([f.responseCode, f.paymentMode], ['R1000', 'UPI']);
      assert.strictEqual((await status('LGT3')).txnStatus, 'REQ');
      await ctl('/__bank?txn=LGT3&status=SUC');
      assert.strictEqual((await status('LGT3')).txnStatus, 'SUC');
      const a = await ctl('/__advice?txn=LGT3&o=success');
      assert.strictEqual(a.backendStatus, 302); // fake backend answers 302
      const adv = got.find((g) => g.path === '/api/v1/payments/icici/payment-advice')!;
      const p = Object.fromEntries(new URLSearchParams(adv.body)); assert.ok(verifyV1(p)); assert.strictEqual(p.responseCode, '0000');
    });
    await test('auto outcome mode skips the choice page (deterministic runs)', async () => {
      await ctl('/__mode?outcome=decline');
      await apiJson('/tsp/pg/api/v2/initiateSale', sale('LGT4'));
      const r = await req('https', PAGE, 'GET', '/tsp/pg/api/v2/authRedirect?tranCtx=CTX-LGT4');
      assert.deepStrictEqual([r.status, r.headers.location], [302, '/choose?txn=LGT4&o=decline']);
      await ctl('/__mode?outcome=');
    });
    await test('gateway failure modes: html (403 page) and refuse (signed error)', async () => {
      await ctl('/__mode?initiate=html');
      const h = await req('http', API, 'POST', '/tsp/pg/api/v2/initiateSale', JSON.stringify(sale('LGT5')), { 'Content-Type': 'application/json' });
      assert.deepStrictEqual([h.status, h.text], [403, '<html>Request Rejected</html>']);
      await ctl('/__mode?initiate=refuse');
      const rf = await apiJson('/tsp/pg/api/v2/initiateSale', sale('LGT6'));
      assert.ok(verifyV1(rf)); assert.strictEqual(rf.responseCode, 'P1001');
      await ctl('/__mode?initiate=ok');
    });
    await test('REFUND command answered and signed', async () => {
      const r = await apiForm('/tsp/pg/api/command', signed({ merchantId: MID, aggregatorID: AGG, merchantTxnNo: 'LGRF1', originalTxnNo: 'LGT1', amount: '640.00', transactionType: 'REFUND' }) as Record<string, string>);
      assert.ok(verifyV1(r)); assert.strictEqual(r.responseCode, '000');
    });
    await test('returnURL proxy forwards the browser post to the local backend unchanged; redirect passes through', async () => {
      const body = new URLSearchParams({ a: '1', b: 'x y' }).toString();
      const r = await req('https', PROXY, 'POST', '/api/v1/payments/icici/callback', body, { 'Content-Type': 'application/x-www-form-urlencoded' });
      assert.deepStrictEqual([r.status, r.headers.location], [302, 'http://localhost:3000/order-success']);
      assert.ok(got.some((g) => g.path === '/api/v1/payments/icici/callback' && g.body === body));
    });

    console.log(`\n${passed} passed`);
  } finally {
    mock?.kill();
    backend.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

run().then(() => process.exit(0)).catch((err) => { console.error('❌', err); process.exit(1); });
