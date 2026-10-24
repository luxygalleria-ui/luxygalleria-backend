"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Cart API: load, add, set quantity (including a line that only exists in the browser cart), remove, stock and
 * input validation, auth, persistence, and checkout re-pricing from the server cart's items.
 * Needs a local MongoDB; uses (and drops) a throwaway database. No payment provider is called.
 * Run: npx ts-node --transpile-only src/tests/cart.test.ts
 */
const assert_1 = __importDefault(require("assert"));
const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_cart_test';
process.env.NODE_ENV = 'development';
process.env.HISTORY_READ_ENABLED = 'false';
process.env.SENDGRID_API_KEY = '';
const mongoose_1 = __importDefault(require("mongoose"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const app_1 = __importDefault(require("../app"));
const env_1 = require("../config/env");
const User_1 = require("../models/User");
const Product_1 = require("../models/Product");
const Cart_1 = require("../models/Cart");
let passed = 0;
const test = async (name, fn) => {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
};
const run = async () => {
    assert_1.default.ok(TEST_DB.includes('127.0.0.1') && TEST_DB.endsWith('_test'), 'refusing to run against a non-test database');
    await mongoose_1.default.connect(TEST_DB);
    await mongoose_1.default.connection.db.dropDatabase();
    const server = app_1.default.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const call = async (method, path, body, token) => {
        const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: r.status, json: await r.json().catch(() => null) };
    };
    try {
        const user = await User_1.User.create({ name: 'Cust', email: 'cust@test.local', password: 'Passw0rd#123', role: 'customer', isVerified: true });
        const T = jsonwebtoken_1.default.sign({ id: String(user._id), role: user.role }, env_1.ENV.JWT_SECRET, { expiresIn: '10m' });
        const tea = await Product_1.Product.create({
            name: 'Tea', category: 'Drinks', description: 'Tea', stock: 8,
            variants: [
                { volume: '200g', price: 300, offerPrice: 250, actualPrice: 350, stock: 5, weight: 0.2 },
                { volume: '500g', price: 600, offerPrice: 550, actualPrice: 700, stock: 3, weight: 0.5 },
            ],
        });
        const pid = String(tea._id), v200 = String(tea.variants[0]._id), v500 = String(tea.variants[1]._id);
        const lines = async () => (await call('GET', '/cart', undefined, T)).json.data.items.map((i) => `${String(i.variantId) === v200 ? '200g' : '500g'}x${i.quantity}`).sort().join(',');
        await test('1. cart loads (created on first visit)', async () => {
            const r = await call('GET', '/cart', undefined, T);
            assert_1.default.strictEqual(r.status, 200);
            assert_1.default.deepStrictEqual(r.json.data.items, []);
        });
        await test('9. the reported 404: setting the quantity of a line only in the browser cart now adds it', async () => {
            const r = await call('PUT', '/cart/item', { productId: pid, variantId: v200, quantity: 2, size: '200g' }, T);
            assert_1.default.strictEqual(r.status, 200, JSON.stringify(r.json));
            assert_1.default.strictEqual(await lines(), '200gx2');
            const again = await call('PUT', '/cart/item', { productId: pid, variantId: v200, quantity: 2, size: '200g' }, T);
            assert_1.default.strictEqual(again.status, 200);
            assert_1.default.strictEqual(await lines(), '200gx2', 'repeating a sync never doubles a line');
        });
        await test('2. add to cart: new line, then adds to the existing line; product data populated from the DB', async () => {
            assert_1.default.strictEqual((await call('POST', '/cart', { productId: pid, variantId: v500, quantity: 1 }, T)).status, 200);
            const r = await call('POST', '/cart', { productId: pid, variantId: v200, quantity: 1 }, T);
            assert_1.default.strictEqual(r.status, 200);
            assert_1.default.strictEqual(await lines(), '200gx3,500gx1');
            assert_1.default.strictEqual(r.json.data.items[0].product.variants[0].offerPrice, 250, 'price comes from the product record');
        });
        await test('3. quantity increase and decrease set the exact quantity', async () => {
            assert_1.default.strictEqual((await call('PUT', '/cart/item', { productId: pid, variantId: v200, quantity: 4 }, T)).status, 200);
            assert_1.default.strictEqual(await lines(), '200gx4,500gx1');
            assert_1.default.strictEqual((await call('PUT', '/cart/item', { productId: pid, variantId: v200, quantity: 1 }, T)).status, 200);
            assert_1.default.strictEqual(await lines(), '200gx1,500gx1');
        });
        await test('stock is enforced on the server (409 with the available quantity)', async () => {
            const over = await call('PUT', '/cart/item', { productId: pid, variantId: v500, quantity: 4 }, T);
            assert_1.default.strictEqual(over.status, 409);
            assert_1.default.match(over.json.message, /Only 3 of Tea left/);
            assert_1.default.strictEqual(over.json.errors[0].available, 3);
            const add = await call('POST', '/cart', { productId: pid, variantId: v500, quantity: 3 }, T);
            assert_1.default.strictEqual(add.status, 409, 'existing 1 + 3 > stock 3');
            assert_1.default.strictEqual(await lines(), '200gx1,500gx1', 'refused writes change nothing');
        });
        await test('4. removing an item works and is idempotent; quantity 0 also removes', async () => {
            assert_1.default.strictEqual((await call('DELETE', '/cart/item', { productId: pid, variantId: v500 }, T)).status, 200);
            assert_1.default.strictEqual(await lines(), '200gx1');
            assert_1.default.strictEqual((await call('DELETE', '/cart/item', { productId: pid, variantId: v500 }, T)).status, 200, 'already gone: still 200');
            assert_1.default.strictEqual((await call('PUT', '/cart/item', { productId: pid, variantId: v200, quantity: 0 }, T)).status, 200);
            assert_1.default.strictEqual(await lines(), '');
        });
        await test('5. cart state persists across requests (what a page refresh loads)', async () => {
            await call('PUT', '/cart/item', { productId: pid, variantId: v200, quantity: 2 }, T);
            assert_1.default.strictEqual(await lines(), '200gx2');
            assert_1.default.strictEqual((await Cart_1.Cart.countDocuments({ user: user._id })), 1, 'one cart per user');
        });
        await test('8. unauthenticated and invalid requests are refused safely (no 500s)', async () => {
            for (const [m, p] of [['GET', '/cart'], ['POST', '/cart'], ['PUT', '/cart/item'], ['DELETE', '/cart/item']]) {
                assert_1.default.strictEqual((await call(m, p, m === 'GET' ? undefined : { productId: pid, quantity: 1 })).status, 401, `${m} ${p}`);
            }
            const bad = [
                ['POST', { productId: 'not-an-id', quantity: 1 }, 400],
                ['POST', { productId: { $ne: null }, quantity: 1 }, 400],
                ['POST', { productId: pid, variantId: 'x', quantity: 1 }, 400],
                ['POST', { productId: pid, quantity: 1.5 }, 400],
                ['POST', { productId: pid, quantity: -1 }, 400],
                ['POST', { productId: pid, quantity: '1' }, 400],
                ['POST', { productId: pid, quantity: 101 }, 400],
                ['POST', { productId: String(new mongoose_1.default.Types.ObjectId()), quantity: 1 }, 404],
                ['PUT', { productId: pid, variantId: String(new mongoose_1.default.Types.ObjectId()), quantity: 1 }, 404],
            ];
            for (const [m, body, status] of bad) {
                assert_1.default.strictEqual((await call(m, m === 'POST' ? '/cart' : '/cart/item', body, T)).status, status, JSON.stringify(body));
            }
            assert_1.default.strictEqual((await call('DELETE', '/cart/item', { productId: 'x' }, T)).status, 400);
            assert_1.default.strictEqual(await lines(), '200gx2', 'nothing changed by refused requests');
        });
        await test('7. checkout re-prices the cart on the server; a browser-sent total is not trusted', async () => {
            const items = [{ product: pid, variantId: v200, quantity: 2 }];
            const q = await call('POST', '/payments/calculate-shipping', { items, shippingAddress: { state: 'Kerala' } });
            assert_1.default.strictEqual(q.status, 200);
            assert_1.default.deepStrictEqual([q.json.data.subtotal, q.json.data.shipping, q.json.data.grandTotal], [500, 40, 540]);
            const priced = await call('POST', '/payments/calculate-shipping', { items: [{ ...items[0], price: 1 }], shippingAddress: { state: 'Kerala' } });
            assert_1.default.strictEqual(priced.json.data.subtotal, 500, 'client price ignored');
            const tooMany = await call('POST', '/payments/create-order', { items: [{ ...items[0], quantity: 6 }], total: 1, shippingAddress: { street: '1', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' } }, T);
            assert_1.default.strictEqual(tooMany.status, 400, 'client total / stock checked before any payment');
        });
    }
    finally {
        await mongoose_1.default.connection.db.dropDatabase();
        await mongoose_1.default.disconnect();
        server.close();
    }
    console.log(`=== Summary: ${passed} passed, 0 failed ===`);
};
run().catch(async (e) => {
    console.error('❌', e?.stack || e);
    process.exitCode = 1;
    await mongoose_1.default.disconnect().catch(() => undefined);
    process.exit(1);
});
//# sourceMappingURL=cart.test.js.map