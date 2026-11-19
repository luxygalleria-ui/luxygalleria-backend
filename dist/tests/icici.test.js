"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * ICICI Orange PG: hash rules, initiate -> return URL -> order, advices, status, refund.
 * Needs a local MongoDB; uses (and drops) a throwaway database. ICICI is stubbed at fetch(): no network.
 * Run: npx ts-node --transpile-only src/tests/icici.test.ts
 */
const assert_1 = __importDefault(require("assert"));
const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_icici_test';
const KEY = 'icici_test_key';
Object.assign(process.env, {
    NODE_ENV: 'development', HISTORY_READ_ENABLED: 'false', SENDGRID_API_KEY: '', FRONTEND_URL: 'https://shop.test',
    ICICI_PG_MERCHANT_ID: '100000000007164', ICICI_PG_SECRET_KEY: KEY, ICICI_PG_AGGREGATOR_ID: 'A100000000007164', ICICI_PG_CURRENCY_CODE: '356',
    ICICI_PG_INITIATE_SALE_URL: 'https://icici.test/initiateSale', ICICI_PG_COMMAND_URL: 'https://icici.test/command',
    ICICI_PG_RETURN_URL: 'https://api.shop.test/api/v1/payments/icici/callback',
});
const mongoose_1 = __importDefault(require("mongoose"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const app_1 = __importDefault(require("../app"));
const env_1 = require("../config/env");
const User_1 = require("../models/User");
const Product_1 = require("../models/Product");
const Cart_1 = require("../models/Cart");
const Order_1 = __importDefault(require("../models/Order"));
const CheckoutSession_1 = require("../models/CheckoutSession");
const iciciPg_1 = require("../utils/iciciPg");
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`); };
const sign = (p) => ({ ...p, secureHash: (0, iciciPg_1.hashV1)(p, KEY) });
// ---- ICICI stub: everything to icici.test is answered here; the next reply can be overridden per test
const sent = [];
let nextReply = null;
let statusReply = null; // persistent, for reconcile sweeps
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://icici.test/'))
        return realFetch(input, init);
    const body = url.endsWith('/initiateSale') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(String(init.body)));
    sent.push({ url, body });
    const reply = nextReply ? nextReply(body) : body.transactionType === 'STATUS' && statusReply ? statusReply(body) : sign({ responseCode: 'R1000', merchantId: body.merchantId, aggregatorID: null, merchantTxnNo: body.merchantTxnNo,
        redirectURI: 'https://icici.test/authRedirect', showOTPCapturePage: 'N', generateOTPURI: null, tranCtx: `R-${body.merchantTxnNo}` });
    nextReply = null;
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
const run = async () => {
    console.log('Hash rules');
    await test('V1 concatenates non-empty values by sorted key: the plain hashtext of ICICI\'s step-wise sample', async () => {
        const req = { txnDate: '20251028235959', addlParam2: '111', merchantId: '100000000006873', addlParam1: '000', aggregatorID: 'A100000000006873',
            amount: '2.00', currencyCode: '356', customerEmailID: 'dummy@gmail.com', customerMobileNo: '9090909090', customerName: 'Narayan',
            merchantTxnNo: '757585887575', payType: '0', returnURL: 'https://pgpayuat.icicibank.com/tsp/pg/api/merchant', transactionType: 'SALE', empty: '', nothing: null };
        const plain = '000111A1000000000068732.00356dummy@gmail.com9090909090Narayan1000000000068737575858875750https://pgpayuat.icicibank.com/tsp/pg/api/merchantSALE20251028235959';
        assert_1.default.strictEqual((0, iciciPg_1.hashV1)(req, 'k'), (0, iciciPg_1.hashV2)(plain, 'k'));
        assert_1.default.match((0, iciciPg_1.hashV1)(req, 'k'), /^[0-9a-f]{64}$/);
        assert_1.default.ok((0, iciciPg_1.verifyV1)(sign(req)) && !(0, iciciPg_1.verifyV1)({ ...sign(req), amount: '3.00' }) && !(0, iciciPg_1.verifyV1)({ ...req, secureHash: 'x' }));
        assert_1.default.ok((0, iciciPg_1.verifyV1)({ ...sign(req), secureHash: sign(req).secureHash.toUpperCase() }), 'case-insensitive compare');
    });
    assert_1.default.ok(TEST_DB.endsWith('_test'));
    await mongoose_1.default.connect(TEST_DB);
    await mongoose_1.default.connection.db.dropDatabase();
    await Promise.all([Order_1.default.init(), CheckoutSession_1.CheckoutSession.init()]);
    const server = app_1.default.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const call = async (path, body, token) => {
        const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
        return { status: r.status, json: await r.json().catch(() => null) };
    };
    // Exactly what the customer's browser sends: a cross-site form post carrying ICICI's Origin
    const formPost = async (path, params) => {
        const r = await fetch(base + path, { method: 'POST', redirect: 'manual', body: new URLSearchParams(params),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://pgpayuat.icicibank.com' } });
        return { status: r.status, location: r.headers.get('location') };
    };
    try {
        const mk = (name, role) => User_1.User.create({ name, email: `${name.toLowerCase()}@test.local`, password: 'Passw0rd#123', role, isVerified: true });
        const [superU, ann, ben] = await Promise.all([mk('Super', 'superadmin'), mk('Ann', 'customer'), mk('Ben', 'customer')]);
        const tok = (u) => jsonwebtoken_1.default.sign({ id: String(u._id), role: u.role }, env_1.ENV.JWT_SECRET, { expiresIn: '30m' });
        const [superT, annT, benT] = [superU, ann, ben].map(tok);
        const address = { street: '1 MG Road', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' };
        const tea = await Product_1.Product.create({ name: 'Tea', category: 'Snacks', description: 'Tea', variants: [{ volume: '200g', price: 300, offerPrice: 300, actualPrice: 300, stock: 10, weight: 0.2 }], stock: 10 });
        const items = [{ product: String(tea._id), variantId: String(tea.variants[0]._id), quantity: 2 }];
        const stock = async () => (await Product_1.Product.findById(tea._id).lean()).variants[0].stock;
        const total = (await call('/payments/calculate-shipping', { items, shippingAddress: address, fulfillment: { method: 'delivery' } })).json.data.grandTotal;
        const initiate = (token = annT) => call('/payments/icici/initiate', { items, shippingAddress: address, fulfillment: { method: 'delivery' }, total }, token);
        const paid = (txnNo, extra = {}) => sign({ responseCode: '0000', respDescription: 'Transaction successful',
            merchantId: '100000000007164', aggregatorID: 'A100000000007164', merchantTxnNo: txnNo, txnID: `T${txnNo}`, paymentDateTime: '20261119101010',
            paymentMode: 'CARD', amount: total.toFixed(2), ...extra });
        console.log('Initiate and return URL');
        let txnNo = '';
        await test('initiate prices on the server, reserves stock and returns redirectURI?tranCtx=', async () => {
            const r = await initiate();
            assert_1.default.strictEqual(r.status, 200, JSON.stringify(r.json));
            txnNo = r.json.data.merchantTxnNo;
            assert_1.default.match(txnNo, /^[A-Z0-9]{1,20}$/);
            assert_1.default.strictEqual(r.json.data.redirectUrl, `https://icici.test/authRedirect?tranCtx=R-${txnNo}`);
            const req = sent.at(-1).body;
            assert_1.default.deepStrictEqual([req.merchantId, req.aggregatorID, req.amount, req.currencyCode, req.payType, req.transactionType, req.customerEmailID], ['100000000007164', 'A100000000007164', total.toFixed(2), '356', '0', 'SALE', 'ann@test.local']);
            assert_1.default.match(req.txnDate, /^\d{14}$/);
            assert_1.default.ok((0, iciciPg_1.verifyV1)(req), 'request carries a valid secureHash');
            assert_1.default.strictEqual(await stock(), 8);
            const s = await CheckoutSession_1.CheckoutSession.findOne({ razorpayOrderId: txnNo }).lean();
            assert_1.default.deepStrictEqual([s.gateway, s.status], ['icici', 'pending']);
        });
        await test('a forged or wrong-amount return URL post creates no order', async () => {
            const forged = await formPost('/payments/icici/callback', { ...paid(txnNo), secureHash: 'f'.repeat(64) });
            // Unverifiable is never "try again": if it was our bug and money moved, a second payment would follow
            assert_1.default.deepStrictEqual([forged.status, forged.location], [302, 'https://shop.test/order-failure?reason=unconfirmed']);
            const wrong = await formPost('/payments/icici/callback', paid(txnNo, { amount: '1.00' }));
            assert_1.default.strictEqual(wrong.location, 'https://shop.test/order-failure?reason=unconfirmed');
            assert_1.default.strictEqual(await Order_1.default.countDocuments(), 0);
        });
        await test('a signed success creates the order once, clears the cart and redirects to /order-success (CORS bypassed)', async () => {
            await Cart_1.Cart.create({ user: ann._id, items: [{ product: tea._id, variantId: tea.variants[0]._id, quantity: 2 }] }).catch(() => Cart_1.Cart.updateOne({ user: ann._id }, { $set: { items: [{ product: tea._id, variantId: tea.variants[0]._id, quantity: 2 }] } }));
            const r = await formPost('/payments/icici/callback', paid(txnNo));
            assert_1.default.deepStrictEqual([r.status, r.location], [302, 'https://shop.test/order-success']);
            const again = await formPost('/payments/icici/callback', paid(txnNo)); // browser refresh / replay
            assert_1.default.strictEqual(again.location, 'https://shop.test/order-success');
            const advice = await formPost('/payments/icici/payment-advice', paid(txnNo));
            assert_1.default.strictEqual(advice.status, 200);
            const orders = await Order_1.default.find({ razorpayOrderId: txnNo }).lean();
            assert_1.default.strictEqual(orders.length, 1);
            const o = orders[0];
            assert_1.default.deepStrictEqual([o.paymentMethod, o.paymentStatus, o.iciciTxnId, o.razorpayPaymentId, Math.round(o.total * 100)], ['icici', 'completed', `T${txnNo}`, undefined, Math.round(total * 100)]);
            assert_1.default.strictEqual((await Cart_1.Cart.findOne({ user: ann._id }).lean()).items.length, 0);
            assert_1.default.strictEqual(await stock(), 8, 'stock taken once');
        });
        await test('a declined payment releases the reserved stock at once', async () => {
            const r = await initiate();
            const t = r.json.data.merchantTxnNo;
            assert_1.default.strictEqual(await stock(), 6);
            const back = await formPost('/payments/icici/callback', paid(t, { responseCode: 'E005', respDescription: 'Declined' }));
            assert_1.default.strictEqual(back.location, 'https://shop.test/order-failure');
            assert_1.default.strictEqual(await stock(), 8);
            assert_1.default.strictEqual(await Order_1.default.countDocuments({ razorpayOrderId: t }), 0);
        });
        await test('UPI R1000 (pending) on the return URL is "unconfirmed"; the later payment advice completes the order', async () => {
            const t = (await initiate()).json.data.merchantTxnNo;
            assert_1.default.strictEqual((await formPost('/payments/icici/callback', paid(t, { responseCode: 'R1000' }))).location, 'https://shop.test/order-failure?reason=unconfirmed');
            assert_1.default.strictEqual(await Order_1.default.countDocuments({ razorpayOrderId: t }), 0);
            // Advice in JSON (merchant opted for JSON at onboarding)
            const r = await fetch(`${base}/payments/icici/payment-advice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(paid(t)) });
            assert_1.default.strictEqual(r.status, 200);
            assert_1.default.strictEqual(await Order_1.default.countDocuments({ razorpayOrderId: t }), 1);
            const bad = await fetch(`${base}/payments/icici/payment-advice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...paid(t), secureHash: 'x' }) });
            assert_1.default.strictEqual(bad.status, 400);
        });
        await test('a gateway response with a bad secureHash is refused and the stock released', async () => {
            const before = await stock();
            nextReply = (b) => ({ ...sign({ responseCode: 'R1000', merchantTxnNo: b.merchantTxnNo, redirectURI: 'https://evil.test', tranCtx: 'x' }), tranCtx: 'tampered' });
            const r = await initiate();
            assert_1.default.strictEqual(r.status, 502);
            assert_1.default.strictEqual(await stock(), before);
        });
        await test('a retry after backing out of ICICI is not blocked by the customer\'s own earlier hold', async () => {
            const before = await stock();
            const first = (await initiate()).json.data.merchantTxnNo;
            assert_1.default.strictEqual(await stock(), before - 2);
            const second = await initiate();
            assert_1.default.strictEqual(second.status, 200);
            assert_1.default.strictEqual(await stock(), before - 2, 'first hold released, second taken');
            assert_1.default.strictEqual((await CheckoutSession_1.CheckoutSession.findOne({ razorpayOrderId: first }).lean()).status, 'expired');
            // The abandoned first one is paid after all: it re-reserves and still becomes an order
            assert_1.default.strictEqual((await formPost('/payments/icici/callback', paid(first))).location, 'https://shop.test/order-success');
            assert_1.default.strictEqual(await stock(), before - 4);
            await formPost('/payments/icici/callback', paid(second.json.data.merchantTxnNo, { responseCode: 'E005' })); // tidy: decline the second
        });
        console.log('Status, refund, settlement');
        await test('admin reconcile asks ICICI about open sessions and completes a pending UPI payment', async () => {
            const t = (await initiate()).json.data.merchantTxnNo;
            await formPost('/payments/icici/callback', paid(t, { responseCode: 'R1000' }));
            statusReply = (b) => b.originalTxnNo === t
                ? sign({ responseCode: '000', merchantId: b.merchantId, merchantTxnNo: t, txnStatus: 'SUC', txnResponseCode: '0000', txnID: 'T-rec', amount: total.toFixed(2) })
                : sign({ responseCode: 'E001', respDescription: 'Transaction not found' });
            const r = await fetch(`${base}/payments/admin/reconcile`, { method: 'POST', headers: { Authorization: `Bearer ${superT}` } });
            const j = await r.json();
            statusReply = null;
            assert_1.default.strictEqual(r.status, 200, JSON.stringify(j));
            assert_1.default.ok(j.data.icici.includes(`${t}: SUC -> created`), JSON.stringify(j.data));
            assert_1.default.strictEqual((await Order_1.default.findOne({ razorpayOrderId: t }).lean()).iciciTxnId, 'T-rec');
        });
        await test('status: owner or admin only; a confirmed SUC recovers a lost return URL', async () => {
            const t = (await initiate()).json.data.merchantTxnNo;
            assert_1.default.strictEqual((await call('/payments/icici/status', { merchantTxnNo: t }, benT)).status, 404, 'another customer');
            nextReply = (b) => sign({ responseCode: '000', merchantId: b.merchantId, merchantTxnNo: t, txnStatus: 'SUC', txnResponseCode: '0000', txnID: 'T-status', amount: total.toFixed(2), oth_charge: false });
            const r = await call('/payments/icici/status', { merchantTxnNo: t }, annT);
            assert_1.default.strictEqual(r.status, 200, JSON.stringify(r.json));
            assert_1.default.deepStrictEqual([r.json.data.txnStatus, r.json.data.outcome], ['SUC', 'created']);
            const cmd = sent.at(-1).body;
            assert_1.default.deepStrictEqual([cmd.transactionType, cmd.merchantTxnNo, cmd.originalTxnNo], ['STATUS', t, t]);
            assert_1.default.ok((0, iciciPg_1.verifyV1)(cmd));
            assert_1.default.strictEqual((await Order_1.default.findOne({ razorpayOrderId: t }).lean()).iciciTxnId, 'T-status');
        });
        await test('refund: super admin only, signed REFUND for the full amount, idempotent', async () => {
            const o = await Order_1.default.findOne({ razorpayOrderId: txnNo });
            assert_1.default.strictEqual((await call('/payments/icici/refund', { orderId: String(o._id), reason: 'customer request' }, annT)).status, 403);
            nextReply = (b) => sign({ responseCode: '000', respDescription: 'Request processed successfully', merchantId: b.merchantId, merchantTxnNo: b.merchantTxnNo, txnID: 'RF1' });
            const r = await call('/payments/icici/refund', { orderId: String(o._id), reason: 'customer request' }, superT);
            assert_1.default.strictEqual(r.status, 200, JSON.stringify(r.json));
            const cmd = sent.at(-1).body;
            assert_1.default.deepStrictEqual([cmd.transactionType, cmd.originalTxnNo, cmd.amount], ['REFUND', txnNo, total.toFixed(2)]);
            assert_1.default.ok((0, iciciPg_1.verifyV1)(cmd) && cmd.merchantTxnNo !== txnNo);
            const after = await Order_1.default.findById(o._id).lean();
            assert_1.default.deepStrictEqual([after.paymentStatus, after.refund.status], ['refunded', 'processed']);
            const calls = sent.length;
            assert_1.default.strictEqual((await call('/payments/icici/refund', { orderId: String(o._id), reason: 'again' }, superT)).status, 200);
            assert_1.default.strictEqual(sent.length, calls, 'no second refund request');
            // The Razorpay refund route never touches an ICICI order
            assert_1.default.strictEqual((await call(`/payments/admin/orders/${o._id}/refund`, { reason: 'x'.repeat(5) }, superT)).status, 400);
        });
        await test('settlement advice is recorded on the order; unsigned ones are refused', async () => {
            const adv = sign({ merchantId: '100000000007164', merchantTxnNo: txnNo, settlementID: 'A00121-20261120-010', settlementDate: '20261120', settledAmount: total.toFixed(2) });
            const ok = await fetch(`${base}/payments/icici/settlement-advice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(adv) });
            assert_1.default.strictEqual(ok.status, 200);
            assert_1.default.strictEqual((await Order_1.default.findOne({ razorpayOrderId: txnNo }).lean()).iciciSettlement.settlementID, 'A00121-20261120-010');
            const bad = await fetch(`${base}/payments/icici/settlement-advice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...adv, settledAmount: '1.00' }) });
            assert_1.default.strictEqual(bad.status, 400);
        });
        console.log(`\n${passed} passed`);
    }
    finally {
        server.close();
        await mongoose_1.default.connection.db.dropDatabase();
        await mongoose_1.default.disconnect();
    }
};
run().catch((err) => { console.error('❌', err); process.exit(1); });
//# sourceMappingURL=icici.test.js.map