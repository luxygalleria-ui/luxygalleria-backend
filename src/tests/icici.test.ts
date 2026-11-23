/**
 * ICICI Orange PG: hash rules, initiate -> return URL -> order, advices, status, refund.
 * Needs a local MongoDB; uses (and drops) a throwaway database. ICICI is stubbed at fetch(): no network.
 * Run: npx ts-node --transpile-only src/tests/icici.test.ts
 */
import assert from 'assert';
import { AddressInfo } from 'net';

const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_icici_test';
const KEY = 'icici_test_key';
Object.assign(process.env, {
  NODE_ENV: 'development', HISTORY_READ_ENABLED: 'false', SENDGRID_API_KEY: '', FRONTEND_URL: 'https://shop.test',
  ICICI_PG_MERCHANT_ID: '100000000007164', ICICI_PG_SECRET_KEY: KEY, ICICI_PG_AGGREGATOR_ID: 'A100000000007164', ICICI_PG_CURRENCY_CODE: '356',
  ICICI_PG_INITIATE_SALE_URL: 'https://icici.test/initiateSale', ICICI_PG_COMMAND_URL: 'https://icici.test/command',
  ICICI_PG_RETURN_URL: 'https://api.shop.test/api/v1/payments/icici/callback',
});

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../app';
import { ENV } from '../config/env';
import { User } from '../models/User';
import { Product } from '../models/Product';
import { Cart } from '../models/Cart';
import Order from '../models/Order';
import { CheckoutSession } from '../models/CheckoutSession';
import { hashV1, hashV2, verifyV1, istTimestamp, saleTxnDate, assertGatewayAllowed, postForm, postJson, gatewayFailure, parseJsonKeepNumberText } from '../utils/iciciPg';
import { localMockDown } from '../controllers/iciciController';

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`  ✅ ${name}`); };
const sign = (p: Record<string, any>) => ({ ...p, secureHash: hashV1(p, KEY) });

// ---- ICICI stub: every request except to the local test server is answered here (real ICICI hostnames included,
// so no test can ever reach a gateway); the next reply can be overridden per test
const sent: { url: string; body: Record<string, string> }[] = [];
let nextReply: ((body: Record<string, string>) => any) | null = null;
let statusReply: ((body: Record<string, string>) => any) | null = null; // persistent, for reconcile sweeps
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init);
  const body = url.endsWith('/initiateSale') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(String(init.body)));
  sent.push({ url, body });
  const reply = nextReply ? nextReply(body) : body.transactionType === 'STATUS' && statusReply ? statusReply(body) : sign({ responseCode: 'R1000', merchantId: body.merchantId, aggregatorID: null, merchantTxnNo: body.merchantTxnNo,
    redirectURI: 'https://icici.test/authRedirect', showOTPCapturePage: 'N', generateOTPURI: null, tranCtx: `R-${body.merchantTxnNo}` });
  nextReply = null;
  if (reply instanceof Response) return reply; // raw reply, e.g. a firewall's HTML page
  return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

