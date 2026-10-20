"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Admin ERP test console tests (/api/v1/erp-console/*).
 * Needs a local MongoDB; uses a throwaway database and never calls Cloudinary, SendGrid or Razorpay.
 * Run: npm run test:erp-console
 */
const assert_1 = __importDefault(require("assert"));
const http_1 = __importDefault(require("http"));
const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_erp_console_test';
const KEY_ID = 'erp-staging';
const SECRET = 'test_erp_console_secret_0123456789abcdef';
process.env.NODE_ENV = 'development'; // keeps rate limiters off
process.env.SENDGRID_API_KEY = '';
process.env.ERP_API_KEYS = `${KEY_ID}:${SECRET}`;
process.env.ERP_CONSOLE_KEY_ID = KEY_ID;
const mongoose_1 = __importDefault(require("mongoose"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const app_1 = __importDefault(require("../app"));
const env_1 = require("../config/env");
const User_1 = require("../models/User");
const Product_1 = require("../models/Product");
const Category_1 = require("../models/Category");
const Order_1 = __importDefault(require("../models/Order"));
const erpController_1 = require("../controllers/erpController");
let origin = '';
let passed = 0;
const test = async (name, fn) => {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
};
let adminToken = '';
const call = async (method, path, body, o = {}) => {
    const headers = {};
    const token = o.token === undefined ? adminToken : o.token;
    if (token)
        headers.Authorization = `Bearer ${token}`;
    if (o.confirm ?? method !== 'GET')
        headers['X-ERP-Console-Confirm'] = 'write';
    if (body !== undefined)
        headers['Content-Type'] = 'application/json';
    const res = await fetch(origin + '/api/v1/erp-console' + path, { method, headers, body: o.form ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) };
};
const run = async () => {
    assert_1.default.ok(TEST_DB.includes('127.0.0.1') && TEST_DB.endsWith('_test'), 'refusing to run against a non-test database');
    await mongoose_1.default.connect(TEST_DB);
    await mongoose_1.default.connection.db.dropDatabase();
    await Promise.all([Order_1.default.init(), Product_1.Product.init()]);
    const server = app_1.default.listen(0);
    origin = `http://127.0.0.1:${server.address().port}`;
    const admin = await User_1.User.create({ name: 'Admin', email: 'admin@test.local', password: 'Admin#12345', role: 'admin', isVerified: true });
    const alice = await User_1.User.create({ name: 'Alice', email: 'alice@test.local', password: 'Alice#12345', role: 'customer', isVerified: true });
    adminToken = jsonwebtoken_1.default.sign({ id: admin._id.toString(), role: admin.role }, env_1.ENV.JWT_SECRET, { expiresIn: '1h' });
    const customerToken = jsonwebtoken_1.default.sign({ id: alice._id.toString(), role: alice.role }, env_1.ENV.JWT_SECRET, { expiresIn: '1h' });
    await Category_1.Category.create({ name: 'Chocolates', image: 'https://res.cloudinary.com/x/c.jpg' });
    console.log('\nAccess control');
    await test('no token is 401, a customer is 403', async () => {
        assert_1.default.strictEqual((await call('GET', '/status', undefined, { token: null })).status, 401);
        assert_1.default.strictEqual((await call('GET', '/orders', undefined, { token: customerToken })).status, 403);
    });
    await test('status reports the key id and never the secret', async () => {
        const r = await call('GET', '/status');
        assert_1.default.deepStrictEqual(r.json.data, { enabled: true, keyId: KEY_ID });
        assert_1.default.ok(!r.text.includes(SECRET));
    });
    await test('disabled unless ERP_CONSOLE_KEY_ID names a configured key', async () => {
        process.env.ERP_CONSOLE_KEY_ID = 'not-configured';
        const r = await call('GET', '/orders');
        assert_1.default.strictEqual(r.status, 503);
        assert_1.default.strictEqual((await call('GET', '/status')).json.data.enabled, false);
        process.env.ERP_CONSOLE_KEY_ID = KEY_ID;
    });
    await test('writes without the confirmation header are refused and change nothing', async () => {
        const r = await call('POST', '/items', { name: 'X', description: 'X', category: 'Chocolates', variants: [{ sku: 'NOPE-1', offerPrice: 1, actualPrice: 1 }] }, { confirm: false });
        assert_1.default.strictEqual(r.status, 400);
        assert_1.default.strictEqual(r.json.errors[0].code, 'CONFIRMATION_REQUIRED');
        assert_1.default.strictEqual(await Product_1.Product.countDocuments(), 0);
    });
    await test('only the mirrored routes exist; dot segments are refused', async () => {
        assert_1.default.strictEqual((await call('GET', '/products')).status, 404);
        // fetch() would normalise these away client-side; send the raw path as a hostile client could
        const raw = (method, path) => new Promise((resolve, reject) => {
            const { hostname, port } = new URL(origin);
            http_1.default.request({ hostname, port, path: '/api/v1/erp-console' + path, method, headers: { Authorization: `Bearer ${adminToken}`, 'X-ERP-Console-Confirm': 'write' } }, (r) => { r.resume(); resolve(r.statusCode); })
                .on('error', reject).end();
        });
        assert_1.default.strictEqual(await raw('PUT', '/stock/%2E%2E'), 400);
        assert_1.default.strictEqual(await raw('GET', '/orders/..'), 400);
    });
    console.log('\nForwarding to the real ERP API');
    await test('item add is signed server-side and reaches POST /erp/items', async () => {
        const r = await call('POST', '/items', {
            name: 'Dark Chocolate', description: '70% cocoa', category: 'Chocolates',
            variants: [{ sku: 'LG-CHOC-100G', size: '100g', offerPrice: 299, actualPrice: 349, stock: 40 }],
        });
        assert_1.default.strictEqual(r.status, 200, r.text);
        assert_1.default.strictEqual(r.json.data.status, 201, r.text);
        assert_1.default.deepStrictEqual(r.json.data.request, { method: 'POST', path: '/api/v1/erp/items' });
        assert_1.default.strictEqual(r.json.data.body.data.action, 'created');
        assert_1.default.ok(!r.text.includes(SECRET) && !/signature"\s*:/i.test(r.text), 'no secret or signature in the response');
        assert_1.default.strictEqual(await Product_1.Product.countDocuments({ 'variants.sku': 'LG-CHOC-100G' }), 1);
    });
    await test('ERP validation errors come back as data, not as a console failure', async () => {
        const r = await call('POST', '/items', { name: 'Bad', variants: [{ sku: 'B-1', offerPrice: 500, actualPrice: 100 }] });
        assert_1.default.strictEqual(r.status, 200);
        assert_1.default.strictEqual(r.json.data.status, 400);
        assert_1.default.strictEqual(r.json.data.body.message, 'Validation failed');
    });
    await test('stock update and item edit', async () => {
        const s = await call('PUT', '/stock/LG-CHOC-100G', { quantity: 25, asOf: new Date().toISOString() });
        assert_1.default.strictEqual(s.json.data.status, 200, s.text);
        assert_1.default.strictEqual(s.json.data.body.data.quantity, 25);
        const p = await call('PATCH', '/items/LG-CHOC-100G', { offerPrice: 279 });
        assert_1.default.strictEqual(p.json.data.status, 200, p.text);
        assert_1.default.strictEqual(p.json.data.body.data.variant.offerPrice, 279);
        const missing = await call('PATCH', '/items/UNKNOWN-SKU', { offerPrice: 1 });
        assert_1.default.strictEqual(missing.status, 200); // the admin session is untouched...
        assert_1.default.strictEqual(missing.json.data.status, 404); // ...and the ERP's 404 is shown
    });
    const product = await Product_1.Product.findOne({ 'variants.sku': 'LG-CHOC-100G' });
    const order = await Order_1.default.create({
        user: alice._id,
        items: [{ product: product._id, variantId: product.variants[0]._id, quantity: 1, price: 279, subtotal: 279 }],
        shippingAddress: { street: '1 Test Road', city: 'Thalassery', state: 'Kerala', zipCode: '670101', country: 'India' },
        subtotal: 279, shippingFee: 60, total: 339, paymentMethod: 'razorpay', paymentStatus: 'completed',
    });
    await test('order list passes the query through to ERP validation', async () => {
        const r = await call('GET', '/orders?limit=10&status=processing');
        assert_1.default.strictEqual(r.json.data.status, 200, r.text);
        assert_1.default.strictEqual(r.json.data.body.data[0].orderId, String(order._id));
        assert_1.default.strictEqual((await call('GET', '/orders?limit=500')).json.data.status, 400);
    });
    await test('order details, and a bad id shows the ERP 400', async () => {
        const r = await call('GET', `/orders/${order._id}`);
        assert_1.default.strictEqual(r.json.data.status, 200, r.text);
        assert_1.default.strictEqual(r.json.data.body.data.customer.email, 'alice@test.local');
        assert_1.default.strictEqual((await call('GET', '/orders/123')).json.data.status, 400);
    });
    await test('order-status webhook applies a transition', async () => {
        const r = await call('POST', '/webhooks/order-status', {
            eventId: 'console-evt-1', orderId: String(order._id), status: 'shipped', trackingNumber: 'TRK1', occurredAt: new Date().toISOString(),
        });
        assert_1.default.strictEqual(r.json.data.status, 200, r.text);
        assert_1.default.strictEqual(r.json.data.body.data.outcome, 'applied');
        assert_1.default.strictEqual((await Order_1.default.findById(order._id)).orderStatus, 'shipped');
    });
    await test('image upload signs the file bytes and returns the stored URL', async () => {
        const realUpload = erpController_1.imageStore.upload;
        const realConfigured = erpController_1.imageStore.configured;
        erpController_1.imageStore.configured = () => true;
        erpController_1.imageStore.upload = async () => 'https://res.cloudinary.com/test/image/upload/v1/luxygalleria_products/console.png';
        try {
            const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
            const form = new FormData();
            form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'console.png');
            const r = await call('POST', '/images', undefined, { form });
            assert_1.default.strictEqual(r.json.data.status, 201, r.text);
            assert_1.default.match(r.json.data.body.data.url, /^https:\/\/res\.cloudinary\.com\//);
            const bad = new FormData();
            bad.append('image', new Blob([new Uint8Array(png)], { type: 'image/jpeg' }), 'spoof.jpg');
            assert_1.default.strictEqual((await call('POST', '/images', undefined, { form: bad })).json.data.status, 400);
        }
        finally {
            erpController_1.imageStore.upload = realUpload;
            erpController_1.imageStore.configured = realConfigured;
        }
    });
    console.log(`\n=== Summary: ${passed} passed, 0 failed ===`);
    server.close();
    await mongoose_1.default.connection.db.dropDatabase();
    await mongoose_1.default.disconnect();
};
run().catch(async (err) => {
    console.error('\n❌ FAILED:', err);
    try {
        if (mongoose_1.default.connection.name === 'luxy_erp_console_test')
            await mongoose_1.default.connection.db.dropDatabase();
        await mongoose_1.default.disconnect();
    }
    catch { /* ignore */ }
    process.exit(1);
});
//# sourceMappingURL=erpConsole.test.js.map