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
import { hashV1, hashV2, verifyV1, istTimestamp, saleTxnDate, assertGatewayAllowed, postForm, postJson } from '../utils/iciciPg';

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
      try {
        for (const [i, [label, NODE_ENV, sale, cmd, ids, emails, caller, expected]] of cases.entries()) {
          setEnv({ NODE_ENV, ICICI_PG_INITIATE_SALE_URL: sale, ICICI_PG_COMMAND_URL: cmd, ICICI_PG_UAT_TEST_USER_IDS: ids, ICICI_PG_UAT_TEST_EMAILS: emails, ICICI_PG_ALLOW_REAL_GATEWAY_IN_DEV: 'true' });
          const sends = sent.length;
          const sessions = await CheckoutSession.countDocuments();
          const r = await initiate(who[caller], `10.9.0.${i + 1}`);
          assert.strictEqual(r.status, expected, `${label}: ${JSON.stringify(r.json)}`);
          if (expected === 403) {
            assert.strictEqual(sent.length, sends, `${label}: nothing sent to ICICI`);
            assert.strictEqual(await CheckoutSession.countDocuments(), sessions, `${label}: no session / stock hold`);
          } else assert.strictEqual(sent.at(-1)!.url, sale, `${label}: sale sent to the configured URL`);
        }
      } finally { setEnv(saved); }
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
