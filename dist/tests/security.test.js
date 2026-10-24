"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Security regression tests for the audit fixes (SECURITY_AUDIT_REPORT.md).
 * Needs a local MongoDB; uses a throwaway database and stubs Razorpay/Google/SendGrid.
 * Run: npx ts-node --transpile-only src/tests/security.test.ts
 */
const assert_1 = __importDefault(require("assert"));
const crypto_1 = __importDefault(require("crypto"));
// Must be set before the app (and dotenv) load. Never touch the real DB, mail or payment provider.
const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_security_test';
process.env.NODE_ENV = 'development'; // keeps rate limiters off; ENV.NODE_ENV is flipped per test below
process.env.HISTORY_READ_ENABLED = 'false'; // never reach a developer's history login from .env
process.env.SENDGRID_API_KEY = '';
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
const mongoose_1 = __importDefault(require("mongoose"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const google_auth_library_1 = require("google-auth-library");
const app_1 = __importDefault(require("../app"));
const env_1 = require("../config/env");
const User_1 = require("../models/User");
const Product_1 = require("../models/Product");
const Order_1 = __importDefault(require("../models/Order"));
const paymentController_1 = require("../controllers/paymentController");
const RZP_SECRET = 'test_secret_for_signatures';
const realKeys = () => { process.env.RAZORPAY_KEY_ID = 'rzp_test_unit'; process.env.RAZORPAY_KEY_SECRET = RZP_SECRET; };
const noKeys = () => { delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET; };
let base = '';
let passed = 0;
const test = async (name, fn) => {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
};
const call = async (method, path, body, token, headers = {}) => {
    const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    }
    catch { /* non-JSON */ }
    return { status: res.status, json, headers: res.headers };
};
const sign = (orderId, paymentId) => crypto_1.default.createHmac('sha256', RZP_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
const run = async () => {
    assert_1.default.ok(TEST_DB.includes('127.0.0.1') && TEST_DB.endsWith('_test'), 'refusing to run against a non-test database');
    await mongoose_1.default.connect(TEST_DB);
    await mongoose_1.default.connection.db.dropDatabase();
    await Order_1.default.init(); // build indexes
    const server = app_1.default.listen(0);
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const admin = await User_1.User.create({ name: 'Admin', email: 'admin@test.local', password: 'Admin#12345', role: 'superadmin', isVerified: true });
    const alice = await User_1.User.create({ name: 'Alice', email: 'alice@test.local', password: 'Alice#12345', role: 'customer', isVerified: true });
    const bob = await User_1.User.create({ name: 'Bob', email: 'bob@test.local', password: 'Bob#12345', role: 'customer', isVerified: true });
    const tok = (u) => jsonwebtoken_1.default.sign({ id: u._id.toString(), role: u.role }, env_1.ENV.JWT_SECRET, { expiresIn: '1h' });
    const adminT = tok(admin), aliceT = tok(alice), bobT = tok(bob);
    const product = await Product_1.Product.create({
        name: 'Saffron', category: 'Spices', description: 'Premium saffron threads',
        variants: [{ volume: '1g', price: 500, offerPrice: 500, actualPrice: 600, stock: 5, weight: 0.001 }],
        stock: 5,
    });
    const variantId = product.variants[0]._id.toString();
    const pid = product._id.toString();
    const address = { street: '1 Test St', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' };
    const item = (quantity, price = 500) => ({ product: pid, variantId, quantity, price, size: '1g' });
    // 1 x ₹500, weight 1g -> ₹40 shipping under the default config
    const TOTAL_1 = 540;
    console.log('\nAuthentication');
    await test('C1: forged Google login (attacker-chosen email, foreign token audience) is rejected', async () => {
        google_auth_library_1.OAuth2Client.prototype.getTokenInfo = async () => ({ aud: 'someone-elses-app', email: 'admin@test.local', email_verified: true, sub: '1' });
        const r = await call('POST', '/auth/google', { credential: 'tok', googleId: '1', email: 'admin@test.local', name: 'x' });
        assert_1.default.strictEqual(r.status, 401);
        assert_1.default.ok(!r.json?.data?.token);
    });
    await test('C1: body email is ignored; identity comes from Google token', async () => {
        google_auth_library_1.OAuth2Client.prototype.getTokenInfo = async () => ({ aud: process.env.GOOGLE_CLIENT_ID, email: 'alice@test.local', email_verified: 'true', sub: 'g-alice' });
        const r = await call('POST', '/auth/google', { credential: 'tok', googleId: 'g-alice', email: 'admin@test.local' });
        assert_1.default.strictEqual(r.status, 200);
        assert_1.default.strictEqual(r.json.data.email, 'alice@test.local');
        assert_1.default.strictEqual(r.json.data.role, 'customer');
    });
    await test('C1: Google login cannot mint an admin session', async () => {
        google_auth_library_1.OAuth2Client.prototype.getTokenInfo = async () => ({ aud: process.env.GOOGLE_CLIENT_ID, email: 'admin@test.local', email_verified: true, sub: 'g-admin' });
        const r = await call('POST', '/auth/google', { credential: 'tok', googleId: 'g-admin' });
        assert_1.default.strictEqual(r.status, 403);
    });
    await test('C1: unverified Google email is rejected', async () => {
        google_auth_library_1.OAuth2Client.prototype.getTokenInfo = async () => ({ aud: process.env.GOOGLE_CLIENT_ID, email: 'new@test.local', email_verified: false, sub: 'g-new' });
        const r = await call('POST', '/auth/google', { credential: 'tok', googleId: 'g-new' });
        assert_1.default.strictEqual(r.status, 401);
    });
    await test('token signed with the old fallback secret is rejected', async () => {
        const forged = jsonwebtoken_1.default.sign({ id: admin._id.toString(), role: 'superadmin' }, 'fallback_secret');
        const r = await call('GET', '/dashboard/stats', undefined, forged);
        assert_1.default.strictEqual(r.status, 401);
    });
    await test('resend-otp never returns the OTP', async () => {
        await User_1.User.create({ name: 'Pending', email: 'pending@test.local', password: 'Pending#123', isVerified: false });
        const r = await call('POST', '/auth/resend-otp', { email: 'pending@test.local' });
        assert_1.default.strictEqual(r.status, 200);
        assert_1.default.ok(!JSON.stringify(r.json).match(/\b\d{6}\b/), 'OTP leaked in response');
    });
    console.log('\nAuthorization (customer vs admin)');
    const customerWrites = [
        ['POST', '/products', { name: 'x' }],
        ['PUT', `/products/${pid}`, { variants: [{ volume: '1g', offerPrice: 1, actualPrice: 1, stock: 1 }] }],
        ['DELETE', `/products/${pid}`],
        ['PUT', '/products/gifting', { productIds: [] }],
        ['POST', '/categories', { name: 'x' }],
        ['POST', '/brands', { name: 'x' }],
        ['POST', '/banners', { title: 'x' }],
        ['POST', '/coupons', { code: 'FREE', discount: '100%', expiryDate: '2099-01-01' }],
        ['GET', '/coupons'],
        ['POST', '/testimonials', { name: 'x' }],
        ['POST', '/upload'],
        ['PUT', '/settings', { shippingBelow500g: 0 }],
        ['GET', '/payments/admin/orders'],
        ['GET', '/users/admin/customers'],
    ];
    await test(`C2: customer gets 403 on ${customerWrites.length} admin endpoints`, async () => {
        for (const [m, p, b] of customerWrites) {
            const r = await call(m, p, b, aliceT);
            assert_1.default.strictEqual(r.status, 403, `${m} ${p} returned ${r.status}`);
        }
        const still = await Product_1.Product.findById(pid);
        assert_1.default.strictEqual(still?.variants[0].offerPrice, 500, 'price changed by customer');
    });
    await test('C2: anonymous gets 401 on admin endpoints', async () => {
        assert_1.default.strictEqual((await call('DELETE', `/products/${pid}`)).status, 401);
    });
    await test('C2: admin can still update a product', async () => {
        const r = await call('PUT', `/products/${pid}`, { description: 'Premium saffron threads, updated' }, adminT);
        assert_1.default.strictEqual(r.status, 200, JSON.stringify(r.json));
    });
    await test('admin cannot deactivate another admin via customer toggle', async () => {
        const r = await call('PUT', `/users/admin/customers/${admin._id}/toggle-status`, undefined, adminT);
        assert_1.default.strictEqual(r.status, 404);
        assert_1.default.strictEqual((await User_1.User.findById(admin._id))?.isActive, true);
    });
    await test('upload rejects non-image files (admin)', async () => {
        const fd = new FormData();
        fd.append('imageFile', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'x.html');
        const res = await fetch(`${base}/upload`, { method: 'POST', headers: { Authorization: `Bearer ${adminT}` }, body: fd });
        assert_1.default.strictEqual(res.status, 400);
    });
    console.log('\nPayments');
    await test('C3: mock payment rejected outside development', async () => {
        env_1.ENV.NODE_ENV = 'production';
        noKeys();
        try {
            const r = await call('POST', '/payments/verify', {
                razorpay_order_id: 'mock_order_1', razorpay_payment_id: 'mock_payment', razorpay_signature: 'mock_signature',
                items: [item(1)], shippingAddress: address, total: TOTAL_1,
            }, aliceT);
            assert_1.default.strictEqual(r.status, 400);
            const c = await call('POST', '/payments/create-order', { total: TOTAL_1, items: [item(1)], shippingAddress: address }, aliceT);
            assert_1.default.strictEqual(c.status, 503, 'production without keys must not fall back to mock orders');
        }
        finally {
            env_1.ENV.NODE_ENV = 'development';
        }
        assert_1.default.strictEqual(await Order_1.default.countDocuments(), 0);
    });
    await test('C3: mock payment rejected in development when real keys are configured', async () => {
        realKeys();
        const r = await call('POST', '/payments/verify', {
            razorpay_order_id: 'mock_order_2', razorpay_payment_id: 'mock_payment', items: [item(1)], shippingAddress: address, total: TOTAL_1,
        }, aliceT);
        assert_1.default.strictEqual(r.status, 400);
    });
    await test('mock checkout still works in local development without keys; order uses DB price', async () => {
        noKeys();
        const c = await call('POST', '/payments/create-order', { total: TOTAL_1, items: [item(1)], shippingAddress: address }, aliceT);
        assert_1.default.strictEqual(c.status, 200);
        assert_1.default.ok(c.json.data.isMock);
        const r = await call('POST', '/payments/verify', {
            razorpay_order_id: c.json.data.razorpayOrder.id, razorpay_payment_id: 'mock_payment', razorpay_signature: 'mock_signature',
            items: [item(1, 1)], shippingAddress: address, total: TOTAL_1,
        }, aliceT);
        assert_1.default.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert_1.default.strictEqual(r.json.data.items[0].price, 500, 'client-sent price stored');
        assert_1.default.strictEqual((await Product_1.Product.findById(pid))?.variants[0].stock, 4);
    });
    realKeys();
    let created = null;
    paymentController_1.razorpayInstance.orders.create = async (o) => { created = o; return { id: `order_${Date.now()}`, amount: o.amount, currency: 'INR' }; };
    const payments = {};
    paymentController_1.razorpayInstance.payments.fetch = async (id) => payments[id];
    await test('create-order charges the server-calculated amount', async () => {
        const c = await call('POST', '/payments/create-order', { total: TOTAL_1, items: [item(1, 1)], shippingAddress: address }, aliceT);
        assert_1.default.strictEqual(c.status, 200);
        assert_1.default.strictEqual(created.amount, TOTAL_1 * 100);
    });
    await test('invalid quantities / ids / oversell rejected before payment', async () => {
        for (const items of [[item(0.5)], [item(-1)], [item(1000)], [{ ...item(1), product: 'not-an-id' }], [{ ...item(1), product: { $ne: null } }]]) {
            const r = await call('POST', '/payments/create-order', { total: 1, items, shippingAddress: address }, aliceT);
            assert_1.default.strictEqual(r.status, 400, JSON.stringify(items));
        }
        const r = await call('POST', '/payments/create-order', { total: 500 * 5 + 40, items: [item(5)], shippingAddress: address }, aliceT);
        assert_1.default.strictEqual(r.status, 400, 'oversell allowed');
        assert_1.default.match(r.json.message, /left in stock/);
    });
    await test('invalid Razorpay signature rejected', async () => {
        payments.pay_bad = { order_id: 'order_a', status: 'captured', amount: TOTAL_1 * 100, currency: 'INR' };
        const r = await call('POST', '/payments/verify', {
            razorpay_order_id: 'order_a', razorpay_payment_id: 'pay_bad', razorpay_signature: 'deadbeef', items: [item(1)], shippingAddress: address, total: TOTAL_1,
        }, aliceT);
        assert_1.default.strictEqual(r.status, 400);
    });
    await test('C4: valid signature for a cheaper payment cannot buy a pricier cart', async () => {
        payments.pay_cheap = { order_id: 'order_cheap', status: 'captured', amount: 100 * 100, currency: 'INR' };
        const r = await call('POST', '/payments/verify', {
            razorpay_order_id: 'order_cheap', razorpay_payment_id: 'pay_cheap', razorpay_signature: sign('order_cheap', 'pay_cheap'),
            items: [item(2)], shippingAddress: address, total: 1040,
        }, aliceT);
        assert_1.default.strictEqual(r.status, 400);
    });
    await test('C4: payment belonging to a different Razorpay order rejected', async () => {
        payments.pay_other = { order_id: 'order_zzz', status: 'captured', amount: TOTAL_1 * 100, currency: 'INR' };
        const r = await call('POST', '/payments/verify', {
            razorpay_order_id: 'order_b', razorpay_payment_id: 'pay_other', razorpay_signature: sign('order_b', 'pay_other'),
            items: [item(1)], shippingAddress: address, total: TOTAL_1,
        }, aliceT);
        assert_1.default.strictEqual(r.status, 400);
    });
    await test('legit Razorpay payment creates exactly one order and decrements stock once', async () => {
        payments.pay_ok = { order_id: 'order_ok', status: 'captured', amount: TOTAL_1 * 100, currency: 'INR' };
        const body = {
            razorpay_order_id: 'order_ok', razorpay_payment_id: 'pay_ok', razorpay_signature: sign('order_ok', 'pay_ok'),
            items: [item(1, 1)], shippingAddress: address, total: TOTAL_1,
        };
        const before = (await Product_1.Product.findById(pid)).variants[0].stock;
        const r1 = await call('POST', '/payments/verify', body, aliceT);
        assert_1.default.strictEqual(r1.status, 200, JSON.stringify(r1.json));
        assert_1.default.strictEqual(r1.json.data.total, TOTAL_1);
        assert_1.default.strictEqual(r1.json.data.items[0].price, 500);
        // C5: replay by the same user is idempotent, by another user is refused
        const r2 = await call('POST', '/payments/verify', body, aliceT);
        assert_1.default.strictEqual(r2.status, 200);
        assert_1.default.strictEqual(r2.json.data._id, r1.json.data._id);
        const r3 = await call('POST', '/payments/verify', body, bobT);
        assert_1.default.strictEqual(r3.status, 409);
        assert_1.default.strictEqual(await Order_1.default.countDocuments({ razorpayPaymentId: 'pay_ok' }), 1);
        assert_1.default.strictEqual((await Product_1.Product.findById(pid)).variants[0].stock, before - 1);
    });
    await test('C5: database refuses a second order for the same Razorpay order', async () => {
        const o = await Order_1.default.findOne({ razorpayPaymentId: 'pay_ok' }).lean();
        const { _id, ...copy } = o;
        await assert_1.default.rejects(Order_1.default.create({ ...copy, razorpayPaymentId: 'pay_dup' }), /E11000/);
    });
    console.log('\nOrders');
    await test('customers only see their own orders', async () => {
        const mine = await call('GET', '/payments/myorders', undefined, bobT);
        assert_1.default.strictEqual(mine.status, 200);
        assert_1.default.strictEqual(mine.json.data.length, 0);
    });
    await test('admin cannot set an invalid order status', async () => {
        const o = await Order_1.default.findOne({ razorpayPaymentId: 'pay_ok' });
        const bad = await call('PUT', `/payments/admin/orders/${o._id}/status`, { orderStatus: '<b>hacked</b>' }, adminT);
        assert_1.default.strictEqual(bad.status, 400);
        const good = await call('PUT', `/payments/admin/orders/${o._id}/status`, { orderStatus: 'shipped' }, adminT);
        assert_1.default.strictEqual(good.status, 200);
    });
    console.log('\nHTTP');
    await test('CORS: foreign *.vercel.app origin not allowed, production origin allowed', async () => {
        const evil = await call('GET', '/health', undefined, undefined, { Origin: 'https://attacker-demo.vercel.app' });
        assert_1.default.notStrictEqual(evil.headers.get('access-control-allow-origin'), 'https://attacker-demo.vercel.app');
        const ok = await call('GET', '/health', undefined, undefined, { Origin: 'https://luxygalleria-frontend.vercel.app' });
        assert_1.default.strictEqual(ok.headers.get('access-control-allow-origin'), 'https://luxygalleria-frontend.vercel.app');
    });
    await test('CORS: custom domains allowed (GET + preflight), unknown origin gets 403', async () => {
        for (const origin of ['https://luxygalleria.com', 'https://www.luxygalleria.com', 'https://admin.luxygalleria.com']) {
            const get = await call('GET', '/banners', undefined, undefined, { Origin: origin });
            assert_1.default.strictEqual(get.status, 200);
            assert_1.default.strictEqual(get.headers.get('access-control-allow-origin'), origin);
            assert_1.default.strictEqual(get.headers.get('access-control-allow-credentials'), 'true');
            const pre = await fetch(base + '/auth/login', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' } });
            assert_1.default.ok(pre.status === 200 || pre.status === 204);
            assert_1.default.strictEqual(pre.headers.get('access-control-allow-origin'), origin);
            assert_1.default.match(pre.headers.get('access-control-allow-headers') || '', /authorization/i);
        }
        const evil = await call('GET', '/banners', undefined, undefined, { Origin: 'https://evil.example.com' });
        assert_1.default.strictEqual(evil.status, 403);
        assert_1.default.strictEqual(evil.headers.get('access-control-allow-origin'), null);
    });
    await test('product search treats regex metacharacters literally', async () => {
        const r = await call('GET', `/products?search=${encodeURIComponent('(a+)+$')}`);
        assert_1.default.strictEqual(r.status, 200);
    });
    server.close();
    assert_1.default.strictEqual(mongoose_1.default.connection.name, 'luxy_security_test');
    await mongoose_1.default.connection.db.dropDatabase();
    await mongoose_1.default.disconnect();
    console.log(`\n=== Summary: ${passed} passed, 0 failed ===`);
};
run().catch(async (err) => {
    console.error('\n❌ FAILED:', err);
    try {
        if (mongoose_1.default.connection.name === 'luxy_security_test')
            await mongoose_1.default.connection.db.dropDatabase();
        await mongoose_1.default.disconnect();
    }
    catch { /* ignore */ }
    process.exit(1);
});
//# sourceMappingURL=security.test.js.map