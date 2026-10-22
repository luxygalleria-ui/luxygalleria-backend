"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * ERP integration API tests (/api/v1/erp/*).
 * Needs a local MongoDB; uses a throwaway database and never calls Cloudinary, SendGrid or Razorpay.
 * Run: npm run test:erp
 */
const assert_1 = __importDefault(require("assert"));
const crypto_1 = __importDefault(require("crypto"));
// Must be set before the app (and dotenv) load. Never touch the real DB, mail or image storage.
const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_erp_test';
const KEY_ID = 'erp-test';
const SECRET = 'test_erp_secret_0123456789abcdef0123456789';
process.env.NODE_ENV = 'development'; // keeps rate limiters off
process.env.SENDGRID_API_KEY = '';
process.env.CLOUDINARY_CLOUD_NAME = '';
process.env.CLOUDINARY_API_KEY = '';
process.env.CLOUDINARY_API_SECRET = '';
process.env.ERP_API_KEYS = `${KEY_ID}:${SECRET}`;
const mongoose_1 = __importDefault(require("mongoose"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const app_1 = __importDefault(require("../app"));
const env_1 = require("../config/env");
const User_1 = require("../models/User");
const Product_1 = require("../models/Product");
const Category_1 = require("../models/Category");
const Brand_1 = require("../models/Brand");
const Order_1 = __importDefault(require("../models/Order"));
const ErpEvent_1 = require("../models/ErpEvent");
const erpController_1 = require("../controllers/erpController");
const erpAuth_1 = require("../middlewares/erpAuth");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const payment = require('../controllers/paymentController');
let origin = '';
let passed = 0;
const test = async (name, fn) => {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
};
const sha256 = (b) => crypto_1.default.createHash('sha256').update(b).digest('hex');
let clock = Math.floor(Date.now() / 1000) - 200; // every call gets a fresh timestamp, as a real ERP retry would
const signHeaders = (method, path, body, o = {}) => {
    const ts = String(o.ts ?? clock++);
    const sig = crypto_1.default.createHmac('sha256', o.secret ?? SECRET).update(`${ts}.${method}.${path}.${sha256(body)}`).digest('hex');
    return { 'X-ERP-Key-Id': o.keyId ?? KEY_ID, 'X-ERP-Timestamp': ts, 'X-ERP-Signature': sig };
};
const parse = async (res) => {
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    }
    catch { /* non-JSON */ }
    return { status: res.status, json };
};
/** Signed JSON call. `path` is relative to /api/v1/erp. */
const erp = async (method, path, body, o = {}) => {
    const full = '/api/v1/erp' + path;
    const raw = body === undefined ? '' : JSON.stringify(body);
    const res = await fetch(origin + full, {
        method,
        headers: { 'Content-Type': 'application/json', ...signHeaders(method, full, raw, o), ...(o.headers || {}) },
        body: body === undefined ? undefined : raw,
    });
    return parse(res);
};
const upload = async (file, name, type, o = {}) => {
    const full = '/api/v1/erp/images';
    const form = new FormData();
    if (file)
        form.append(o.field ?? 'image', new Blob([new Uint8Array(file)], { type }), name);
    const res = await fetch(origin + full, { method: 'POST', headers: signHeaders('POST', full, o.badSig ? 'other' : file ?? ''), body: form });
    return parse(res);
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const run = async () => {
    assert_1.default.ok(TEST_DB.includes('127.0.0.1') && TEST_DB.endsWith('_test'), 'refusing to run against a non-test database');
    await mongoose_1.default.connect(TEST_DB);
    await mongoose_1.default.connection.db.dropDatabase();
    await Promise.all([Order_1.default.init(), ErpEvent_1.ErpEvent.init(), Product_1.Product.init()]);
    const server = app_1.default.listen(0);
    origin = `http://127.0.0.1:${server.address().port}`;
    const admin = await User_1.User.create({ name: 'Admin', email: 'admin@test.local', password: 'Admin#12345', role: 'superadmin', isVerified: true });
    const alice = await User_1.User.create({ name: 'Alice', email: 'alice@test.local', password: 'Alice#12345', phone: '9000000001', role: 'customer', isVerified: true });
    const adminToken = jsonwebtoken_1.default.sign({ id: admin._id.toString(), role: admin.role }, env_1.ENV.JWT_SECRET, { expiresIn: '1h' });
    await Category_1.Category.create({ name: 'Skincare', image: 'https://res.cloudinary.com/x/skincare.jpg' });
    const brand = await Brand_1.Brand.create({ name: 'Lumina' });
    console.log('\nAuthentication');
    await test('ERP key config accepts trimmed comma-separated pairs and reports no secret material', async () => {
        const configuredKeys = process.env.ERP_API_KEYS;
        try {
            process.env.ERP_API_KEYS = ` erp-one : ${SECRET} , erp-two:${SECRET}:suffix `;
            const validStatus = (0, erpAuth_1.getErpKeyConfigurationStatus)();
            assert_1.default.deepStrictEqual(validStatus, { valid: true, keyIds: ['erp-one', 'erp-two'] });
            assert_1.default.ok(!JSON.stringify(validStatus).includes(SECRET));
            process.env.ERP_API_KEYS = `erp-one:${SECRET},malformed,erp-short:short`;
            const invalidStatus = (0, erpAuth_1.getErpKeyConfigurationStatus)();
            assert_1.default.deepStrictEqual(invalidStatus, { valid: false, keyIds: ['erp-one', 'erp-short'] });
            assert_1.default.ok(!JSON.stringify(invalidStatus).includes(SECRET));
        }
        finally {
            process.env.ERP_API_KEYS = configuredKeys;
        }
    });
    await test('missing headers, unknown key, missing timestamp, bad signature and expired timestamp are rejected', async () => {
        const plain = await parse(await fetch(origin + '/api/v1/erp/orders'));
        assert_1.default.strictEqual(plain.status, 401);
        const unknownKey = await erp('GET', '/orders', undefined, { keyId: 'nope' });
        assert_1.default.strictEqual(unknownKey.status, 401);
        assert_1.default.strictEqual(unknownKey.json.message, 'Invalid ERP credentials');
        assert_1.default.strictEqual((await erp('GET', '/orders', undefined, { secret: 'x'.repeat(40) })).status, 401);
        const missingTimestampHeaders = signHeaders('GET', '/api/v1/erp/orders', '');
        delete missingTimestampHeaders['X-ERP-Timestamp'];
        const missingTimestamp = await parse(await fetch(origin + '/api/v1/erp/orders', { headers: missingTimestampHeaders }));
        assert_1.default.strictEqual(missingTimestamp.status, 401);
        assert_1.default.match(missingTimestamp.json.message, /Timestamp/);
        const old = await erp('GET', '/orders', undefined, { ts: Math.floor(Date.now() / 1000) - 301 });
        assert_1.default.strictEqual(old.status, 401);
        assert_1.default.match(old.json.message, /Timestamp/);
        const milliseconds = await erp('GET', '/orders', undefined, { ts: Date.now() });
        assert_1.default.strictEqual(milliseconds.status, 401);
        assert_1.default.match(milliseconds.json.message, /Timestamp/);
    });
    await test('a configured rotated key works and the exact GET query is signed', async () => {
        const configuredKeys = process.env.ERP_API_KEYS;
        const rotatedSecret = 'rotated_erp_secret_0123456789abcdef';
        process.env.ERP_API_KEYS = `${KEY_ID}:${SECRET},erp-rotated:${rotatedSecret}`;
        try {
            const exactPath = '/api/v1/erp/orders?limit=1';
            const headers = signHeaders('GET', exactPath, '', { keyId: 'erp-rotated', secret: rotatedSecret });
            assert_1.default.strictEqual((await fetch(origin + exactPath, { headers })).status, 200);
            const mismatchedHeaders = signHeaders('GET', exactPath, '');
            assert_1.default.strictEqual((await fetch(origin + '/api/v1/erp/orders?limit=2', { headers: mismatchedHeaders })).status, 401);
        }
        finally {
            process.env.ERP_API_KEYS = configuredKeys;
        }
    });
    await test('JSON signatures use the exact request bytes, including whitespace', async () => {
        const full = '/api/v1/erp/stock/UNKNOWN';
        const rawBody = `{ "quantity": 1, "asOf": "${iso(0)}" }\n`;
        const headers = signHeaders('PUT', full, rawBody);
        const response = await fetch(origin + full, {
            method: 'PUT',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: rawBody,
        });
        assert_1.default.strictEqual(response.status, 404, 'authentication passed and the unknown SKU reached the controller');
    });
    await test('a replayed signed request is rejected', async () => {
        const full = '/api/v1/erp/orders';
        const headers = signHeaders('GET', full, '');
        assert_1.default.strictEqual((await fetch(origin + full, { headers })).status, 200);
        assert_1.default.strictEqual((await fetch(origin + full, { headers })).status, 401);
    });
    await test('signature covers the body: a tampered body is rejected', async () => {
        const full = '/api/v1/erp/stock/ANY';
        const headers = signHeaders('PUT', full, JSON.stringify({ quantity: 1, asOf: iso(0) }));
        const res = await fetch(origin + full, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity: 999, asOf: iso(0) }) });
        assert_1.default.strictEqual(res.status, 401);
    });
    await test('an admin JWT is not accepted on ERP routes', async () => {
        const res = await fetch(origin + '/api/v1/erp/orders', { headers: { Authorization: `Bearer ${adminToken}` } });
        assert_1.default.strictEqual(res.status, 401);
    });
    await test('ERP routes fail closed when no keys are configured', async () => {
        const keys = process.env.ERP_API_KEYS;
        process.env.ERP_API_KEYS = '';
        assert_1.default.strictEqual((await erp('GET', '/orders')).status, 503);
        process.env.ERP_API_KEYS = `${KEY_ID}:short`; // secrets under 32 characters are ignored
        assert_1.default.strictEqual((await erp('GET', '/orders')).status, 503);
        process.env.ERP_API_KEYS = keys;
    });
    console.log('\nItem add / upsert');
    const newItem = {
        name: 'Rose Serum', description: 'Hydrating serum', category: 'skincare', brand: 'Lumina',
        imageUrls: ['https://images.example.com/rose.jpg'],
        variants: [{ sku: 'ROSE-30', size: '30ml', offerPrice: 499, actualPrice: 599, stock: 10, weight: 0.05 }],
    };
    let productId = '';
    await test('creates a product with category/brand resolved by name', async () => {
        const r = await erp('POST', '/items', newItem);
        assert_1.default.strictEqual(r.status, 201, JSON.stringify(r.json));
        assert_1.default.strictEqual(r.json.data.action, 'created');
        assert_1.default.strictEqual(r.json.data.variants[0].action, 'created');
        productId = r.json.data.productId;
        const p = (await Product_1.Product.findById(productId));
        assert_1.default.strictEqual(p.category, 'Skincare');
        assert_1.default.strictEqual(String(p.brandId), String(brand._id));
        assert_1.default.strictEqual(p.variants[0].price, 499);
        assert_1.default.strictEqual(p.variants[0].oldPrice, 599);
        assert_1.default.strictEqual(p.stock, 10);
    });
    await test('lists real products and variants by SKU without inventing missing identifiers', async () => {
        const r = await erp('GET', '/items?search=ROSE-30');
        assert_1.default.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert_1.default.strictEqual(r.json.data.items.length, 1);
        assert_1.default.strictEqual(r.json.data.items[0].productId, productId);
        assert_1.default.strictEqual(r.json.data.items[0].variants[0].sku, 'ROSE-30');
        const exactItem = await erp('GET', '/items/ROSE-30');
        assert_1.default.strictEqual(exactItem.status, 200);
        assert_1.default.strictEqual(exactItem.json.data.variant.sku, 'ROSE-30');
        assert_1.default.strictEqual((await erp('GET', '/items/MISSING-SKU')).status, 404);
        assert_1.default.strictEqual((await erp('GET', '/items?limit=0')).status, 400);
    });
    await test('upserting the same SKU updates in place: no duplicate, omitted fields and stock preserved', async () => {
        const r = await erp('POST', '/items', { name: 'Rose Serum 2', variants: [{ sku: 'ROSE-30', offerPrice: 450, stock: 99 }] });
        assert_1.default.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert_1.default.strictEqual(r.json.data.action, 'updated');
        assert_1.default.strictEqual(await Product_1.Product.countDocuments(), 1);
        const p = (await Product_1.Product.findById(productId));
        assert_1.default.strictEqual(p.name, 'Rose Serum 2');
        assert_1.default.strictEqual(p.description, 'Hydrating serum');
        assert_1.default.deepStrictEqual([...p.images], ['https://images.example.com/rose.jpg']);
        assert_1.default.strictEqual(p.variants[0].offerPrice, 450);
        assert_1.default.strictEqual(p.variants[0].stock, 10, 'stock of an existing variant only changes via PUT /erp/stock');
    });
    await test('upsert adds a new variant to the existing product', async () => {
        const r = await erp('POST', '/items', { variants: [{ sku: 'ROSE-30' }, { sku: 'ROSE-50', size: '50ml', offerPrice: 699, actualPrice: 799, stock: 4 }] });
        assert_1.default.strictEqual(r.status, 200, JSON.stringify(r.json));
        const p = (await Product_1.Product.findById(productId));
        assert_1.default.strictEqual(p.variants.length, 2);
        assert_1.default.strictEqual(p.variants[1].weight, 0.05, 'weight parsed from size when not supplied');
        assert_1.default.strictEqual(p.stock, 14);
    });
    await test('validation: missing create fields, unknown fields, bad prices, unknown category, duplicate SKUs', async () => {
        const missing = await erp('POST', '/items', { variants: [{ sku: 'NEW-1', offerPrice: 1, actualPrice: 2 }] });
        assert_1.default.strictEqual(missing.status, 400);
        assert_1.default.deepStrictEqual(missing.json.errors.map((e) => e.field).sort(), ['category', 'description', 'name']);
        assert_1.default.strictEqual((await erp('POST', '/items', { ...newItem, color: 'red' })).status, 400);
        assert_1.default.strictEqual((await erp('POST', '/items', { ...newItem, variants: [{ sku: 'X-1', offerPrice: -1, actualPrice: 2 }] })).status, 400);
        assert_1.default.strictEqual((await erp('POST', '/items', { ...newItem, variants: [{ sku: 'X-1', offerPrice: 9, actualPrice: 2 }] })).status, 400);
        assert_1.default.strictEqual((await erp('POST', '/items', { ...newItem, category: 'Nope', variants: [{ sku: 'X-1', offerPrice: 1, actualPrice: 2 }] })).status, 400);
        assert_1.default.strictEqual((await erp('POST', '/items', { ...newItem, variants: [{ sku: 'X-1', offerPrice: 1, actualPrice: 2 }, { sku: 'X-1', offerPrice: 1, actualPrice: 2 }] })).status, 400);
        assert_1.default.strictEqual((await erp('POST', '/items', { ...newItem, imageUrls: ['http://insecure.example.com/a.jpg'] })).status, 400);
        assert_1.default.strictEqual(await Product_1.Product.countDocuments(), 1, 'nothing created by rejected requests');
    });
    await test('SKUs from two different products in one request are refused', async () => {
        await erp('POST', '/items', { ...newItem, name: 'Other', variants: [{ sku: 'OTHER-1', offerPrice: 1, actualPrice: 2 }] });
        const r = await erp('POST', '/items', { variants: [{ sku: 'ROSE-30' }, { sku: 'OTHER-1' }] });
        assert_1.default.strictEqual(r.status, 409);
        assert_1.default.strictEqual(r.json.errors[0].code, 'CONFLICT');
    });
    console.log('\nItem edit');
    await test('price-only patch changes only that variant; images, stock and other variants untouched', async () => {
        const before = (await Product_1.Product.findById(productId)).toObject();
        const r = await erp('PATCH', '/items/ROSE-50', { offerPrice: 650 });
        assert_1.default.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert_1.default.deepStrictEqual(r.json.data.updatedFields, ['offerPrice']);
        const p = (await Product_1.Product.findById(productId));
        assert_1.default.strictEqual(p.variants[1].offerPrice, 650);
        assert_1.default.strictEqual(p.variants[1].price, 650);
        assert_1.default.strictEqual(p.variants[1].stock, before.variants[1].stock);
        assert_1.default.strictEqual(p.variants[0].offerPrice, before.variants[0].offerPrice);
        assert_1.default.deepStrictEqual([...p.images], before.images);
        assert_1.default.strictEqual(String(p.variants[1]._id), String(before.variants[1]._id), 'variant id is stable');
    });
    await test('patch rejects stock, unknown fields, empty bodies and unknown SKUs', async () => {
        assert_1.default.strictEqual((await erp('PATCH', '/items/ROSE-50', { stock: 1 })).status, 400);
        assert_1.default.strictEqual((await erp('PATCH', '/items/ROSE-50', {})).status, 400);
        assert_1.default.strictEqual((await erp('PATCH', '/items/ROSE-50', { offerPrice: 5000 })).status, 400, 'above MRP');
        assert_1.default.strictEqual((await erp('PATCH', '/items/NOPE', { name: 'x' })).status, 404);
    });
    console.log('\nStock update');
    const t1 = iso(-60_000), t0 = iso(-120_000);
    await test('sets absolute stock and keeps the product total in step', async () => {
        const r = await erp('PUT', '/stock/ROSE-30', { quantity: 25, asOf: t1 });
        assert_1.default.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert_1.default.strictEqual(r.json.data.previousQuantity, 10);
        assert_1.default.strictEqual(r.json.data.quantity, 25);
        assert_1.default.strictEqual(r.json.data.applied, true);
        const p = (await Product_1.Product.findById(productId));
        assert_1.default.strictEqual(p.variants[0].stock, 25);
        assert_1.default.strictEqual(p.stock, 29);
        const readback = await erp('GET', '/items?search=ROSE-30');
        assert_1.default.strictEqual(readback.status, 200);
        assert_1.default.strictEqual(readback.json.data.items[0].variants[0].stock, 25);
    });
    await test('redelivery of the same update is a no-op; an older update is refused as stale', async () => {
        const again = await erp('PUT', '/stock/ROSE-30', { quantity: 25, asOf: t1 });
        assert_1.default.strictEqual(again.status, 200);
        assert_1.default.strictEqual(again.json.data.applied, false);
        const stale = await erp('PUT', '/stock/ROSE-30', { quantity: 1, asOf: t0 });
        assert_1.default.strictEqual(stale.status, 409);
        assert_1.default.strictEqual(stale.json.errors[0].code, 'STALE_UPDATE');
        assert_1.default.strictEqual((await Product_1.Product.findById(productId)).variants[0].stock, 25);
    });
    await test('website orders placed after the ERP snapshot stay reserved', async () => {
        const p = (await Product_1.Product.findById(productId));
        const snapshot = new Date();
        await new Promise((r) => setTimeout(r, 5));
        await Order_1.default.create({
            user: alice._id, items: [{ product: p._id, variantId: p.variants[0]._id, quantity: 3, price: 450 }],
            shippingAddress: { street: '1 St', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' },
            subtotal: 1350, total: 1390, shippingFee: 40, paymentMethod: 'razorpay', paymentStatus: 'completed',
        });
        const r = await erp('PUT', '/stock/ROSE-30', { quantity: 20, asOf: snapshot.toISOString() });
        assert_1.default.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert_1.default.strictEqual(r.json.data.pendingOrderQuantity, 3);
        assert_1.default.strictEqual(r.json.data.quantity, 17);
        await Order_1.default.deleteMany({});
    });
    await test('validation and lookup errors: negative, fractional, bad date, future date, unknown and duplicate SKU', async () => {
        assert_1.default.strictEqual((await erp('PUT', '/stock/ROSE-30', { quantity: -1, asOf: iso(0) })).status, 400);
        assert_1.default.strictEqual((await erp('PUT', '/stock/ROSE-30', { quantity: 1.5, asOf: iso(0) })).status, 400);
        assert_1.default.strictEqual((await erp('PUT', '/stock/ROSE-30', { quantity: 1, asOf: 'yesterday' })).status, 400);
        assert_1.default.strictEqual((await erp('PUT', '/stock/ROSE-30', { quantity: 1, asOf: iso(3_600_000) })).status, 400);
        assert_1.default.strictEqual((await erp('PUT', '/stock/ROSE-30', { quantity: 1 })).status, 400);
        assert_1.default.strictEqual((await erp('PUT', '/stock/NOPE', { quantity: 1, asOf: iso(0) })).status, 404);
        // Bad legacy data: two products carrying the same SKU (possible via the admin panel)
        await Product_1.Product.create({ name: 'Dup A', category: 'Skincare', description: 'd', variants: [{ sku: 'DUP', volume: '1', price: 1, offerPrice: 1, actualPrice: 1 }] });
        await Product_1.Product.create({ name: 'Dup B', category: 'Skincare', description: 'd', variants: [{ sku: 'DUP', volume: '1', price: 1, offerPrice: 1, actualPrice: 1 }] });
        const dup = await erp('PUT', '/stock/DUP', { quantity: 1, asOf: iso(0) });
        assert_1.default.strictEqual(dup.status, 409);
        assert_1.default.strictEqual(dup.json.errors[0].code, 'DUPLICATE_SKU');
        assert_1.default.strictEqual((await erp('PATCH', '/items/DUP', { name: 'x' })).status, 409);
        assert_1.default.strictEqual((await erp('GET', '/items/DUP')).status, 409);
        assert_1.default.strictEqual((await erp('POST', '/items', { variants: [{ sku: 'DUP' }] })).status, 409);
    });
    await test('checkout stock decrement still works after an ERP stock update', async () => {
        const p = (await Product_1.Product.findById(productId));
        const r = await Product_1.Product.updateOne({ _id: p._id, variants: { $elemMatch: { _id: p.variants[0]._id, stock: { $gte: 2 } } } }, { $inc: { 'variants.$.stock': -2, stock: -2 } });
        assert_1.default.strictEqual(r.modifiedCount, 1);
        assert_1.default.strictEqual((await Product_1.Product.findById(productId)).variants[0].stock, 15);
    });
    console.log('\nOrders');
    const p = (await Product_1.Product.findById(productId));
    const mkOrder = (orderStatus, paymentStatus = 'completed') => Order_1.default.create({
        user: alice._id, items: [{ product: p._id, variantId: p.variants[0]._id, quantity: 1, price: 450, subtotal: 450, size: '30ml' }],
        shippingAddress: { street: '1 St', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' },
        subtotal: 450, total: 490, shippingFee: 40, paymentMethod: 'razorpay', paymentStatus, orderStatus,
        razorpayOrderId: `order_${orderStatus}_${paymentStatus}_${Math.random()}`, razorpayPaymentId: 'pay_x', razorpaySignature: 'sig_secret',
    });
    const o1 = await mkOrder('processing');
    await mkOrder('shipped');
    await mkOrder('processing', 'refunded');
    await test('lists orders with pagination metadata in stable updatedAt order', async () => {
        const r1 = await erp('GET', '/orders?limit=2');
        assert_1.default.strictEqual(r1.status, 200, JSON.stringify(r1.json));
        assert_1.default.strictEqual(r1.json.data.length, 2);
        assert_1.default.deepStrictEqual(r1.json.pagination, { page: 1, limit: 2, total: 3, pages: 2 });
        assert_1.default.strictEqual(r1.json.data[0].orderId, String(o1._id));
        const r2 = await erp('GET', '/orders?limit=2&page=2');
        assert_1.default.strictEqual(r2.json.data.length, 1);
        const line = r1.json.data[0].items[0];
        assert_1.default.strictEqual(line.sku, 'ROSE-30');
        assert_1.default.strictEqual(line.unitPrice, 450);
        assert_1.default.strictEqual(r1.json.data[0].customer.email, 'alice@test.local');
    });
    await test('filters by status, paymentStatus and updatedSince; rejects bad query parameters', async () => {
        assert_1.default.strictEqual((await erp('GET', '/orders?status=shipped')).json.data.length, 1);
        assert_1.default.strictEqual((await erp('GET', '/orders?paymentStatus=refunded')).json.data.length, 1);
        assert_1.default.strictEqual((await erp('GET', `/orders?updatedSince=${encodeURIComponent(iso(60_000))}`)).json.data.length, 0);
        assert_1.default.strictEqual((await erp('GET', '/orders?limit=500')).status, 400);
        assert_1.default.strictEqual((await erp('GET', '/orders?status=lost')).status, 400);
        assert_1.default.strictEqual((await erp('GET', '/orders?foo=1')).status, 400);
    });
    await test('order details: full fields, no payment signature or user secrets', async () => {
        const r = await erp('GET', `/orders/${o1._id}`);
        assert_1.default.strictEqual(r.status, 200, JSON.stringify(r.json));
        const d = r.json.data;
        assert_1.default.strictEqual(d.customer.phone, '9000000001');
        assert_1.default.strictEqual(d.shippingAddress.city, 'Kochi');
        assert_1.default.strictEqual(d.payment.gatewayPaymentId, 'pay_x');
        assert_1.default.strictEqual(d.currency, 'INR');
        const text = JSON.stringify(d);
        assert_1.default.ok(!text.includes('sig_secret') && !text.includes('password'), 'no secrets in the payload');
        assert_1.default.strictEqual((await erp('GET', '/orders/123')).status, 400);
        assert_1.default.strictEqual((await erp('GET', `/orders/${new mongoose_1.default.Types.ObjectId()}`)).status, 404);
    });
    console.log('\nOrder-status webhook');
    let emails = 0;
    payment.sendOrderStatusEmail = async () => { emails++; };
    const event = (eventId, status, occurredAt, extra = {}) => erp('POST', '/webhooks/order-status', { eventId, orderId: String(o1._id), status, occurredAt, ...extra });
    const settle = () => new Promise((r) => setTimeout(r, 100));
    await test('applies a forward transition, stores ERP references and emails once', async () => {
        const r = await event('EV-1', 'shipped', iso(-30_000), { erpOrderId: 'SO-1', trackingNumber: 'TRK-1' });
        assert_1.default.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert_1.default.strictEqual(r.json.data.applied, true);
        assert_1.default.strictEqual(r.json.data.previousStatus, 'processing');
        const o = (await Order_1.default.findById(o1._id));
        assert_1.default.strictEqual(o.orderStatus, 'shipped');
        assert_1.default.strictEqual(o.erpOrderId, 'SO-1');
        assert_1.default.strictEqual(o.trackingNumber, 'TRK-1');
        await settle();
        assert_1.default.strictEqual(emails, 1);
    });
    await test('a duplicate eventId is acknowledged without side effects', async () => {
        const r = await event('EV-1', 'shipped', iso(-30_000));
        assert_1.default.strictEqual(r.status, 200);
        assert_1.default.strictEqual(r.json.data.duplicate, true);
        await settle();
        assert_1.default.strictEqual(emails, 1);
    });
    await test('an older event cannot revert a newer state; same status is a no-op', async () => {
        const stale = await event('EV-2', 'delivered', iso(-60_000));
        assert_1.default.strictEqual(stale.json.data.outcome, 'stale');
        assert_1.default.strictEqual((await Order_1.default.findById(o1._id)).orderStatus, 'shipped');
        const same = await event('EV-3', 'shipped', iso(-20_000));
        assert_1.default.strictEqual(same.json.data.outcome, 'unchanged');
        await settle();
        assert_1.default.strictEqual(emails, 1);
    });
    await test('backward transitions and leaving a final state are refused', async () => {
        const back = await event('EV-4', 'processing', iso(-10_000));
        assert_1.default.strictEqual(back.status, 409);
        assert_1.default.strictEqual(back.json.errors[0].code, 'INVALID_TRANSITION');
        assert_1.default.strictEqual((await event('EV-5', 'delivered', iso(-5_000))).json.data.applied, true);
        assert_1.default.strictEqual((await event('EV-6', 'cancelled', iso(-1_000))).status, 409, 'delivered is final');
        assert_1.default.ok(!(await ErpEvent_1.ErpEvent.findOne({ eventId: 'EV-4' })), 'refused events are not recorded, so a corrected retry is possible');
    });
    await test('webhook validation: missing fields, bad status, unknown order, mismatched erpOrderId, expired signature', async () => {
        assert_1.default.strictEqual((await erp('POST', '/webhooks/order-status', { eventId: 'EV-7', status: 'shipped' })).status, 400);
        assert_1.default.strictEqual((await event('EV-8', 'lost', iso(0))).status, 400);
        assert_1.default.strictEqual((await event('EV-9', 'shipped', 'not-a-date')).status, 400);
        const unknown = await erp('POST', '/webhooks/order-status', { eventId: 'EV-10', orderId: String(new mongoose_1.default.Types.ObjectId()), status: 'shipped', occurredAt: iso(0) });
        assert_1.default.strictEqual(unknown.status, 404);
        assert_1.default.strictEqual((await event('EV-11', 'delivered', iso(0), { erpOrderId: 'SO-OTHER' })).status, 409);
        const expired = await erp('POST', '/webhooks/order-status', { eventId: 'EV-12', orderId: String(o1._id), status: 'shipped', occurredAt: iso(0) }, { ts: Math.floor(Date.now() / 1000) - 600 });
        assert_1.default.strictEqual(expired.status, 401);
    });
    console.log('\nImage upload');
    let stored = 0;
    erpController_1.imageStore.configured = () => true;
    erpController_1.imageStore.upload = async () => { stored++; return 'https://res.cloudinary.com/test/image/upload/erp.png'; };
    await test('stores a valid image and returns its URL', async () => {
        const r = await upload(PNG, 'rose.png', 'image/png');
        assert_1.default.strictEqual(r.status, 201, JSON.stringify(r.json));
        assert_1.default.strictEqual(r.json.data.url, 'https://res.cloudinary.com/test/image/upload/erp.png');
        assert_1.default.strictEqual(stored, 1);
    });
    await test('rejects missing file, wrong field, wrong type, spoofed content and oversize files', async () => {
        assert_1.default.strictEqual((await upload(null, '', '')).status, 400);
        assert_1.default.strictEqual((await upload(PNG, 'rose.png', 'image/png', { field: 'imageFile' })).status, 400);
        assert_1.default.strictEqual((await upload(Buffer.from('hello'), 'notes.txt', 'text/plain')).status, 400);
        assert_1.default.strictEqual((await upload(JPEG, 'rose.png', 'image/png')).status, 400, 'bytes do not match the extension');
        assert_1.default.strictEqual((await upload(Buffer.from('<svg/>'), 'x.png', 'image/png')).status, 400);
        assert_1.default.strictEqual((await upload(Buffer.concat([PNG, Buffer.alloc(15 * 1024 * 1024)]), 'big.png', 'image/png')).status, 413);
        assert_1.default.strictEqual(stored, 1, 'nothing stored');
    });
    await test('a bad upload signature is rejected before storage; unconfigured storage is a 503', async () => {
        assert_1.default.strictEqual((await upload(PNG, 'rose.png', 'image/png', { badSig: true })).status, 401);
        erpController_1.imageStore.configured = () => false;
        assert_1.default.strictEqual((await upload(PNG, 'rose.png', 'image/png')).status, 503);
        assert_1.default.strictEqual(stored, 1);
    });
    console.log('\nExisting APIs');
    await test('public endpoints still cannot write products', async () => {
        const res = await fetch(`${origin}/api/v1/products/${productId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"name":"x"}' });
        assert_1.default.strictEqual(res.status, 401);
    });
    server.close();
    assert_1.default.strictEqual(mongoose_1.default.connection.name, 'luxy_erp_test');
    await mongoose_1.default.connection.db.dropDatabase();
    await mongoose_1.default.disconnect();
    console.log(`\n=== Summary: ${passed} passed, 0 failed ===`);
    process.exit(0);
};
run().catch(async (err) => {
    console.error('\n❌ FAILED:', err);
    try {
        if (mongoose_1.default.connection.name === 'luxy_erp_test')
            await mongoose_1.default.connection.db.dropDatabase();
        await mongoose_1.default.disconnect();
    }
    catch { /* ignore */ }
    process.exit(1);
});
//# sourceMappingURL=erp.test.js.map