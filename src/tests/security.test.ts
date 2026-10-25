/**
 * Security regression tests for the audit fixes (SECURITY_AUDIT_REPORT.md).
 * Needs a local MongoDB; uses a throwaway database and stubs Razorpay/Google/SendGrid.
 * Run: npx ts-node --transpile-only src/tests/security.test.ts
 */
import assert from 'assert';
import crypto from 'crypto';
import { AddressInfo } from 'net';

// Must be set before the app (and dotenv) load. Never touch the real DB, mail or payment provider.
const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_security_test';
process.env.NODE_ENV = 'development'; // keeps rate limiters off; ENV.NODE_ENV is flipped per test below
process.env.HISTORY_READ_ENABLED = 'false'; // never reach a developer's history login from .env
process.env.SENDGRID_API_KEY = '';
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import app from '../app';
import { ENV } from '../config/env';
import { User } from '../models/User';
import { Product } from '../models/Product';
import Order from '../models/Order';
import { razorpayInstance } from '../controllers/paymentController';

const RZP_SECRET = 'test_secret_for_signatures';
const realKeys = () => { process.env.RAZORPAY_KEY_ID = 'rzp_test_unit'; process.env.RAZORPAY_KEY_SECRET = RZP_SECRET; };
const noKeys = () => { delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET; };

let base = '';
let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  passed++;
  console.log(`  ✅ ${name}`);
};

const call = async (method: string, path: string, body?: any, token?: string, headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, headers: res.headers };
};