const run = async () => {
  console.log('Hash rules');
  await test('V1 concatenates non-empty values by sorted key: the plain hashtext of ICICI\'s step-wise sample', async () => {
    const req = { txnDate: '20251028235959', addlParam2: '111', merchantId: '100000000006873', addlParam1: '000', aggregatorID: 'A100000000006873',
      amount: '2.00', currencyCode: '356', customerEmailID: 'dummy@gmail.com', customerMobileNo: '9090909090', customerName: 'Narayan',
      merchantTxnNo: '757585887575', payType: '0', returnURL: 'https://pgpayuat.icicibank.com/tsp/pg/api/merchant', transactionType: 'SALE', empty: '', nothing: null };
    const plain = '000111A1000000000068732.00356dummy@gmail.com9090909090Narayan1000000000068737575858875750https://pgpayuat.icicibank.com/tsp/pg/api/merchantSALE20251028235959';
    assert.strictEqual(hashV1(req, 'k'), hashV2(plain, 'k'));
    assert.match(hashV1(req, 'k'), /^[0-9a-f]{64}$/);
    assert.ok(verifyV1(sign(req)) && !verifyV1({ ...sign(req), amount: '3.00' }) && !verifyV1({ ...req, secureHash: 'x' }));
    assert.ok(verifyV1({ ...sign(req), secureHash: sign(req).secureHash.toUpperCase() }), 'case-insensitive compare');
  });

  await test(`JSON numbers keep their exact sent text on any Node version (running ${process.version}): 600.00 is not 600`, async () => {
    const J = (raw: string) => parseJsonKeepNumberText(raw) as any;
    // 1. 600.00 keeps its trailing zeros; 2. 600 stays "600", a different value for the hash
    assert.deepStrictEqual(J('{"amount":600.00}'), { amount: '600.00' });
    assert.deepStrictEqual(J('{"amount":600}'), { amount: '600' });
    assert.notStrictEqual(hashV1(J('{"amount":600.00}'), 'k'), hashV1(J('{"amount":600}'), 'k'), '600 and 600.00 sign differently');
    assert.strictEqual(hashV1(J('{"amount":600.00,"merchantTxnNo":"T1"}'), 'k'), hashV1({ amount: '600.00', merchantTxnNo: 'T1' }, 'k'), 'same hash as the string form');
    // 3. decimals, negatives, exponents and integers beyond float precision come through untouched (never a JS number)
    for (const lit of ['0.10', '-12.50', '1.50E+2', '1e3', '0', '-0', '123456789012345678901234567890', '9007199254740993', '0.30000000000000004000']) {
      assert.strictEqual(J(`{"v":${lit}}`).v, lit, lit);
    }
    // nested objects and arrays, whitespace around numbers
    assert.deepStrictEqual(J('{ "a" : [ 1.10 , { "b" : 2.0 } ] , "c" :\n 3 }'), { a: ['1.10', { b: '2.0' }], c: '3' });
    // strings are copied as they are: digits, quotes and backslashes inside them are never touched
    assert.deepStrictEqual(J('{"s":"pay 1.50 now \\"2.00\\" 3","t":"\\\\","u":"\\u0031.0"}'), { s: 'pay 1.50 now "2.00" 3', t: '\\', u: '1.0' });
    // booleans and null stay what they were (null is still skipped by the hash)
    assert.deepStrictEqual(J('{"t":true,"f":false,"n":null}'), { t: true, f: false, n: null });
    // invalid JSON still throws (rejected by the caller as an unverifiable post)
    for (const bad of ['{"a":01}', '{"a":-}', '{"a":1.}', '{"a":.5}', '{"a":"x}', '{"a":1', '']) assert.throws(() => J(bad), SyntaxError, bad);
  });

  assert.ok(TEST_DB.endsWith('_test'));
  await mongoose.connect(TEST_DB);
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([Order.init(), CheckoutSession.init()]);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (path: string, body: unknown, token?: string, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) as any };
  };
  // Exactly what the customer's browser sends: a cross-site form post carrying ICICI's Origin
  const formPost = async (path: string, params: Record<string, any>) => {
    const r = await fetch(base + path, { method: 'POST', redirect: 'manual', body: new URLSearchParams(params),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://pgpayuat.icicibank.com' } });
    return { status: r.status, location: r.headers.get('location') };
  };

  try {
    const mk = (name: string, role: string) => User.create({ name, email: `${name.toLowerCase()}@test.local`, password: 'Passw0rd#123', role, isVerified: true });
    const [superU, ann, ben] = await Promise.all([mk('Super', 'superadmin'), mk('Ann', 'customer'), mk('Ben', 'customer')]);
    const tok = (u: any) => jwt.sign({ id: String(u._id), role: u.role }, ENV.JWT_SECRET, { expiresIn: '30m' });
    const [superT, annT, benT] = [superU, ann, ben].map(tok);
    const address = { street: '1 MG Road', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' };
    const tea = await Product.create({ name: 'Tea', category: 'Snacks', description: 'Tea', variants: [{ volume: '200g', price: 300, offerPrice: 300, actualPrice: 300, stock: 10, weight: 0.2 }], stock: 10 });
    const items = [{ product: String(tea._id), variantId: String(tea.variants[0]._id), quantity: 2 }];
    const stock = async () => (await Product.findById(tea._id).lean())!.variants[0].stock;
    const total = (await call('/payments/calculate-shipping', { items, shippingAddress: address, fulfillment: { method: 'delivery' } })).json.data.grandTotal;
    // ip: a distinct client (trust proxy 1) so production-mode cases do not share the real payment rate limit
    const initiate = (token = annT, ip?: string) => call('/payments/icici/initiate', { items, shippingAddress: address, fulfillment: { method: 'delivery' }, total }, token, ip ? { 'X-Forwarded-For': ip } : {});
    const paid = (txnNo: string, extra: Record<string, any> = {}) => sign({ responseCode: '0000', respDescription: 'Transaction successful',
      merchantId: '100000000007164', aggregatorID: 'A100000000007164', merchantTxnNo: txnNo, txnID: `T${txnNo}`, paymentDateTime: '20261119101010',
      paymentMode: 'CARD', amount: total.toFixed(2), ...extra });

    console.log('Initiate and return URL');
    let txnNo = '';
    await test('UAT gate: test config pays only for listed user _ids unless NODE_ENV is exactly "development"; live needs BOTH URLs live', async () => {
      const SALE_UAT = 'https://pgpayuat.icicibank.com/tsp/pg/api/v2/initiateSale', CMD_UAT = 'https://pgpayuat.icicibank.com/tsp/pg/api/command';
      const SALE_LIVE = 'https://pgpay.icicibank.com/pg/api/v2/initiateSale', CMD_LIVE = 'https://pgpay.icicibank.com/pg/api/command';
      // A different account whose email is a case variant of Ann's: registration allows it (emails are case-sensitive)
      const annCase = await User.create({ name: 'AnnCase', email: 'ANN@test.local', password: 'Passw0rd#123', role: 'customer', isVerified: true });
      const who = { ann: annT, ben: benT, annCase: tok(annCase) };
      const ANN = ` ${String(ann._id).toUpperCase()} , ${String(superU._id)}`; // any hex case, spaces trimmed
      const OTHER = String(superU._id); // a real _id, not Ann's
      const BOTH_EMAILS = 'ann@test.local,ben@test.local';
      type Case = [string, string | undefined, string, string, string, string, keyof typeof who, number];
      const cases: Case[] = [
        // label, NODE_ENV, sale, command, USER_IDS, EMAILS, caller, expected
        ['1 production + authorised existing user _id', 'production', SALE_UAT, CMD_UAT, ANN, '', 'ann', 200],
        ['2 unauthorised _id whose email IS allow-listed (emails ignored)', 'production', SALE_UAT, CMD_UAT, ANN, BOTH_EMAILS, 'ben', 403],
        ['3 case-variant email on a different account', 'production', SALE_UAT, CMD_UAT, ANN, BOTH_EMAILS, 'annCase', 403],
        ['4 empty ID list (email list set: no fallback)', 'production', SALE_UAT, CMD_UAT, '', BOTH_EMAILS, 'ann', 403],
        ['4b ID list of only commas/spaces', 'production', SALE_UAT, CMD_UAT, ' , ,', '', 'ann', 403],
        ['5 invalid ID configuration (not an ObjectId)', 'production', SALE_UAT, CMD_UAT, 'ann@test.local', '', 'ann', 403],
        ['5b one malformed entry invalidates the whole list', 'production', SALE_UAT, CMD_UAT, `${ann._id},xyz`, '', 'ann', 403],
        ['5c 23-hex entry', 'production', SALE_UAT, CMD_UAT, String(ann._id).slice(1), '', 'ann', 403],
        ['6 development + unlisted', 'development', SALE_UAT, CMD_UAT, '', '', 'ann', 200],
        ['7 production + unlisted', 'production', SALE_UAT, CMD_UAT, OTHER, '', 'ann', 403],
        ['7 staging + unlisted', 'staging', SALE_UAT, CMD_UAT, OTHER, '', 'ann', 403],
        ['7 staging + authorised', 'staging', SALE_UAT, CMD_UAT, ANN, '', 'ann', 200],
        ['7 NODE_ENV unset + unlisted', undefined, SALE_UAT, CMD_UAT, OTHER, '', 'ann', 403],
        ['7 NODE_ENV unset + authorised', undefined, SALE_UAT, CMD_UAT, ANN, '', 'ann', 200],
        ['7 "Production" (not exact) + unlisted', 'Production', SALE_UAT, CMD_UAT, OTHER, '', 'ann', 403],
        ['8 mixed: live sale, UAT command + unlisted', 'production', SALE_LIVE, CMD_UAT, OTHER, '', 'ann', 403],
        ['8 mixed: UAT sale, live command + unlisted', 'production', SALE_UAT, CMD_LIVE, OTHER, '', 'ann', 403],
        ['8 mixed + authorised', 'production', SALE_LIVE, CMD_UAT, ANN, '', 'ann', 200],
        ['8 unknown host (ambiguous) + unlisted', 'production', 'https://icici.test/pg/api/v2/initiateSale', CMD_LIVE, OTHER, '', 'ann', 403],
        ['live (both URLs) + unlisted: no gate', 'production', SALE_LIVE, CMD_LIVE, '', '', 'ann', 200],
      ];
      // This test is about the tester gate: the development dev-guard (real ICICI hosts) is opted out here, tested below
      const keys = ['NODE_ENV', 'ICICI_PG_INITIATE_SALE_URL', 'ICICI_PG_COMMAND_URL', 'ICICI_PG_UAT_TEST_USER_IDS', 'ICICI_PG_UAT_TEST_EMAILS', 'ICICI_PG_ALLOW_REAL_GATEWAY_IN_DEV'];
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      const setEnv = (env: Record<string, string | undefined>) => { for (const k of keys) env[k] === undefined ? delete process.env[k] : process.env[k] = env[k]; };
      const warned: string[] = [];
      const origWarn = console.warn, origErr = console.error;
      console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };
      console.error = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };
      try {
        for (const [i, [label, NODE_ENV, sale, cmd, ids, emails, caller, expected]] of cases.entries()) {
          setEnv({ NODE_ENV, ICICI_PG_INITIATE_SALE_URL: sale, ICICI_PG_COMMAND_URL: cmd, ICICI_PG_UAT_TEST_USER_IDS: ids, ICICI_PG_UAT_TEST_EMAILS: emails, ICICI_PG_ALLOW_REAL_GATEWAY_IN_DEV: 'true' });
          const sends = sent.length;
          const sessions = await CheckoutSession.countDocuments();
          const r = await initiate(who[caller], `10.9.0.${i + 1}`);
          assert.strictEqual(r.status, expected, `${label}: ${JSON.stringify(r.json)}`);
          if (expected === 403) {
            // Which rule refused, for the browser console: never a tester id, email or the allowlist itself
            assert.deepStrictEqual([r.json.code, r.json.message], ['ICICI_UAT_TESTER_ONLY', 'Online payment is being set up and is not available yet. Please try again later.'], label);
            assert.ok(!/[a-f\d]{24}|@/i.test(JSON.stringify(r.json)), `${label}: no id or email in the reply`);
            assert.strictEqual(sent.length, sends, `${label}: nothing sent to ICICI`);
            assert.strictEqual(await CheckoutSession.countDocuments(), sessions, `${label}: no session / stock hold`);
          } else assert.strictEqual(sent.at(-1)!.url, sale, `${label}: sale sent to the configured URL`);
        }
      } finally { setEnv(saved); console.warn = origWarn; console.error = origErr; }
      const gateLines = warned.filter((l) => l.startsWith('ICICI UAT gate: refused'));
      assert.strictEqual(gateLines.length, cases.filter((c) => c[7] === 403).length, 'one log line per gate refusal');
      assert.ok(warned.every((l) => !/[a-f\d]{24}|@/i.test(l)), 'gate logs carry no user id or email');
      // Every 200 above is Ann's; her last hold is released by her next initiate (superseded), so later stock checks hold
    });

    await test('dev guard: in exact development no request reaches a real ICICI host unless ICICI_PG_ALLOW_REAL_GATEWAY_IN_DEV is "true"', async () => {
      const keys = ['NODE_ENV', 'ICICI_PG_INITIATE_SALE_URL', 'ICICI_PG_COMMAND_URL', 'ICICI_PG_ALLOW_REAL_GATEWAY_IN_DEV'];
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      const setEnv = (env: Record<string, string | undefined>) => { for (const k of keys) env[k] === undefined ? delete process.env[k] : process.env[k] = env[k]; };
      const UAT = { ICICI_PG_INITIATE_SALE_URL: 'https://pgpayuat.icicibank.com/tsp/pg/api/v2/initiateSale', ICICI_PG_COMMAND_URL: 'https://pgpayuat.icicibank.com/tsp/pg/api/command' };
      try {
        for (const [label, flag] of [['flag unset', undefined], ['flag "false"', 'false'], ['flag "TRUE" (not exact)', 'TRUE'], ['flag "1"', '1']] as [string, string | undefined][]) {
          setEnv({ NODE_ENV: 'development', ...UAT, ICICI_PG_ALLOW_REAL_GATEWAY_IN_DEV: flag });
          const before = await stock(); const sends = sent.length; const orders = await Order.countDocuments(); // before may include Ann's older hold, released by this initiate
          const r = await initiate(annT);
          assert.deepStrictEqual([r.status, r.json.message], [502, 'Could not reach the ICICI payment gateway. You have not been charged. Please try again in a few minutes.'], `${label}: ${JSON.stringify(r.json)}`);
          assert.strictEqual(sent.length, sends, `${label}: nothing left this process`);
          assert.ok(await stock() >= before, `${label}: no stock taken`);
          assert.strictEqual(await CheckoutSession.countDocuments({ user: ann._id, status: 'pending' }), 0, `${label}: no hold left behind`);
          assert.strictEqual(await Order.countDocuments(), orders);
        }
        // Explicit opt-in (npm run dev:icici-uat): allowed (answered by the stub here)
        setEnv({ NODE_ENV: 'development', ...UAT, ICICI_PG_ALLOW_REAL_GATEWAY_IN_DEV: 'true' });
        const ok = await initiate(annT);
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
        assert.strictEqual(sent.at(-1)!.url, UAT.ICICI_PG_INITIATE_SALE_URL);
        // Every outbound path is covered, and only real ICICI hosts are blocked
        setEnv({ NODE_ENV: 'development', ...UAT, ICICI_PG_ALLOW_REAL_GATEWAY_IN_DEV: undefined });
        for (const u of ['https://pgpayuat.icicibank.com/tsp/pg/api/command', 'https://PGPAY.ICICIBANK.COM/pg/api/command', 'https://pgpay.icicibank.com./pg/api/command', 'https://icicibank.com/x']) {
          await assert.rejects(postForm(u, {}), /Real ICICI gateway .* blocked in development/, u);
          await assert.rejects(postJson(u, {}), /Real ICICI gateway .* blocked in development/, u);
        }
        assert.doesNotThrow(() => assertGatewayAllowed('https://icicibank.com.evil.test/x')); // not ICICI: not this guard's job
        assert.doesNotThrow(() => assertGatewayAllowed('https://localhost:8443/tsp/pg/api/v2/initiateSale')); // local mock
        // Other environments are never affected by the dev guard
        for (const NODE_ENV of ['production', 'staging', undefined]) {
          setEnv({ NODE_ENV, ...UAT, ICICI_PG_ALLOW_REAL_GATEWAY_IN_DEV: undefined });
          assert.doesNotThrow(() => assertGatewayAllowed(UAT.ICICI_PG_INITIATE_SALE_URL), String(NODE_ENV));
        }
      } finally { setEnv(saved); }
      // Ann's last hold (the allowed initiate) is released by her next initiate (superseded)
    });

    await test('config: any missing MANDATORY ICICI variable -> 503, no gateway call, no hold; optional aggregator may be empty', async () => {
      const mandatory = ['ICICI_PG_INITIATE_SALE_URL', 'ICICI_PG_COMMAND_URL', 'ICICI_PG_MERCHANT_ID', 'ICICI_PG_SECRET_KEY', 'ICICI_PG_RETURN_URL'];
      const saved = Object.fromEntries([...mandatory, 'ICICI_PG_AGGREGATOR_ID'].map((k) => [k, process.env[k]]));
      const restore = () => { for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : process.env[k] = v; };
      try {
        for (const k of mandatory) for (const empty of ['', '   ']) {
          restore(); process.env[k] = empty;
          const sends = sent.length, sessions = await CheckoutSession.countDocuments();
          const r = await initiate(annT);
          assert.deepStrictEqual([r.status, r.json.message], [503, 'ICICI payments are not available'], `${k}=${JSON.stringify(empty)}`);
          assert.strictEqual(sent.length, sends, `${k}: nothing sent`);
          assert.strictEqual(await CheckoutSession.countDocuments(), sessions, `${k}: no session / hold`);
        }
        restore(); process.env.ICICI_PG_AGGREGATOR_ID = '';
        const r = await initiate(annT);
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        const req = sent.at(-1)!.body;
        assert.ok(!('aggregatorID' in req) && verifyV1(req), 'empty aggregator omitted, request still signed');
      } finally { restore(); }
      // Ann's hold from the last initiate is released by her next one (superseded)
    });

    await test('initiate prices on the server, reserves stock and returns redirectURI?tranCtx=', async () => {
      const r = await initiate();
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      txnNo = r.json.data.merchantTxnNo;
      assert.match(txnNo, /^[A-Z0-9]{1,20}$/);
      assert.strictEqual(r.json.data.redirectUrl, `https://icici.test/authRedirect?tranCtx=R-${txnNo}`);
      const req = sent.at(-1)!.body;
      assert.deepStrictEqual([req.merchantId, req.aggregatorID, req.amount, req.currencyCode, req.payType, req.transactionType, req.customerEmailID],
        ['100000000007164', 'A100000000007164', total.toFixed(2), '356', '0', 'SALE', 'ann@test.local']);
      assert.match(req.txnDate, /^\d{14}$/);
      assert.ok(req.txnDate > istTimestamp(), 'txnDate is later than the initiation time');
      // Doc rule: later than now, but never past 23:59:59 IST of the same day
      assert.strictEqual(saleTxnDate(new Date('2026-11-19T06:30:00Z')), '20261119120500'); // 12:00 IST -> 12:05
      assert.strictEqual(saleTxnDate(new Date('2026-11-19T18:27:00Z')), '20261119235959'); // 23:57 IST -> capped
      assert.ok(verifyV1(req), 'request carries a valid secureHash');
      assert.strictEqual(await stock(), 8);
      const s = await CheckoutSession.findOne({ razorpayOrderId: txnNo }).lean();
      assert.deepStrictEqual([s!.gateway, s!.status], ['icici', 'pending']);
    });

    await test('a forged or wrong-amount return URL post creates no order', async () => {
      const forged = await formPost('/payments/icici/callback', { ...paid(txnNo), secureHash: 'f'.repeat(64) });
      // Unverifiable is never "try again": if it was our bug and money moved, a second payment would follow
      assert.deepStrictEqual([forged.status, forged.location], [302, 'https://shop.test/order-failure?reason=unconfirmed']);
      const wrong = await formPost('/payments/icici/callback', paid(txnNo, { amount: '1.00' }));
      assert.strictEqual(wrong.location, 'https://shop.test/order-failure?reason=unconfirmed');
      assert.strictEqual(await Order.countDocuments(), 0);
    });

    await test('a correctly signed post for another merchantId creates no order', async () => {
      const r = await formPost('/payments/icici/callback', paid(txnNo, { merchantId: '100000000000001' }));
      assert.strictEqual(r.location, 'https://shop.test/order-failure?reason=unconfirmed');
      assert.strictEqual(await Order.countDocuments(), 0);
    });

    await test('a signed success creates the order once, clears the cart and redirects to /order-success (CORS bypassed)', async () => {
      await Cart.create({ user: ann._id, items: [{ product: tea._id, variantId: tea.variants[0]._id, quantity: 2 }] }).catch(() => Cart.updateOne({ user: ann._id }, { $set: { items: [{ product: tea._id, variantId: tea.variants[0]._id, quantity: 2 }] } }));
      const r = await formPost('/payments/icici/callback', paid(txnNo));
      assert.deepStrictEqual([r.status, r.location], [302, 'https://shop.test/order-success']);
      const again = await formPost('/payments/icici/callback', paid(txnNo)); // browser refresh / replay
      assert.strictEqual(again.location, 'https://shop.test/order-success');
      const advice = await formPost('/payments/icici/payment-advice', paid(txnNo));
      assert.strictEqual(advice.status, 200);
      const orders = await Order.find({ razorpayOrderId: txnNo }).lean();
      assert.strictEqual(orders.length, 1);
      const o: any = orders[0];
      assert.deepStrictEqual([o.paymentMethod, o.paymentStatus, o.iciciTxnId, o.razorpayPaymentId, Math.round(o.total * 100)],
        ['icici', 'completed', `T${txnNo}`, undefined, Math.round(total * 100)]);
      assert.strictEqual((await Cart.findOne({ user: ann._id }).lean())!.items.length, 0);
      assert.strictEqual(await stock(), 8, 'stock taken once');
    });

    await test('a declined payment releases the reserved stock at once', async () => {
      const r = await initiate();
      const t = r.json.data.merchantTxnNo;
      assert.strictEqual(await stock(), 6);
      const back = await formPost('/payments/icici/callback', paid(t, { responseCode: 'E005', respDescription: 'Declined' }));
      assert.strictEqual(back.location, 'https://shop.test/order-failure');
      assert.strictEqual(await stock(), 8);
      assert.strictEqual(await Order.countDocuments({ razorpayOrderId: t }), 0);
    });

    await test('return payload read dynamically: query-string / GET result, respCode, JSON numbers; every verified field kept', async () => {
      // Result on the URL (GET redirect), with a mode-specific field the code never names
      const t1 = (await initiate()).json.data.merchantTxnNo;
      const q = new URLSearchParams(paid(t1, { paymentMode: 'UPI', payerVpa: 'ann@okicici' }));
      const g = await fetch(`${base}/payments/icici/callback?${q}`, { redirect: 'manual' });
      assert.deepStrictEqual([g.status, g.headers.get('location')], [302, 'https://shop.test/order-success']);
      assert.strictEqual(await Order.countDocuments({ razorpayOrderId: t1 }), 1);
      const ev = (await CheckoutSession.findOne({ razorpayOrderId: t1 }).lean())!.events.find((e) => e.type === 'icici-callback-params');
      assert.ok(ev && JSON.parse(ev.detail!).payerVpa === 'ann@okicici' && !('secureHash' in JSON.parse(ev.detail!)), 'all verified fields stored, hash dropped');
      const forgedQ = await fetch(`${base}/payments/icici/callback?${new URLSearchParams({ ...paid(t1), secureHash: 'f'.repeat(64) })}`, { redirect: 'manual' });
      assert.strictEqual(forgedQ.headers.get('location'), 'https://shop.test/order-failure?reason=unconfirmed');

      // Success reported as respCode instead of responseCode
      const t2 = (await initiate()).json.data.merchantTxnNo;
      const { responseCode: _rc, ...base2 } = paid(t2) as Record<string, any>;
      const r2 = await formPost('/payments/icici/callback', sign({ ...base2, secureHash: undefined, respCode: '0000' }));
      assert.strictEqual(r2.location, 'https://shop.test/order-success');

      // JSON advice with amount as a number literal (600.00): the hash covers the text as sent
      const t3 = (await initiate()).json.data.merchantTxnNo;
      const a = total.toFixed(2);
      const json = JSON.stringify(paid(t3)).replace(`"amount":"${a}"`, `"amount":${a}`);
      assert.ok(json.includes(`"amount":${a}`));
      const r3 = await fetch(`${base}/payments/icici/payment-advice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json });
      assert.strictEqual(r3.status, 200);
      assert.strictEqual(await Order.countDocuments({ razorpayOrderId: t3 }), 1);
      await Product.updateOne({ _id: tea._id }, { $inc: { 'variants.0.stock': 6 } }); // give back the 3 x 2 units, for the tests below
    });

    await test('Live URLs on a production server: another customer pays without the UAT tester gate', async () => {
      const keys = ['NODE_ENV', 'ICICI_PG_INITIATE_SALE_URL', 'ICICI_PG_COMMAND_URL', 'ICICI_PG_UAT_TEST_USER_IDS'];
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      Object.assign(process.env, { NODE_ENV: 'production', ICICI_PG_INITIATE_SALE_URL: 'https://pgpay.icicibank.com/pg/api/v2/initiateSale',
        ICICI_PG_COMMAND_URL: 'https://pgpay.icicibank.com/pg/api/command', ICICI_PG_UAT_TEST_USER_IDS: '' });
      try {
        const r = await initiate(benT);
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert.strictEqual(sent.at(-1)!.url, 'https://pgpay.icicibank.com/pg/api/v2/initiateSale'); // answered by the stub
        await formPost('/payments/icici/callback', paid(r.json.data.merchantTxnNo, { responseCode: 'E005' })); // release the hold
      } finally { for (const k of keys) saved[k] === undefined ? delete process.env[k] : process.env[k] = saved[k]; }
    });

    await test('C3: ICICI callback query strings are redacted in the request log', async () => {
      const lines: string[] = [];
      const write = process.stdout.write.bind(process.stdout);
      (process.stdout as any).write = (chunk: any, ...rest: any[]) => { lines.push(String(chunk)); return write(chunk, ...rest); };
      try {
        await fetch(`${base}/payments/icici/callback?merchantTxnNo=LGX1&payerVpa=ann@okicici&secureHash=${'a'.repeat(64)}`, { redirect: 'manual' });
        await new Promise((r) => setTimeout(r, 100)); // morgan writes on response finish
      } finally { process.stdout.write = write; }
      const line = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).find((l) => l.includes('GET /api/v1/payments/icici/callback'));
      assert.ok(line, 'request was logged');
      assert.ok(line!.includes('/api/v1/payments/icici/callback?<redacted>'), line);
      assert.ok(!/payerVpa|okicici|secureHash|aaaa/.test(line!), line);
    });

    await test('JSON payment advice: the signed 600.00 text verifies; the same amount re-sent as 600 or 600.000 is rejected; form posts unchanged', async () => {
      const t = (await initiate()).json.data.merchantTxnNo;
      const a = total.toFixed(2);
      const signedJson = JSON.stringify(paid(t));                       // signed over amount "<a>" (e.g. "600.00")
      const asNumber = (lit: string) => signedJson.replace(`"amount":"${a}"`, `"amount":${lit}`);
      const post = (body: string) => fetch(`${base}/payments/icici/payment-advice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      // Tampered representations of the same value are refused: the hash covers the exact text
      for (const lit of [String(Number(a)), `${a}0`]) {
        if (lit === a) continue;
        assert.strictEqual((await post(asNumber(lit))).status, 400, `amount sent as ${lit}`);
      }
      assert.strictEqual(await Order.countDocuments({ razorpayOrderId: t }), 0, 'no order from a rejected advice');
      assert.strictEqual((await post(JSON.stringify({ ...paid(t), secureHash: 'f'.repeat(64) }))).status, 400, 'forged hash');
      // The exact signed text as a JSON number literal verifies and creates exactly one order (twice: still one)
      assert.strictEqual((await post(asNumber(a))).status, 200);
      assert.strictEqual((await post(asNumber(a))).status, 200, 'a repeated advice is accepted');
      assert.strictEqual(await Order.countDocuments({ razorpayOrderId: t }), 1, 'exactly one order');
      // Form-encoded posts are parsed exactly as before
      const t2 = (await initiate()).json.data.merchantTxnNo;
      assert.strictEqual((await formPost('/payments/icici/callback', paid(t2))).location, 'https://shop.test/order-success');
      assert.strictEqual(await Order.countDocuments({ razorpayOrderId: t2 }), 1);
      await Product.updateOne({ _id: tea._id }, { $inc: { 'variants.0.stock': 4 } }); // give back the 2 x 2 units, for the tests below
    });

    await test('UPI R1000 (pending) on the return URL goes to the pending page; the later payment advice completes the order', async () => {
      const t = (await initiate()).json.data.merchantTxnNo;
      assert.strictEqual((await formPost('/payments/icici/callback', paid(t, { responseCode: 'R1000' }))).location, 'https://shop.test/order-failure?reason=pending');
      assert.strictEqual(await Order.countDocuments({ razorpayOrderId: t }), 0);
      // Advice in JSON (merchant opted for JSON at onboarding)
      const r = await fetch(`${base}/payments/icici/payment-advice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(paid(t)) });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(await Order.countDocuments({ razorpayOrderId: t }), 1);
      const bad = await fetch(`${base}/payments/icici/payment-advice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...paid(t), secureHash: 'x' }) });
      assert.strictEqual(bad.status, 400);
    });

    await test('a gateway response with a bad secureHash is refused and the stock released', async () => {
      const before = await stock();
      nextReply = (b) => ({ ...sign({ responseCode: 'R1000', merchantTxnNo: b.merchantTxnNo, redirectURI: 'https://evil.test', tranCtx: 'x' }), tranCtx: 'tampered' });
      const r = await initiate();
      assert.strictEqual(r.status, 502);
      assert.strictEqual(await stock(), before);
    });

    await test('ICICI never answers (IP not allow-listed / timeout): 502 with a clear message, stock released, no order', async () => {
      const before = await stock();
      const orders = await Order.countDocuments();
      nextReply = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
      const r = await initiate();
      nextReply = null; // the stub clears it only after a reply that returns
      assert.deepStrictEqual([r.status, r.json.message], [502, 'Could not reach the ICICI payment gateway. You have not been charged. Please try again in a few minutes.']);
      assert.strictEqual(await stock(), before, 'reservation released');
      assert.strictEqual(await Order.countDocuments(), orders);
      const s = await CheckoutSession.findOne({}, {}, { sort: { createdAt: -1 } }).lean();
      assert.strictEqual(s!.status, 'expired');
    });

    await test('connection refused (gateway / local mock not running): 502, stock released, and the log names the host and ECONNREFUSED without secrets', async () => {
      const before = await stock();
      const orders = await Order.countDocuments();
      const logged: string[] = [];
      const origError = console.error;
      console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
      nextReply = () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8442'), { code: 'ECONNREFUSED' }) }); };
      let r;
      try { r = await initiate(); } finally { nextReply = null; console.error = origError; }
      assert.deepStrictEqual([r.status, r.json.message], [502, 'Could not reach the ICICI payment gateway. You have not been charged. Please try again in a few minutes.']);
      assert.strictEqual(await stock(), before, 'reservation released');
      assert.strictEqual(await Order.countDocuments(), orders);
      const line = logged.find((l) => l.includes('initiateSale')) ?? '';
      const host = new URL(process.env.ICICI_PG_INITIATE_SALE_URL!).host;
      assert.ok(line.includes(host) && line.includes('ECONNREFUSED') && line.includes('connection refused'), line);
      const secret = process.env.ICICI_PG_SECRET_KEY!;
      assert.ok(secret && !logged.some((l) => l.includes(secret) || /secureHash"?\s*[:=]/.test(l)), 'no key or hash logged');
      const s = await CheckoutSession.findOne({}, {}, { sort: { createdAt: -1 } }).lean();
      assert.ok(s!.events.some((e: any) => e.type === 'icici-released' && e.detail.includes('ECONNREFUSED')), 'the reason is kept on the session');
    });

    await test('local development, loopback mock refused: 502 names the mock and the start command; production and other failures keep the generic message', async () => {
      const keys = ['NODE_ENV', 'ICICI_PG_INITIATE_SALE_URL', 'ICICI_PG_UAT_TEST_USER_IDS'];
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      const refused = () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8442'), { code: 'ECONNREFUSED' }) }); };
      const GENERIC = 'Could not reach the ICICI payment gateway. You have not been charged. Please try again in a few minutes.';
      const LOCAL = 'http://localhost:8442/tsp/pg/api/v2/initiateSale';
      const origError = console.error; console.error = () => {};
      try {
        const run = async (env: Record<string, string>, reply: () => never) => {
          Object.assign(process.env, env);
          const before = await stock(); const orders = await Order.countDocuments();
          nextReply = reply;
          try {
            const r = await initiate();
            return { r, released: (await stock()) >= before, noOrder: (await Order.countDocuments()) === orders };
          } finally { nextReply = null; }
        };
        const dev = await run({ NODE_ENV: 'development', ICICI_PG_INITIATE_SALE_URL: LOCAL }, refused);
        assert.strictEqual(dev.r.status, 502, 'still a 502: never turned into a success');
        assert.strictEqual(dev.r.json.code, 'ICICI_LOCAL_MOCK_DOWN');
        assert.ok(/Local ICICI mock is not running at localhost:8442/.test(dev.r.json.message) && /npm run dev:icici-mock/.test(dev.r.json.message) && /not been charged/.test(dev.r.json.message), dev.r.json.message);
        assert.ok(dev.released && dev.noOrder, 'reservation released, no order');
        // production + a non-live URL: the UAT gate applies, so the test customer is listed as the approved tester
        const prod = await run({ NODE_ENV: 'production', ICICI_PG_INITIATE_SALE_URL: LOCAL, ICICI_PG_UAT_TEST_USER_IDS: String(ann._id) }, refused);
        assert.deepStrictEqual([prod.r.status, prod.r.json.message, prod.r.json.code], [502, GENERIC, undefined], 'production never mentions the mock');
        const timeout = await run({ NODE_ENV: 'development', ICICI_PG_INITIATE_SALE_URL: LOCAL }, () => { throw new DOMException('timed out', 'TimeoutError'); });
        assert.deepStrictEqual([timeout.r.status, timeout.r.json.message, timeout.r.json.code], [502, GENERIC, undefined], 'a timeout is not "mock not running"');
      } finally {
        console.error = origError;
        for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      }
    });

    await test('localMockDown: only exact development + loopback host + ECONNREFUSED', async () => {
      const refused = { cause: { code: 'ECONNREFUSED' } };
      const saved = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'development';
        for (const u of ['http://localhost:8442/x', 'http://127.0.0.1:8442/x', 'http://[::1]:8442/x']) assert.strictEqual(localMockDown(refused, u), true, u);
        assert.strictEqual(localMockDown(refused, 'https://pgpayuat.icicibank.com/tsp/pg/api/v2/initiateSale'), false, 'real UAT host');
        assert.strictEqual(localMockDown(refused, 'http://localhost.evil.test:8442/x'), false, 'lookalike host');
        assert.strictEqual(localMockDown({ cause: { code: 'ENOTFOUND' } }, 'http://localhost:8442/x'), false, 'other network error');
        assert.strictEqual(localMockDown(undefined, 'http://localhost:8442/x'), false, 'no error detail');
        assert.strictEqual(localMockDown(refused, 'not a url'), false, 'bad URL');
        for (const env of ['production', 'Development', 'staging', 'test']) { process.env.NODE_ENV = env; assert.strictEqual(localMockDown(refused, 'http://localhost:8442/x'), false, env); }
        delete process.env.NODE_ENV;
        assert.strictEqual(localMockDown(refused, 'http://localhost:8442/x'), false, 'unset');
      } finally { if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved; }
    });

    await test('gatewayFailure: host and network code only, safe for odd inputs', async () => {
      assert.strictEqual(gatewayFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), 'https://pgpayuat.icicibank.com/tsp/pg/api/v2/initiateSale?x=1'),
        'pgpayuat.icicibank.com: TypeError ENOTFOUND - fetch failed');
      assert.strictEqual(gatewayFailure(new DOMException('timed out', 'TimeoutError'), 'https://h.test/x'), 'h.test: TimeoutError - timed out');
      assert.strictEqual(gatewayFailure(undefined, 'not a url'), '(invalid URL): Error - undefined');
    });

    await test('a non-JSON gateway reply (firewall / WAF HTML page) is a 502, stock released, no order', async () => {
      const before = await stock();
      const orders = await Order.countDocuments();
      nextReply = () => new Response('<html>Request Rejected</html>', { status: 403, headers: { 'Content-Type': 'text/html' } });
      const r = await initiate();
      assert.deepStrictEqual([r.status, r.json.message], [502, 'Could not reach the ICICI payment gateway. You have not been charged. Please try again in a few minutes.']);
      assert.strictEqual(await stock(), before);
      assert.strictEqual(await Order.countDocuments(), orders);
    });

    await test('a retry after backing out of ICICI is not blocked by the customer\'s own earlier hold', async () => {
      const before = await stock();
      const first = (await initiate()).json.data.merchantTxnNo;
      assert.strictEqual(await stock(), before - 2);
      const second = await initiate();
      assert.strictEqual(second.status, 200);
      assert.strictEqual(await stock(), before - 2, 'first hold released, second taken');
      assert.strictEqual((await CheckoutSession.findOne({ razorpayOrderId: first }).lean())!.status, 'expired');
      // The abandoned first one is paid after all: it re-reserves and still becomes an order
      assert.strictEqual((await formPost('/payments/icici/callback', paid(first))).location, 'https://shop.test/order-success');
      assert.strictEqual(await stock(), before - 4);
      await formPost('/payments/icici/callback', paid(second.json.data.merchantTxnNo, { responseCode: 'E005' })); // tidy: decline the second
    });

    await test('duplicate starts: concurrent initiates never create an order on their own; a paid one becomes exactly one order', async () => {
      const before = await stock();
      const orders = await Order.countDocuments();
      // Two tabs / a double click reaching the server at the same moment
      const [a, b] = await Promise.all([initiate(), initiate()]);
      assert.deepStrictEqual([a.status, b.status], [200, 200]);
      const [ta, tb] = [a.json.data.merchantTxnNo, b.json.data.merchantTxnNo];
      assert.notStrictEqual(ta, tb, 'each start has its own merchantTxnNo');
      assert.strictEqual(await Order.countDocuments(), orders, 'starting a payment never creates an order');
      // ICICI delivers the result for A three times at once (return URL, payment advice, browser refresh)
      const results = await Promise.all([formPost('/payments/icici/callback', paid(ta)), formPost('/payments/icici/payment-advice', paid(ta)), formPost('/payments/icici/callback', paid(ta))]);
      assert.ok(results.every((r) => r.status === 302 ? r.location === 'https://shop.test/order-success' || r.location === 'https://shop.test/order-failure?reason=processing' : r.status === 200), JSON.stringify(results));
      assert.strictEqual(await Order.countDocuments({ razorpayOrderId: ta }), 1, 'one order for one payment');
      assert.strictEqual((await Order.findOne({ razorpayOrderId: ta }).lean())!.paymentStatus, 'completed');
      // B is never paid: its hold goes back and it never becomes an order
      await formPost('/payments/icici/callback', paid(tb, { responseCode: 'E005' }));
      assert.strictEqual(await Order.countDocuments({ razorpayOrderId: tb }), 0);
      assert.strictEqual(await stock(), before - 2, 'stock taken once, for the paid order only');
      await Product.updateOne({ _id: tea._id }, { $inc: { 'variants.0.stock': 2 } }); // give back for the tests below
    });

    console.log('Status, refund, settlement');
    await test('admin reconcile asks ICICI about open sessions and completes a pending UPI payment', async () => {
      const t = (await initiate()).json.data.merchantTxnNo;
      await formPost('/payments/icici/callback', paid(t, { responseCode: 'R1000' }));
      statusReply = (b) => b.originalTxnNo === t
        ? sign({ responseCode: '000', merchantId: b.merchantId, merchantTxnNo: t, txnStatus: 'SUC', txnResponseCode: '0000', txnID: 'T-rec', amount: total.toFixed(2) })
        : sign({ responseCode: 'E001', respDescription: 'Transaction not found' });
      const r = await fetch(`${base}/payments/admin/reconcile`, { method: 'POST', headers: { Authorization: `Bearer ${superT}` } });
      const j: any = await r.json();
      statusReply = null;
      assert.strictEqual(r.status, 200, JSON.stringify(j));
      assert.ok(j.data.icici.includes(`${t}: SUC -> created`), JSON.stringify(j.data));
      assert.strictEqual((await Order.findOne({ razorpayOrderId: t }).lean())!.iciciTxnId, 'T-rec');
    });

    await test('status: owner or admin only; a confirmed SUC recovers a lost return URL', async () => {
      const t = (await initiate()).json.data.merchantTxnNo;
      assert.strictEqual((await call('/payments/icici/status', { merchantTxnNo: t }, benT)).status, 404, 'another customer');
      nextReply = (b) => sign({ responseCode: '000', merchantId: b.merchantId, merchantTxnNo: t, txnStatus: 'SUC', txnResponseCode: '0000', txnID: 'T-status', amount: total.toFixed(2), oth_charge: false });
      const r = await call('/payments/icici/status', { merchantTxnNo: t }, annT);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.deepStrictEqual([r.json.data.txnStatus, r.json.data.outcome], ['SUC', 'created']);
      const cmd = sent.at(-1)!.body;
      assert.deepStrictEqual([cmd.transactionType, cmd.merchantTxnNo, cmd.originalTxnNo], ['STATUS', t, t]);
      assert.ok(verifyV1(cmd));
      assert.strictEqual((await Order.findOne({ razorpayOrderId: t }).lean())!.iciciTxnId, 'T-status');
    });

    await test('refund: super admin only, signed REFUND for the full amount, idempotent', async () => {
      const o: any = await Order.findOne({ razorpayOrderId: txnNo });
      assert.strictEqual((await call('/payments/icici/refund', { orderId: String(o._id), reason: 'customer request' }, annT)).status, 403);
      nextReply = (b) => sign({ responseCode: '000', respDescription: 'Request processed successfully', merchantId: b.merchantId, merchantTxnNo: b.merchantTxnNo, txnID: 'RF1' });
      const r = await call('/payments/icici/refund', { orderId: String(o._id), reason: 'customer request' }, superT);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const cmd = sent.at(-1)!.body;
      assert.deepStrictEqual([cmd.transactionType, cmd.originalTxnNo, cmd.amount], ['REFUND', txnNo, total.toFixed(2)]);
      assert.ok(verifyV1(cmd) && cmd.merchantTxnNo !== txnNo);
      const after: any = await Order.findById(o._id).lean();
      assert.deepStrictEqual([after.paymentStatus, after.refund.status], ['refunded', 'processed']);
      const calls = sent.length;
      assert.strictEqual((await call('/payments/icici/refund', { orderId: String(o._id), reason: 'again' }, superT)).status, 200);
      assert.strictEqual(sent.length, calls, 'no second refund request');
      // The Razorpay refund route never touches an ICICI order
      assert.strictEqual((await call(`/payments/admin/orders/${o._id}/refund`, { reason: 'x'.repeat(5) }, superT)).status, 400);
    });

    await test('status and refund replies: JSON number literals (600.00) verify over their exact text; 600 / 600.000 or a forged hash is refused', async () => {
      const a = total.toFixed(2);
      // A raw ICICI reply whose numeric fields are JSON number literals, signed over their exact text (as ICICI does)
      const raw = (fields: Record<string, any>, numeric: string[], alter: Record<string, string> = {}) => {
        let text = JSON.stringify(sign(fields));
        for (const k of numeric) text = text.replace(`"${k}":"${fields[k]}"`, `"${k}":${alter[k] ?? fields[k]}`);
        return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      const others = [String(Number(a)), `${a}0`].filter((x) => x !== a);
      const origError = console.error; console.error = () => {};
      try {
        // ---- STATUS: amount 600.00 and oth_charge 0 as number literals
        const stockBefore = await stock();
        await Product.updateOne({ _id: tea._id }, { $inc: { 'variants.0.stock': 2 } }); // the 2 units this test's order takes
        const started = await initiate();
        assert.strictEqual(started.status, 200, `initiate: ${JSON.stringify(started.json)}`);
        const t = started.json.data.merchantTxnNo;
        const statusFields = (b: any) => ({ responseCode: '000', merchantId: b.merchantId, merchantTxnNo: t, txnStatus: 'SUC', txnResponseCode: '0000', txnID: 'T-num', amount: a, oth_charge: '0' });
        for (const lit of others) {
          nextReply = (b) => raw(statusFields(b), ['amount', 'oth_charge'], { amount: lit });
          const r = await call('/payments/icici/status', { merchantTxnNo: t }, annT);
          assert.strictEqual(r.status, 502, `status reply with amount ${lit} instead of ${a}: ${JSON.stringify(r.json)}`);
        }
        const forged = (b: any) => new Response(JSON.stringify({ ...sign(statusFields(b)), secureHash: 'f'.repeat(64) }).replace(`"amount":"${a}"`, `"amount":${a}`), { status: 200 });
        nextReply = forged;
        assert.strictEqual((await call('/payments/icici/status', { merchantTxnNo: t }, annT)).status, 502, 'forged status hash');
        assert.strictEqual(await Order.countDocuments({ razorpayOrderId: t }), 0, 'no order from an unverifiable status reply');
        nextReply = (b) => raw(statusFields(b), ['amount', 'oth_charge']);
        const ok = await call('/payments/icici/status', { merchantTxnNo: t }, annT);
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
        assert.deepStrictEqual([ok.json.data.txnStatus, ok.json.data.outcome], ['SUC', 'created'], 'exact 600.00 text verifies and completes the order');
        assert.strictEqual(await Order.countDocuments({ razorpayOrderId: t }), 1);

        // ---- REFUND of that order: amount 600.00 as a number literal in the reply
        const o: any = await Order.findOne({ razorpayOrderId: t });
        const refundFields = (b: any) => ({ responseCode: '000', respDescription: 'Request processed successfully', merchantId: b.merchantId, merchantTxnNo: b.merchantTxnNo, txnID: 'RF-num', amount: a });
        const sends = sent.length;
        nextReply = (b) => raw(refundFields(b), ['amount'], { amount: others[0] });
        const bad = await call('/payments/icici/refund', { orderId: String(o._id), reason: 'customer request' }, superT);
        assert.deepStrictEqual([bad.status, bad.json.code], [502, 'REFUND_UNCONFIRMED'], `altered refund reply: ${JSON.stringify(bad.json)}`);
        const firstRefundTxn = sent.at(-1)!.body.merchantTxnNo;
        assert.strictEqual(((await Order.findById(o._id).lean()) as any).refund.status, 'requested', 'unconfirmed: stays requested, never marked refunded');
        nextReply = (b) => new Response(JSON.stringify({ ...sign(refundFields(b)), secureHash: 'f'.repeat(64) }), { status: 200 });
        assert.strictEqual((await call('/payments/icici/refund', { orderId: String(o._id), reason: 'customer request' }, superT)).status, 502, 'forged refund hash');
        nextReply = (b) => raw(refundFields(b), ['amount']);
        const good = await call('/payments/icici/refund', { orderId: String(o._id), reason: 'customer request' }, superT);
        assert.strictEqual(good.status, 200, JSON.stringify(good.json));
        assert.strictEqual(sent.at(-1)!.body.merchantTxnNo, firstRefundTxn, 'a retry reuses the same refund reference');
        assert.strictEqual(sent.length - sends, 3, 'one gateway request per attempt');
        const after: any = await Order.findById(o._id).lean();
        assert.deepStrictEqual([after.paymentStatus, after.refund.status], ['refunded', 'processed']);
        const calls = sent.length;
        assert.strictEqual((await call('/payments/icici/refund', { orderId: String(o._id), reason: 'again' }, superT)).status, 200);
        assert.strictEqual(sent.length, calls, 'no second refund request after it is processed');
        assert.strictEqual(await stock(), stockBefore, 'test isolation: shared stock back where it started (top-up 2, order took 2)');
      } finally { console.error = origError; nextReply = null; }
    });

    await test('booleans are signed as their JSON text (true/false); flipping one is refused [ICICI boolean rule UNVERIFIED]', async () => {
      // Only evidence: ICICI's STATUS sample carries "oth_charge":false inside a signed reply (spec p.74); the key is unknown,
      // so this pins the current rule (the literal text "false"), it does not prove ICICI's
      const stockBefore = await stock();
      await Product.updateOne({ _id: tea._id }, { $inc: { 'variants.0.stock': 2 } }); // the 2 units this test's order takes
      const t = (await initiate()).json.data.merchantTxnNo;
      const body = JSON.stringify(paid(t, { oth_charge: 'false' })).replace('"oth_charge":"false"', '"oth_charge":false');
      const flipped = body.replace('"oth_charge":false', '"oth_charge":true');
      const post = (b: string) => fetch(`${base}/payments/icici/payment-advice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b });
      assert.strictEqual((await post(flipped)).status, 400, 'a flipped boolean breaks the signature');
      assert.strictEqual(await Order.countDocuments({ razorpayOrderId: t }), 0);
      assert.strictEqual((await post(body)).status, 200, 'false signed as "false" verifies');
      assert.strictEqual(await Order.countDocuments({ razorpayOrderId: t }), 1);
      assert.strictEqual(await stock(), stockBefore, 'test isolation: shared stock back where it started');
    });

    await test('nested objects / arrays (undocumented by ICICI) are fail-closed: a notice signed any other way is refused, no order', async () => {
      // ICICI documents only flat fields for every notice (spec ch. 7-9). A nested value can never verify against a hash
      // ICICI computed some other way, so such a notice is rejected rather than trusted. The hash is checked before any
      // session lookup, so an unused reference is enough (no stock is touched).
      const t = 'LGNESTEDTEST0001';
      const stockBefore = await stock();
      const post = (b: string, path = 'payment-advice') => fetch(`${base}/payments/icici/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b });
      const origError = console.error; console.error = () => {};
      try {
        for (const [label, nested] of [['object', { bank: 'X', ref: 1 }], ['array', ['a', 2]], ['empty object', {}], ['empty array', []]] as const) {
          // signed by a signer that would put the nested value's JSON text into the hash string
          const flat = paid(t, { extra: JSON.stringify(nested) });
          const body = JSON.stringify(flat).replace(`"extra":${JSON.stringify(JSON.stringify(nested))}`, `"extra":${JSON.stringify(nested)}`);
          assert.strictEqual((await post(body)).status, 400, `payment notice with nested ${label}`);
        }
        const settle = sign({ merchantId: '100000000007164', merchantTxnNo: txnNo, settlementID: 'NESTED-1', settledAmount: total.toFixed(2), detail: JSON.stringify({ a: 1 }) });
        assert.strictEqual((await post(JSON.stringify(settle).replace('"detail":"{\\"a\\":1}"', '"detail":{"a":1}'), 'settlement-advice')).status, 400, 'settlement notice with a nested object');
      } finally { console.error = origError; }
      assert.strictEqual(await Order.countDocuments({ razorpayOrderId: t }), 0, 'no order from any nested notice');
      assert.notStrictEqual(((await Order.findOne({ razorpayOrderId: txnNo }).lean()) as any)?.iciciSettlement?.settlementID, 'NESTED-1', 'settlement not recorded');
      assert.strictEqual(await stock(), stockBefore, 'no stock touched');
    });

    await test('refund reply R1000 ("Request processed successfully", ICICI refund sample p.73): pending, same reference kept, never refunded twice', async () => {
      const stockBefore = await stock();
      await Product.updateOne({ _id: tea._id }, { $inc: { 'variants.0.stock': 2 } });
      const t = (await initiate()).json.data.merchantTxnNo;
      assert.strictEqual((await formPost('/payments/icici/callback', paid(t))).location, 'https://shop.test/order-success');
      const o: any = await Order.findOne({ razorpayOrderId: t });
      nextReply = (b) => sign({ responseCode: 'R1000', respDescription: 'Request processed successfully', merchantId: b.merchantId, merchantTxnNo: b.merchantTxnNo, txnID: 'RF-R1000' });
      const r = await call('/payments/icici/refund', { orderId: String(o._id), reason: 'customer request' }, superT);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const after: any = await Order.findById(o._id).lean();
      assert.deepStrictEqual([after.paymentStatus, after.refund.status], ['completed', 'pending'], 'accepted, not yet refunded, not failed');
      assert.ok(after.iciciRefundTxnNo, 'the refund reference is kept for the follow-up');
      const calls = sent.length;
      const again = await call('/payments/icici/refund', { orderId: String(o._id), reason: 'again' }, superT);
      assert.deepStrictEqual([again.status, sent.length], [200, calls], 'a second click sends nothing (refund already in progress)');
      // the customer sees it as in progress, never as refunded
      const view = await fetch(`${base}/payments/myorders`, { headers: { Authorization: `Bearer ${annT}` } });
      const list = ((await view.json()) as any).data;
      assert.strictEqual(view.status, 200);
      const mine = list.find((x: any) => String(x._id) === String(o._id));
      assert.ok(mine, 'the order is in the customer list');
      assert.strictEqual(mine.refund?.state, 'in_progress', 'customer sees the refund as in progress');
      assert.strictEqual(mine.paymentStatus, 'completed');
      assert.strictEqual(await stock(), stockBefore, 'test isolation: shared stock back where it started');
    });

    await test('settlement advice is recorded on the order; unsigned ones are refused', async () => {
      const adv = sign({ merchantId: '100000000007164', merchantTxnNo: txnNo, settlementID: 'A00121-20261120-010', settlementDate: '20261120', settledAmount: total.toFixed(2) });
      const ok = await fetch(`${base}/payments/icici/settlement-advice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(adv) });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(((await Order.findOne({ razorpayOrderId: txnNo }).lean()) as any).iciciSettlement.settlementID, 'A00121-20261120-010');
      const bad = await fetch(`${base}/payments/icici/settlement-advice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...adv, settledAmount: '1.00' }) });
      assert.strictEqual(bad.status, 400);
    });

    console.log(`\n${passed} passed`);
  } finally {
    server.close();
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
  }
};

run().catch((err) => { console.error('❌', err); process.exit(1); });
