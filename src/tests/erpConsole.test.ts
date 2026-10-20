/**
 * Admin ERP test console tests (/api/v1/erp-console/*).
 * Needs a local MongoDB; uses a throwaway database and never calls Cloudinary, SendGrid or Razorpay.
 * Run: npm run test:erp-console
 */
import assert from 'assert';
import http from 'http';
import { AddressInfo } from 'net';

const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_erp_console_test';
const KEY_ID = 'erp-staging';
const SECRET = 'test_erp_console_secret_0123456789abcdef';
process.env.NODE_ENV = 'development'; // keeps rate limiters off
process.env.SENDGRID_API_KEY = '';
process.env.ERP_API_KEYS = `${KEY_ID}:${SECRET}`;
process.env.ERP_CONSOLE_KEY_ID = KEY_ID;

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../app';
import { ENV } from '../config/env';
import { User } from '../models/User';
import { Product } from '../models/Product';
import { Category } from '../models/Category';
import Order from '../models/Order';
import { imageStore } from '../controllers/erpController';

let origin = '';
let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  passed++;
  console.log(`  ✅ ${name}`);
};

let adminToken = '';
const call = async (method: string, path: string, body?: any, o: { token?: string | null; confirm?: boolean; form?: FormData } = {}) => {
  const headers: Record<string, string> = {};
  const token = o.token === undefined ? adminToken : o.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (o.confirm ?? method !== 'GET') headers['X-ERP-Console-Confirm'] = 'write';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(origin + '/api/v1/erp-console' + path, { method, headers, body: o.form ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
};

const run = async () => {
  assert.ok(TEST_DB.includes('127.0.0.1') && TEST_DB.endsWith('_test'), 'refusing to run against a non-test database');
  await mongoose.connect(TEST_DB);
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([Order.init(), Product.init()]);

  const server = app.listen(0);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const admin = await User.create({ name: 'Admin', email: 'admin@test.local', password: 'Admin#12345', role: 'admin', isVerified: true });
  const alice = await User.create({ name: 'Alice', email: 'alice@test.local', password: 'Alice#12345', role: 'customer', isVerified: true });
  adminToken = jwt.sign({ id: admin._id.toString(), role: admin.role }, ENV.JWT_SECRET, { expiresIn: '1h' });
  const customerToken = jwt.sign({ id: alice._id.toString(), role: alice.role }, ENV.JWT_SECRET, { expiresIn: '1h' });
  await Category.create({ name: 'Chocolates', image: 'https://res.cloudinary.com/x/c.jpg' });

  console.log('\nAccess control');
  await test('no token is 401, a customer is 403', async () => {
    assert.strictEqual((await call('GET', '/status', undefined, { token: null })).status, 401);
    assert.strictEqual((await call('GET', '/orders', undefined, { token: customerToken })).status, 403);
  });
  await test('status reports the key id and never the secret', async () => {
    const r = await call('GET', '/status');
    assert.deepStrictEqual(r.json.data, { enabled: true, keyId: KEY_ID });
    assert.ok(!r.text.includes(SECRET));
  });
  await test('disabled unless ERP_CONSOLE_KEY_ID names a configured key', async () => {
    process.env.ERP_CONSOLE_KEY_ID = 'not-configured';
    const r = await call('GET', '/orders');
    assert.strictEqual(r.status, 503);
    assert.strictEqual((await call('GET', '/status')).json.data.enabled, false);
    process.env.ERP_CONSOLE_KEY_ID = KEY_ID;
  });
  await test('writes without the confirmation header are refused and change nothing', async () => {
    const r = await call('POST', '/items', { name: 'X', description: 'X', category: 'Chocolates', variants: [{ sku: 'NOPE-1', offerPrice: 1, actualPrice: 1 }] }, { confirm: false });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.errors[0].code, 'CONFIRMATION_REQUIRED');
    assert.strictEqual(await Product.countDocuments(), 0);
  });
  await test('only the mirrored routes exist; dot segments are refused', async () => {
    assert.strictEqual((await call('GET', '/products')).status, 404);
    // fetch() would normalise these away client-side; send the raw path as a hostile client could
    const raw = (method: string, path: string) => new Promise<number>((resolve, reject) => {
      const { hostname, port } = new URL(origin);
      http.request({ hostname, port, path: '/api/v1/erp-console' + path, method, headers: { Authorization: `Bearer ${adminToken}`, 'X-ERP-Console-Confirm': 'write' } }, (r) => { r.resume(); resolve(r.statusCode!); })
        .on('error', reject).end();
    });
    assert.strictEqual(await raw('PUT', '/stock/%2E%2E'), 400);
    assert.strictEqual(await raw('GET', '/orders/..'), 400);
  });

  console.log('\nForwarding to the real ERP API');
  await test('item add is signed server-side and reaches POST /erp/items', async () => {
    const r = await call('POST', '/items', {
      name: 'Dark Chocolate', description: '70% cocoa', category: 'Chocolates',
      variants: [{ sku: 'LG-CHOC-100G', size: '100g', offerPrice: 299, actualPrice: 349, stock: 40 }],
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.data.status, 201, r.text);
    assert.deepStrictEqual(r.json.data.request, { method: 'POST', path: '/api/v1/erp/items' });
    assert.strictEqual(r.json.data.body.data.action, 'created');
    assert.ok(!r.text.includes(SECRET) && !/signature"\s*:/i.test(r.text), 'no secret or signature in the response');
    assert.strictEqual(await Product.countDocuments({ 'variants.sku': 'LG-CHOC-100G' }), 1);
  });
  await test('ERP validation errors come back as data, not as a console failure', async () => {
    const r = await call('POST', '/items', { name: 'Bad', variants: [{ sku: 'B-1', offerPrice: 500, actualPrice: 100 }] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.status, 400);
    assert.strictEqual(r.json.data.body.message, 'Validation failed');
  });
  await test('stock update and item edit', async () => {
    const s = await call('PUT', '/stock/LG-CHOC-100G', { quantity: 25, asOf: new Date().toISOString() });
    assert.strictEqual(s.json.data.status, 200, s.text);
    assert.strictEqual(s.json.data.body.data.quantity, 25);
    const p = await call('PATCH', '/items/LG-CHOC-100G', { offerPrice: 279 });
    assert.strictEqual(p.json.data.status, 200, p.text);
    assert.strictEqual(p.json.data.body.data.variant.offerPrice, 279);
    const missing = await call('PATCH', '/items/UNKNOWN-SKU', { offerPrice: 1 });
    assert.strictEqual(missing.status, 200); // the admin session is untouched...
    assert.strictEqual(missing.json.data.status, 404); // ...and the ERP's 404 is shown
  });

  const product = await Product.findOne({ 'variants.sku': 'LG-CHOC-100G' });
  const order = await Order.create({
    user: alice._id,
    items: [{ product: product!._id, variantId: product!.variants[0]._id, quantity: 1, price: 279, subtotal: 279 }],
    shippingAddress: { street: '1 Test Road', city: 'Thalassery', state: 'Kerala', zipCode: '670101', country: 'India' },
    subtotal: 279, shippingFee: 60, total: 339, paymentMethod: 'razorpay', paymentStatus: 'completed',
  });

  await test('order list passes the query through to ERP validation', async () => {
    const r = await call('GET', '/orders?limit=10&status=processing');
    assert.strictEqual(r.json.data.status, 200, r.text);
    assert.strictEqual(r.json.data.body.data[0].orderId, String(order._id));
    assert.strictEqual((await call('GET', '/orders?limit=500')).json.data.status, 400);
  });
  await test('order details, and a bad id shows the ERP 400', async () => {
    const r = await call('GET', `/orders/${order._id}`);
    assert.strictEqual(r.json.data.status, 200, r.text);
    assert.strictEqual(r.json.data.body.data.customer.email, 'alice@test.local');
    assert.strictEqual((await call('GET', '/orders/123')).json.data.status, 400);
  });
  await test('order-status webhook applies a transition', async () => {
    const r = await call('POST', '/webhooks/order-status', {
      eventId: 'console-evt-1', orderId: String(order._id), status: 'shipped', trackingNumber: 'TRK1', occurredAt: new Date().toISOString(),
    });
    assert.strictEqual(r.json.data.status, 200, r.text);
    assert.strictEqual(r.json.data.body.data.outcome, 'applied');
    assert.strictEqual((await Order.findById(order._id))!.orderStatus, 'shipped');
  });
  await test('image upload signs the file bytes and returns the stored URL', async () => {
    const realUpload = imageStore.upload;
    const realConfigured = imageStore.configured;
    imageStore.configured = () => true;
    imageStore.upload = async () => 'https://res.cloudinary.com/test/image/upload/v1/luxygalleria_products/console.png';
    try {
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
      const form = new FormData();
      form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'console.png');
      const r = await call('POST', '/images', undefined, { form });
      assert.strictEqual(r.json.data.status, 201, r.text);
      assert.match(r.json.data.body.data.url, /^https:\/\/res\.cloudinary\.com\//);
      const bad = new FormData();
      bad.append('image', new Blob([new Uint8Array(png)], { type: 'image/jpeg' }), 'spoof.jpg');
      assert.strictEqual((await call('POST', '/images', undefined, { form: bad })).json.data.status, 400);
    } finally {
      imageStore.upload = realUpload;
      imageStore.configured = realConfigured;
    }
  });

  console.log(`\n=== Summary: ${passed} passed, 0 failed ===`);
  server.close();
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('\n❌ FAILED:', err);
  try {
    if (mongoose.connection.name === 'luxy_erp_console_test') await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
  } catch { /* ignore */ }
  process.exit(1);
});