const sign = (orderId: string, paymentId: string) =>
  crypto.createHmac('sha256', RZP_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

const run = async () => {
  assert.ok(TEST_DB.includes('127.0.0.1') && TEST_DB.endsWith('_test'), 'refusing to run against a non-test database');
  await mongoose.connect(TEST_DB);
  await mongoose.connection.db!.dropDatabase();
  await Order.init(); // build indexes

  const server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

  const admin = await User.create({ name: 'Admin', email: 'admin@test.local', password: 'Admin#12345', role: 'superadmin', isVerified: true });
  const alice = await User.create({ name: 'Alice', email: 'alice@test.local', password: 'Alice#12345', role: 'customer', isVerified: true });
  const bob = await User.create({ name: 'Bob', email: 'bob@test.local', password: 'Bob#12345', role: 'customer', isVerified: true });
  const tok = (u: any) => jwt.sign({ id: u._id.toString(), role: u.role }, ENV.JWT_SECRET, { expiresIn: '1h' });
  const adminT = tok(admin), aliceT = tok(alice), bobT = tok(bob);

  const product = await Product.create({
    name: 'Saffron', category: 'Spices', description: 'Premium saffron threads',
    variants: [{ volume: '1g', price: 500, offerPrice: 500, actualPrice: 600, stock: 5, weight: 0.001 }],
    stock: 5,
  });
  const variantId = product.variants[0]._id!.toString();
  const pid = product._id.toString();
  const address = { street: '1 Test St', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' };
  const item = (quantity: number, price = 500) => ({ product: pid, variantId, quantity, price, size: '1g' });
  // 1 x ₹500, weight 1g -> ₹40 shipping under the default config
  const TOTAL_1 = 540;

  console.log('\nAuthentication');
  await test('C1: forged Google login (attacker-chosen email, foreign token audience) is rejected', async () => {
    (OAuth2Client.prototype as any).getTokenInfo = async () => ({ aud: 'someone-elses-app', email: 'admin@test.local', email_verified: true, sub: '1' });
    const r = await call('POST', '/auth/google', { credential: 'tok', googleId: '1', email: 'admin@test.local', name: 'x' });
    assert.strictEqual(r.status, 401);
    assert.ok(!r.json?.data?.token);
  });
  await test('C1: body email is ignored; identity comes from Google token', async () => {
    (OAuth2Client.prototype as any).getTokenInfo = async () => ({ aud: process.env.GOOGLE_CLIENT_ID, email: 'alice@test.local', email_verified: 'true', sub: 'g-alice' });
    const r = await call('POST', '/auth/google', { credential: 'tok', googleId: 'g-alice', email: 'admin@test.local' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.email, 'alice@test.local');
    assert.strictEqual(r.json.data.role, 'customer');
  });
  await test('C1: Google login cannot mint an admin session', async () => {
    (OAuth2Client.prototype as any).getTokenInfo = async () => ({ aud: process.env.GOOGLE_CLIENT_ID, email: 'admin@test.local', email_verified: true, sub: 'g-admin' });
    const r = await call('POST', '/auth/google', { credential: 'tok', googleId: 'g-admin' });
    assert.strictEqual(r.status, 403);
  });
  await test('C1: unverified Google email is rejected', async () => {
    (OAuth2Client.prototype as any).getTokenInfo = async () => ({ aud: process.env.GOOGLE_CLIENT_ID, email: 'new@test.local', email_verified: false, sub: 'g-new' });
    const r = await call('POST', '/auth/google', { credential: 'tok', googleId: 'g-new' });
    assert.strictEqual(r.status, 401);
  });
  await test('token signed with the old fallback secret is rejected', async () => {
    const forged = jwt.sign({ id: admin._id.toString(), role: 'superadmin' }, 'fallback_secret');
    const r = await call('GET', '/dashboard/stats', undefined, forged);
    assert.strictEqual(r.status, 401);
  });
  await test('resend-otp never returns the OTP', async () => {
    await User.create({ name: 'Pending', email: 'pending@test.local', password: 'Pending#123', isVerified: false });
    const r = await call('POST', '/auth/resend-otp', { email: 'pending@test.local' });
    assert.strictEqual(r.status, 200);
    assert.ok(!JSON.stringify(r.json).match(/\b\d{6}\b/), 'OTP leaked in response');
  });

  console.log('\nAuthorization (customer vs admin)');
  const customerWrites: Array<[string, string, any?]> = [
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
      assert.strictEqual(r.status, 403, `${m} ${p} returned ${r.status}`);
    }
    const still = await Product.findById(pid);
    assert.strictEqual(still?.variants[0].offerPrice, 500, 'price changed by customer');
  });
  await test('C2: anonymous gets 401 on admin endpoints', async () => {
    assert.strictEqual((await call('DELETE', `/products/${pid}`)).status, 401);
  });
  await test('C2: admin can still update a product', async () => {
    const r = await call('PUT', `/products/${pid}`, { description: 'Premium saffron threads, updated' }, adminT);
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  });
  await test('admin cannot deactivate another admin via customer toggle', async () => {
    const r = await call('PUT', `/users/admin/customers/${admin._id}/toggle-status`, undefined, adminT);
    assert.strictEqual(r.status, 404);
    assert.strictEqual((await User.findById(admin._id))?.isActive, true);
  });
  await test('upload rejects non-image files (admin)', async () => {
    const fd = new FormData();
    fd.append('imageFile', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'x.html');
    const res = await fetch(`${base}/upload`, { method: 'POST', headers: { Authorization: `Bearer ${adminT}` }, body: fd });
    assert.strictEqual(res.status, 400);
  });

  console.log('\nPayments');
  await test('C3: mock payment rejected outside development', async () => {
    ENV.NODE_ENV = 'production'; noKeys();
    try {
      const r = await call('POST', '/payments/verify', {
        razorpay_order_id: 'mock_order_1', razorpay_payment_id: 'mock_payment', razorpay_signature: 'mock_signature',
        items: [item(1)], shippingAddress: address, total: TOTAL_1,
      }, aliceT);
      assert.strictEqual(r.status, 400);
      const c = await call('POST', '/payments/create-order', { total: TOTAL_1, items: [item(1)], shippingAddress: address }, aliceT);
      assert.strictEqual(c.status, 503, 'production without keys must not fall back to mock orders');
    } finally { ENV.NODE_ENV = 'development'; }
    assert.strictEqual(await Order.countDocuments(), 0);
  });
  await test('C3: mock payment rejected in development when real keys are configured', async () => {
    realKeys();
    const r = await call('POST', '/payments/verify', {
      razorpay_order_id: 'mock_order_2', razorpay_payment_id: 'mock_payment', items: [item(1)], shippingAddress: address, total: TOTAL_1,
    }, aliceT);
    assert.strictEqual(r.status, 400);
  });
  await test('mock checkout still works in local development without keys; order uses DB price', async () => {
    noKeys();
    const c = await call('POST', '/payments/create-order', { total: TOTAL_1, items: [item(1)], shippingAddress: address }, aliceT);
    assert.strictEqual(c.status, 200);
    assert.ok(c.json.data.isMock);
    const r = await call('POST', '/payments/verify', {
      razorpay_order_id: c.json.data.razorpayOrder.id, razorpay_payment_id: 'mock_payment', razorpay_signature: 'mock_signature',
      items: [item(1, 1)], shippingAddress: address, total: TOTAL_1,
    }, aliceT);
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.data.items[0].price, 500, 'client-sent price stored');
    assert.strictEqual((await Product.findById(pid))?.variants[0].stock, 4);
  });

  realKeys();
  let created: any = null;
  (razorpayInstance.orders as any).create = async (o: any) => { created = o; return { id: `order_${Date.now()}`, amount: o.amount, currency: 'INR' }; };
  const payments: Record<string, any> = {};
  (razorpayInstance.payments as any).fetch = async (id: string) => payments[id];

  await test('create-order charges the server-calculated amount', async () => {
    const c = await call('POST', '/payments/create-order', { total: TOTAL_1, items: [item(1, 1)], shippingAddress: address }, aliceT);
    assert.strictEqual(c.status, 200);
    assert.strictEqual(created.amount, TOTAL_1 * 100);
  });
  await test('invalid quantities / ids / oversell rejected before payment', async () => {
    for (const items of [[item(0.5)], [item(-1)], [item(1000)], [{ ...item(1), product: 'not-an-id' }], [{ ...item(1), product: { $ne: null } }]]) {
      const r = await call('POST', '/payments/create-order', { total: 1, items, shippingAddress: address }, aliceT);
      assert.strictEqual(r.status, 400, JSON.stringify(items));
    }
    const r = await call('POST', '/payments/create-order', { total: 500 * 5 + 40, items: [item(5)], shippingAddress: address }, aliceT);
    assert.strictEqual(r.status, 400, 'oversell allowed');
    assert.match(r.json.message, /left in stock/);
  });
  await test('invalid Razorpay signature rejected', async () => {
    payments.pay_bad = { order_id: 'order_a', status: 'captured', amount: TOTAL_1 * 100, currency: 'INR' };
    const r = await call('POST', '/payments/verify', {
      razorpay_order_id: 'order_a', razorpay_payment_id: 'pay_bad', razorpay_signature: 'deadbeef', items: [item(1)], shippingAddress: address, total: TOTAL_1,
    }, aliceT);
    assert.strictEqual(r.status, 400);
  });
  await test('C4: valid signature for a cheaper payment cannot buy a pricier cart', async () => {
    payments.pay_cheap = { order_id: 'order_cheap', status: 'captured', amount: 100 * 100, currency: 'INR' };
    const r = await call('POST', '/payments/verify', {
      razorpay_order_id: 'order_cheap', razorpay_payment_id: 'pay_cheap', razorpay_signature: sign('order_cheap', 'pay_cheap'),
      items: [item(2)], shippingAddress: address, total: 1040,
    }, aliceT);
    assert.strictEqual(r.status, 400);
  });
  await test('C4: payment belonging to a different Razorpay order rejected', async () => {
    payments.pay_other = { order_id: 'order_zzz', status: 'captured', amount: TOTAL_1 * 100, currency: 'INR' };
    const r = await call('POST', '/payments/verify', {
      razorpay_order_id: 'order_b', razorpay_payment_id: 'pay_other', razorpay_signature: sign('order_b', 'pay_other'),
      items: [item(1)], shippingAddress: address, total: TOTAL_1,
    }, aliceT);
    assert.strictEqual(r.status, 400);
  });
  await test('legit Razorpay payment creates exactly one order and decrements stock once', async () => {
    const before = (await Product.findById(pid))!.variants[0].stock;
    // Payments are verified against the server's checkout session, so the Razorpay order must come from create-order
    const c = await call('POST', '/payments/create-order', { total: TOTAL_1, items: [item(1, 1)], shippingAddress: address }, aliceT);
    assert.strictEqual(c.status, 200, JSON.stringify(c.json));
    const orderOk = c.json.data.razorpayOrder.id;
    payments.pay_ok = { id: 'pay_ok', order_id: orderOk, status: 'captured', amount: TOTAL_1 * 100, currency: 'INR' };
    const body = {
      razorpay_order_id: orderOk, razorpay_payment_id: 'pay_ok', razorpay_signature: sign(orderOk, 'pay_ok'),
      items: [item(1, 1)], shippingAddress: address, total: TOTAL_1,
    };
    const r1 = await call('POST', '/payments/verify', body, aliceT);
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.json));
    assert.strictEqual(r1.json.data.total, TOTAL_1);
    assert.strictEqual(r1.json.data.items[0].price, 500);
    // C5: replay by the same user is idempotent, by another user is refused
    const r2 = await call('POST', '/payments/verify', body, aliceT);
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r2.json.data._id, r1.json.data._id);
    const r3 = await call('POST', '/payments/verify', body, bobT);
    assert.strictEqual(r3.status, 409);
    assert.strictEqual(await Order.countDocuments({ razorpayPaymentId: 'pay_ok' }), 1);
    assert.strictEqual((await Product.findById(pid))!.variants[0].stock, before - 1);
  });
  await test('C5: database refuses a second order for the same Razorpay order', async () => {
    const o = await Order.findOne({ razorpayPaymentId: 'pay_ok' }).lean();
    const { _id, ...copy } = o as any;
    await assert.rejects(Order.create({ ...copy, razorpayPaymentId: 'pay_dup' }), /E11000/);
  });

  console.log('\nOrders');
  await test('customers only see their own orders', async () => {
    const mine = await call('GET', '/payments/myorders', undefined, bobT);
    assert.strictEqual(mine.status, 200);
    assert.strictEqual(mine.json.data.length, 0);
  });
  await test('admin cannot set an invalid order status', async () => {
    const o = await Order.findOne({ razorpayPaymentId: 'pay_ok' });
    const bad = await call('PUT', `/payments/admin/orders/${o!._id}/status`, { orderStatus: '<b>hacked</b>' }, adminT);
    assert.strictEqual(bad.status, 400);
    const good = await call('PUT', `/payments/admin/orders/${o!._id}/status`, { orderStatus: 'shipped' }, adminT);
    assert.strictEqual(good.status, 200);
  });

  console.log('\nHTTP');
  await test('CORS: foreign *.vercel.app origin not allowed, production origin allowed', async () => {
    const evil = await call('GET', '/health', undefined, undefined, { Origin: 'https://attacker-demo.vercel.app' });
    assert.notStrictEqual(evil.headers.get('access-control-allow-origin'), 'https://attacker-demo.vercel.app');
    const ok = await call('GET', '/health', undefined, undefined, { Origin: 'https://luxygalleria-frontend.vercel.app' });
    assert.strictEqual(ok.headers.get('access-control-allow-origin'), 'https://luxygalleria-frontend.vercel.app');
  });
  await test('CORS: custom domains allowed (GET + preflight), unknown origin gets 403', async () => {
    for (const origin of ['https://luxygalleria.com', 'https://www.luxygalleria.com', 'https://admin.luxygalleria.com']) {
      const get = await call('GET', '/banners', undefined, undefined, { Origin: origin });
      assert.strictEqual(get.status, 200);
      assert.strictEqual(get.headers.get('access-control-allow-origin'), origin);
      assert.strictEqual(get.headers.get('access-control-allow-credentials'), 'true');
      const pre = await fetch(base + '/auth/login', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' } });
      assert.ok(pre.status === 200 || pre.status === 204);
      assert.strictEqual(pre.headers.get('access-control-allow-origin'), origin);
      assert.match(pre.headers.get('access-control-allow-headers') || '', /authorization/i);
    }
    const evil = await call('GET', '/banners', undefined, undefined, { Origin: 'https://evil.example.com' });
    assert.strictEqual(evil.status, 403);
    assert.strictEqual(evil.headers.get('access-control-allow-origin'), null);
  });
  await test('product search treats regex metacharacters literally', async () => {
    const r = await call('GET', `/products?search=${encodeURIComponent('(a+)+$')}`);
    assert.strictEqual(r.status, 200);
  });

  server.close();
  assert.strictEqual(mongoose.connection.name, 'luxy_security_test');
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
  console.log(`\n=== Summary: ${passed} passed, 0 failed ===`);
};

run().catch(async (err) => {
  console.error('\n❌ FAILED:', err);
  try {
    if (mongoose.connection.name === 'luxy_security_test') await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
  } catch { /* ignore */ }
  process.exit(1);
});
