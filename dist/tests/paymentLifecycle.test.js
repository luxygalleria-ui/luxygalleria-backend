"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Payment lifecycle: quote snapshots, stock reservation races, expiry, webhooks, reconciliation and refunds.
 * Needs a local MongoDB; uses (and drops) a throwaway database. Razorpay is fully stubbed: no network, no real refunds.
 * Run: npx ts-node --transpile-only src/tests/paymentLifecycle.test.ts
 */
const assert_1 = __importDefault(require("assert"));
const crypto_1 = __importDefault(require("crypto"));
const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_payment_lifecycle_test';
process.env.NODE_ENV = 'development';
process.env.HISTORY_READ_ENABLED = 'false';
process.env.SENDGRID_API_KEY = '';
const mongoose_1 = __importDefault(require("mongoose"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const app_1 = __importDefault(require("../app"));
const env_1 = require("../config/env");
const User_1 = require("../models/User");
const Product_1 = require("../models/Product");
const Order_1 = __importDefault(require("../models/Order"));
const CheckoutSession_1 = require("../models/CheckoutSession");
const paymentController_1 = require("../controllers/paymentController");
const checkoutSessions_1 = require("../utils/checkoutSessions");
const SECRET = 'lifecycle_key_secret';
const WEBHOOK_SECRET = 'lifecycle_webhook_secret';
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`); };
// ---- Razorpay stub: records every call; any unexpected call fails the test instead of reaching the network
const gw = {
    orders: new Map(),
    payments: new Map(),
    refunds: new Map(), // paymentId -> refunds held by the "gateway"
    refundCalls: 0,
    refundFails: 0, // next N refund calls throw (simulated timeout) AFTER the gateway recorded the refund
    n: 0,
};
const installStubs = () => {
    paymentController_1.razorpayInstance.orders.create = async (o) => { const ord = { id: `order_lc${++gw.n}`, amount: o.amount, currency: o.currency }; gw.orders.set(ord.id, ord); return ord; };
    paymentController_1.razorpayInstance.orders.fetchPayments = async (orderId) => ({ items: [...gw.payments.values()].filter((p) => p.order_id === orderId) });
    paymentController_1.razorpayInstance.payments.fetch = async (id) => { const p = gw.payments.get(id); if (!p)
        throw new Error(`unexpected payment ${id}`); return p; };
    paymentController_1.razorpayInstance.payments.fetchMultipleRefund = async (pid) => ({ items: gw.refunds.get(pid) || [] });
    paymentController_1.razorpayInstance.payments.fetchRefund = async (pid, rid) => (gw.refunds.get(pid) || []).find((r) => r.id === rid);
    paymentController_1.razorpayInstance.payments.refund = async (pid, body) => {
        gw.refundCalls++;
        const r = { id: `rfnd_${gw.refundCalls}`, payment_id: pid, amount: body.amount, status: 'pending', notes: body.notes };
        gw.refunds.set(pid, [...(gw.refunds.get(pid) || []), r]);
        if (gw.refundFails > 0) {
            gw.refundFails--;
            throw new Error('ETIMEDOUT');
        }
        return r;
    };
};
const pay = (orderId, id, amount, status = 'captured') => { const p = { id, order_id: orderId, amount, currency: 'INR', status }; gw.payments.set(id, p); return p; };
const sign = (o, p) => crypto_1.default.createHmac('sha256', SECRET).update(`${o}|${p}`).digest('hex');
const run = async () => {
    assert_1.default.ok(TEST_DB.endsWith('_test'));
    await mongoose_1.default.connect(TEST_DB);
    await mongoose_1.default.connection.db.dropDatabase();
    await Promise.all([Order_1.default.init(), CheckoutSession_1.CheckoutSession.init()]);
    const server = app_1.default.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const call = async (method, path, body, token, headers = {}) => {
        const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
        return { status: r.status, json: await r.json().catch(() => null) };
    };
    // Real-gateway code paths with fake keys and the stubbed client
    process.env.RAZORPAY_KEY_ID = 'rzp_test_lifecycle';
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    installStubs();
    try {
        const mk = (name, role) => User_1.User.create({ name, email: `${name.toLowerCase()}@test.local`, password: 'Passw0rd#123', role, isVerified: true });
        const [superU, adminU, ann, ben] = await Promise.all([mk('Super', 'superadmin'), mk('Admin', 'admin'), mk('Ann', 'customer'), mk('Ben', 'customer')]);
        const tok = (u) => jsonwebtoken_1.default.sign({ id: String(u._id), role: u.role }, env_1.ENV.JWT_SECRET, { expiresIn: '30m' });
        const [superT, adminT, annT, benT] = [superU, adminU, ann, ben].map(tok);
        const address = { street: '1 MG Road', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' };
        const mkProduct = (name, price, stock) => Product_1.Product.create({ name, category: 'Snacks', description: name, variants: [{ volume: '200g', price, offerPrice: price, actualPrice: price, stock, weight: 0.2 }], stock });
        const item = (p, quantity = 1) => ({ product: String(p._id), variantId: String(p.variants[0]._id), quantity });
        const stockOf = async (p) => (await Product_1.Product.findById(p._id).lean()).variants[0].stock;
        const quoteTotal = async (items) => (await call('POST', '/payments/calculate-shipping', { items, shippingAddress: address, fulfillment: { method: 'delivery' } })).json.data.grandTotal;
        const checkout = async (items, token) => {
            const total = await quoteTotal(items);
            const c = await call('POST', '/payments/create-order', { items, shippingAddress: address, fulfillment: { method: 'delivery' }, total }, token);
            return { ...c, orderId: c.json?.data?.razorpayOrder?.id, paise: c.json?.data?.razorpayOrder?.amount };
        };
        const verify = (orderId, paymentId, token, extra = {}) => call('POST', '/payments/verify', { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId), ...extra }, token);
        console.log('Quote snapshot');
        await test('settings and price changes after "Pay" do not affect the verified amount or the order', async () => {
            const tea = await mkProduct('Tea', 300, 10);
            const c = await checkout([item(tea, 2)], annT);
            assert_1.default.strictEqual(c.status, 200, JSON.stringify(c.json));
            const session = await CheckoutSession_1.CheckoutSession.findOne({ razorpayOrderId: c.orderId }).lean();
            assert_1.default.deepStrictEqual([session.status, session.amountPaise, session.items[0].price, session.stockReserved], ['pending', c.paise, 300, true]);
            assert_1.default.match(session.settingsVersion, /^[0-9a-f]{16}$/);
            // Admin raises the price and the Kerala road charges after the customer pressed Pay
            await Product_1.Product.updateOne({ _id: tea._id }, { $set: { 'variants.0.offerPrice': 450, 'variants.0.price': 450 } });
            const ship = (await call('GET', '/settings/checkout', undefined, adminT)).json.data.settings.shipping;
            ship.zones.kerala.land.chargeBelow = 99;
            ship.zones.kerala.land.chargeAtOrAbove = 199;
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/shipping', ship, adminT)).status, 200);
            assert_1.default.notStrictEqual(Math.round((await quoteTotal([item(tea, 2)])) * 100), c.paise, 'a new quote would differ');
            // The payment for the original amount is accepted, and the order records the snapshot
            pay(c.orderId, 'pay_snap', c.paise);
            const v = await verify(c.orderId, 'pay_snap', annT, { items: [{ ...item(tea, 9) }], total: 1 }); // body cart/total ignored
            assert_1.default.strictEqual(v.status, 200, JSON.stringify(v.json));
            const o = await Order_1.default.findById(v.json.data._id).lean();
            assert_1.default.deepStrictEqual([Math.round(o.total * 100), o.items[0].price, o.items[0].quantity, String(o.checkoutSession)], [c.paise, 300, 2, String(session._id)]);
            assert_1.default.strictEqual((await CheckoutSession_1.CheckoutSession.findById(session._id).lean()).status, 'paid');
            // A payment for the NEW amount on the old session is refused: exact match against the snapshot
            const c2 = await checkout([item(tea, 1)], annT);
            pay(c2.orderId, 'pay_wrong', c2.paise + 100);
            assert_1.default.strictEqual((await verify(c2.orderId, 'pay_wrong', annT)).status, 400);
        });
        await test('verify keeps every protection: signature, ownership, status, currency, exact paise', async () => {
            const nuts = await mkProduct('Nuts', 250, 10);
            const c = await checkout([item(nuts)], annT);
            pay(c.orderId, 'pay_auth_ok', c.paise);
            assert_1.default.strictEqual((await verify(c.orderId, 'pay_auth_ok', annT, { razorpay_signature: 'bad' })).status, 400, 'bad signature');
            assert_1.default.strictEqual((await verify(c.orderId, 'pay_auth_ok', benT)).status, 403, 'another customer cannot claim the session');
            pay(c.orderId, 'pay_usd', c.paise).currency = 'USD';
            assert_1.default.strictEqual((await verify(c.orderId, 'pay_usd', annT)).status, 400, 'currency');
            pay(c.orderId, 'pay_failed', c.paise, 'failed');
            assert_1.default.strictEqual((await verify(c.orderId, 'pay_failed', annT)).status, 400, 'failed payment');
            pay(c.orderId, 'pay_under', c.paise - 1);
            assert_1.default.strictEqual((await verify(c.orderId, 'pay_under', annT)).status, 400, 'under by one paisa');
            assert_1.default.strictEqual(await Order_1.default.countDocuments({ razorpayOrderId: c.orderId }), 0);
            assert_1.default.strictEqual((await verify('order_unknown', 'pay_x', annT)).status, 400, 'unknown session');
            assert_1.default.strictEqual((await verify(c.orderId, 'pay_auth_ok', annT)).status, 200, 'retry with the real payment succeeds');
        });
        console.log('Inventory');
        await test('concurrent checkouts cannot oversell: 6 buyers race for 3 units', async () => {
            const last = await mkProduct('Last Units', 100, 3);
            const results = await Promise.all(Array.from({ length: 6 }, (_, i) => checkout([item(last)], i % 2 ? benT : annT)));
            const ok = results.filter((r) => r.status === 200).length;
            assert_1.default.strictEqual(ok, 3, results.map((r) => r.status).join(','));
            assert_1.default.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 400 && r.json.code === 'OUT_OF_STOCK'));
            assert_1.default.strictEqual(await stockOf(last), 0, 'never negative');
        });
        await test('multi-line reservation is all or nothing (rolled back when one line is short)', async () => {
            const a = await mkProduct('Plenty', 100, 10);
            const b = await mkProduct('Scarce', 100, 1);
            const r = await checkout([item(a, 4), item(b, 2)], annT);
            assert_1.default.strictEqual(r.status, 400);
            assert_1.default.match(r.json.message, /Only 1 of Scarce/);
            assert_1.default.deepStrictEqual([await stockOf(a), await stockOf(b)], [10, 1]);
        });
        await test('expired session releases stock exactly once; a late payment re-reserves and still becomes an order', async () => {
            const p = await mkProduct('Expiring', 100, 5);
            const c = await checkout([item(p, 2)], annT);
            assert_1.default.strictEqual(await stockOf(p), 3, 'reserved at create-order');
            await CheckoutSession_1.CheckoutSession.updateOne({ razorpayOrderId: c.orderId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
            await (0, checkoutSessions_1.expireStaleSessions)();
            await (0, checkoutSessions_1.expireStaleSessions)();
            assert_1.default.strictEqual(await stockOf(p), 5, 'released once, not twice');
            assert_1.default.strictEqual((await CheckoutSession_1.CheckoutSession.findOne({ razorpayOrderId: c.orderId }).lean()).status, 'expired');
            pay(c.orderId, 'pay_late', c.paise);
            const v = await verify(c.orderId, 'pay_late', annT);
            assert_1.default.strictEqual(v.status, 200, JSON.stringify(v.json));
            assert_1.default.strictEqual(await stockOf(p), 3, 're-reserved for the paid order');
            assert_1.default.strictEqual(v.json.data.orderStatus, 'processing');
        });
        await test('payment succeeds but stock is gone: order recorded as cancelled with refund required, stock untouched', async () => {
            const p = await mkProduct('Gone', 100, 2);
            const first = await checkout([item(p, 2)], annT);
            await CheckoutSession_1.CheckoutSession.updateOne({ razorpayOrderId: first.orderId }, { $set: { expiresAt: new Date(0) } });
            await (0, checkoutSessions_1.expireStaleSessions)();
            const second = await checkout([item(p, 2)], benT); // someone else buys the released units
            pay(second.orderId, 'pay_second', second.paise);
            assert_1.default.strictEqual((await verify(second.orderId, 'pay_second', benT)).status, 200);
            pay(first.orderId, 'pay_first_late', first.paise);
            const v = await verify(first.orderId, 'pay_first_late', annT);
            assert_1.default.deepStrictEqual([v.status, v.json.code], [409, 'PAID_OUT_OF_STOCK']);
            const o = await Order_1.default.findOne({ razorpayOrderId: first.orderId }).lean();
            assert_1.default.deepStrictEqual([o.orderStatus, o.paymentStatus, o.refund.status, o.refund.amountPaise], ['cancelled', 'completed', 'required', first.paise]);
            assert_1.default.match(o.fulfillmentIssue, /no longer in stock/);
            assert_1.default.strictEqual(await stockOf(p), 0, 'not negative');
            assert_1.default.strictEqual((await CheckoutSession_1.CheckoutSession.findOne({ razorpayOrderId: first.orderId }).lean()).status, 'unfulfillable');
            const again = await verify(first.orderId, 'pay_first_late', annT);
            assert_1.default.strictEqual(again.status, 200, 'retry returns the recorded (cancelled) order, never a second one');
            assert_1.default.strictEqual(await Order_1.default.countDocuments({ razorpayOrderId: first.orderId }), 1);
        });
        console.log('Duplicates and webhooks');
        await test('concurrent duplicate verifications create one order and never touch stock again', async () => {
            const p = await mkProduct('Dup', 100, 5);
            const c = await checkout([item(p)], annT);
            pay(c.orderId, 'pay_dup', c.paise);
            const rs = await Promise.all([1, 2, 3, 4].map(() => verify(c.orderId, 'pay_dup', annT)));
            assert_1.default.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status).join(','));
            assert_1.default.strictEqual(new Set(rs.map((r) => r.json.data._id)).size, 1);
            assert_1.default.strictEqual(await Order_1.default.countDocuments({ razorpayOrderId: c.orderId }), 1);
            assert_1.default.strictEqual(await stockOf(p), 4, 'reserved once at create-order only');
        });
        await test('webhook: off without a secret, signature required, completes an order the browser never verified, duplicates are harmless', async () => {
            const p = await mkProduct('Hook', 100, 5);
            const c = await checkout([item(p)], annT);
            const payment = pay(c.orderId, 'pay_hook', c.paise);
            const event = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: payment } } });
            const hmac = crypto_1.default.createHmac('sha256', WEBHOOK_SECRET).update(event).digest('hex');
            delete process.env.RAZORPAY_WEBHOOK_SECRET;
            assert_1.default.strictEqual((await call('POST', '/payments/webhook', event, undefined, { 'X-Razorpay-Signature': hmac })).status, 503);
            process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
            assert_1.default.strictEqual((await call('POST', '/payments/webhook', event, undefined, { 'X-Razorpay-Signature': 'forged' })).status, 400);
            assert_1.default.strictEqual(await Order_1.default.countDocuments({ razorpayOrderId: c.orderId }), 0);
            const [w1, w2, v] = await Promise.all([
                call('POST', '/payments/webhook', event, undefined, { 'X-Razorpay-Signature': hmac }),
                call('POST', '/payments/webhook', event, undefined, { 'X-Razorpay-Signature': hmac }),
                verify(c.orderId, 'pay_hook', annT), // the browser arrives at the same moment
            ]);
            assert_1.default.deepStrictEqual([w1.status, w2.status, v.status], [200, 200, 200]);
            assert_1.default.strictEqual(await Order_1.default.countDocuments({ razorpayOrderId: c.orderId }), 1);
            assert_1.default.strictEqual(await stockOf(p), 4);
            // A signed event whose amount does not match the snapshot is acknowledged but never becomes an order
            const c2 = await checkout([item(p)], annT);
            const bad = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: pay(c2.orderId, 'pay_hook_bad', c2.paise + 500) } } });
            const r = await call('POST', '/payments/webhook', bad, undefined, { 'X-Razorpay-Signature': crypto_1.default.createHmac('sha256', WEBHOOK_SECRET).update(bad).digest('hex') });
            assert_1.default.strictEqual(r.status, 200);
            assert_1.default.strictEqual(await Order_1.default.countDocuments({ razorpayOrderId: c2.orderId }), 0);
        });
        console.log('Reconciliation and refunds');
        await test('reconcile: recovers a paid order, reports mismatched payments, expires stale sessions; super admin only', async () => {
            const p = await mkProduct('Recon', 100, 5);
            const lost = await checkout([item(p)], annT);
            pay(lost.orderId, 'pay_lost', lost.paise); // paid, but neither /verify nor a webhook arrived
            const odd = await checkout([item(p)], annT);
            pay(odd.orderId, 'pay_odd', odd.paise + 1);
            const stale = await checkout([item(p)], benT);
            await CheckoutSession_1.CheckoutSession.updateOne({ razorpayOrderId: stale.orderId }, { $set: { expiresAt: new Date(0) } });
            assert_1.default.strictEqual((await call('POST', '/payments/admin/reconcile', {}, adminT)).status, 403);
            const r = await call('POST', '/payments/admin/reconcile', {}, superT);
            assert_1.default.strictEqual(r.status, 200, JSON.stringify(r.json));
            const recovered = await Order_1.default.findOne({ razorpayOrderId: lost.orderId }).lean();
            assert_1.default.ok(recovered && r.json.data.recoveredOrders.includes(String(recovered._id)));
            assert_1.default.ok(r.json.data.mismatchedPayments.includes('pay_odd'));
            assert_1.default.ok(r.json.data.expiredSessions >= 1);
            const r2 = await call('POST', '/payments/admin/reconcile', {}, superT);
            assert_1.default.strictEqual(r2.json.data.recoveredOrders.length, 0, 'idempotent');
            assert_1.default.strictEqual(await Order_1.default.countDocuments({ razorpayOrderId: lost.orderId }), 1);
        });
        await test('refund: super admin only, idempotent, safe to retry after a timeout, synced by reconciliation', async () => {
            const p = await mkProduct('Refundable', 200, 5);
            const c = await checkout([item(p)], annT);
            pay(c.orderId, 'pay_refund', c.paise);
            const orderId = (await verify(c.orderId, 'pay_refund', annT)).json.data._id;
            const path = `/payments/admin/orders/${orderId}/refund`;
            assert_1.default.strictEqual((await call('POST', path, { reason: 'Customer request' }, adminT)).status, 403);
            assert_1.default.strictEqual((await call('POST', path, { reason: 'Customer request' }, annT)).status, 403);
            assert_1.default.strictEqual((await call('POST', path, {}, superT)).status, 400, 'reason required');
            // First attempt: the gateway records the refund but the response times out
            gw.refundFails = 1;
            const t1 = await call('POST', path, { reason: 'Customer request' }, superT);
            assert_1.default.deepStrictEqual([t1.status, t1.json.code], [502, 'REFUND_UNCONFIRMED']);
            assert_1.default.strictEqual(gw.refundCalls, 1);
            // Retry adopts the refund the gateway already holds instead of refunding again
            const t2 = await call('POST', path, { reason: 'Customer request' }, superT);
            assert_1.default.strictEqual(t2.status, 200, JSON.stringify(t2.json));
            assert_1.default.deepStrictEqual([gw.refundCalls, t2.json.data.status, t2.json.data.razorpayRefundId], [1, 'pending', 'rfnd_1']);
            const t3 = await call('POST', path, { reason: 'Customer request' }, superT);
            assert_1.default.deepStrictEqual([t3.status, gw.refundCalls], [200, 1], 'already issued: no new gateway call');
            // The gateway completes it; reconciliation records the outcome
            gw.refunds.get('pay_refund')[0].status = 'processed';
            const rec = await call('POST', '/payments/admin/reconcile', {}, superT);
            assert_1.default.ok(rec.json.data.refundsUpdated >= 1);
            const o = await Order_1.default.findById(orderId).lean();
            assert_1.default.deepStrictEqual([o.paymentStatus, o.refund.status, o.refund.amountPaise], ['refunded', 'processed', c.paise]);
            assert_1.default.deepStrictEqual(o.refund.events.map((e) => e.action), ['requested', 'error', 'requested', 'adopted-existing', 'gateway-status', 'gateway-status']);
            assert_1.default.ok(o.refund.events.every((e) => e.by), 'audit trail records who acted');
        });
        await test('refund refused for an authorised-only (uncaptured) payment; the paid-out-of-stock order can be refunded', async () => {
            const p = await mkProduct('AuthOnly', 100, 5);
            const c = await checkout([item(p)], annT);
            pay(c.orderId, 'pay_authorized', c.paise, 'authorized');
            const orderId = (await verify(c.orderId, 'pay_authorized', annT)).json.data._id;
            const before = gw.refundCalls;
            const r = await call('POST', `/payments/admin/orders/${orderId}/refund`, { reason: 'Cancel' }, superT);
            assert_1.default.strictEqual(r.status, 409);
            assert_1.default.match(r.json.message, /only captured payments/);
            assert_1.default.strictEqual(gw.refundCalls, before, 'no refund attempted');
            const flagged = await Order_1.default.findOne({ 'refund.status': 'required' }).lean();
            const rr = await call('POST', `/payments/admin/orders/${flagged._id}/refund`, { reason: 'Out of stock after payment' }, superT);
            assert_1.default.strictEqual(rr.status, 200, JSON.stringify(rr.json));
            assert_1.default.strictEqual(gw.refundCalls, before + 1);
        });
    }
    finally {
        await mongoose_1.default.connection.db.dropDatabase();
        await mongoose_1.default.disconnect();
        server.close();
    }
    console.log(`=== Summary: ${passed} passed, 0 failed ===`);
};
run().catch(async (e) => { console.error('❌', e?.stack || e); process.exitCode = 1; await mongoose_1.default.disconnect().catch(() => undefined); process.exit(1); });
//# sourceMappingURL=paymentLifecycle.test.js.map