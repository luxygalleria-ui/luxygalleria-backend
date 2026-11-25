/**
 * Phase 4 (groups A and B): Google linking never takes over a password account; order deletion is superadmin-only and
 * only for unpaid/failed orders; cancelling before shipping restocks exactly once (never after shipping) and flags a
 * paid order for refund; customers see a safe refund summary. Google is stubbed: no request leaves this machine.
 * Needs a local MongoDB; uses (and drops) a throwaway database.
 * Run: npx ts-node --transpile-only src/tests/accountOrderSafety.test.ts
 */
import assert from 'assert';
import { AddressInfo } from 'net';

const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_account_order_safety_test';
Object.assign(process.env, { NODE_ENV: 'development', HISTORY_READ_ENABLED: 'false', SENDGRID_API_KEY: '', GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com' });

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import app from '../app';
import { ENV } from '../config/env';
import { User } from '../models/User';
import { Product } from '../models/Product';
import Order from '../models/Order';
import { afterOrderCancelled } from '../utils/orderCancellation';

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`  ✅ ${name}`); };
const google = (email: string, sub: string) => { (OAuth2Client.prototype as any).getTokenInfo = async () => ({ aud: process.env.GOOGLE_CLIENT_ID, email, email_verified: 'true', sub }); };

const run = async () => {
  assert.ok(TEST_DB.endsWith('_test'));
  await mongoose.connect(TEST_DB);
  await mongoose.connection.db!.dropDatabase();
  await User.init();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, p: string, body?: unknown, token?: string) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) as any };
  };
  const tok = (u: any) => jwt.sign({ id: String(u._id), role: u.role }, ENV.JWT_SECRET, { expiresIn: '10m' });
  try {
    // ---------------- H2: Google account linking
    console.log('Google sign-in never takes over a password account');
    const victim = await User.create({ name: 'Victim', email: 'victim@test.local', password: 'Victim-Passw0rd#1', role: 'customer', isVerified: true });
    await test('a password account (e.g. pre-registered by someone else) is NOT signed into or linked by Google sign-in', async () => {
      google('victim@test.local', 'g-victim');
      const r = await call('POST', '/auth/google', { credential: 'tok', googleId: 'g-victim' });
      assert.deepStrictEqual([r.status, r.json.errors?.code ?? r.json.code], [409, 'GOOGLE_LINK_REQUIRED'], JSON.stringify(r.json));
      assert.ok(!r.json?.data?.token, 'no session issued');
      assert.strictEqual((await User.findById(victim._id).lean())!.googleId, undefined, 'not linked');
    });
    const vT = tok(victim);
    await test('the signed-in owner links Google explicitly; the Google email must be the account email', async () => {
      google('someone.else@test.local', 'g-other');
      const wrong = await call('POST', '/auth/google/link', { credential: 'tok', googleId: 'g-other' }, vT);
      assert.deepStrictEqual([wrong.status, wrong.json.errors?.code ?? wrong.json.code], [409, 'GOOGLE_EMAIL_MISMATCH']);
      assert.strictEqual((await call('POST', '/auth/google/link', { credential: 'tok', googleId: 'g-x' })).status, 401, 'must be signed in');
      google('victim@test.local', 'g-victim');
      const ok = await call('POST', '/auth/google/link', { credential: 'tok', googleId: 'g-victim' }, vT);
      assert.deepStrictEqual([ok.status, ok.json.data.googleLinked], [200, true]);
      assert.strictEqual((await call('GET', '/users/profile', undefined, vT)).json.data.googleLinked, true, 'profile says linked (never the id)');
      assert.strictEqual((await call('POST', '/auth/google/link', { credential: 'tok', googleId: 'g-victim' }, vT)).status, 200, 'linking again is harmless');
    });
    await test('after linking, Google sign-in works for that Google identity only', async () => {
      google('victim@test.local', 'g-victim');
      const r = await call('POST', '/auth/google', { credential: 'tok', googleId: 'g-victim' });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.json.data.email, 'victim@test.local');
      google('victim@test.local', 'g-impostor');
      const other = await call('POST', '/auth/google', { credential: 'tok', googleId: 'g-impostor' });
      assert.deepStrictEqual([other.status, other.json.errors?.code ?? other.json.code], [409, 'GOOGLE_ACCOUNT_MISMATCH']);
    });
    await test('a Google identity already on another account cannot be linked again; new Google users still sign up', async () => {
      const second = await User.create({ name: 'Second', email: 'second@test.local', password: 'Second-Passw0rd#1', role: 'customer', isVerified: true });
      await User.updateOne({ _id: second._id }, { $set: { googleId: 'g-taken' } });
      const third = await User.create({ name: 'Third', email: 'third@test.local', password: 'Third-Passw0rd#1', role: 'customer', isVerified: true });
      google('third@test.local', 'g-taken');
      const r = await call('POST', '/auth/google/link', { credential: 'tok', googleId: 'g-taken' }, tok(third));
      assert.deepStrictEqual([r.status, r.json.errors?.code ?? r.json.code], [409, 'GOOGLE_ALREADY_LINKED']);
      google('brand.new@test.local', 'g-new');
      const created = await call('POST', '/auth/google', { credential: 'tok', googleId: 'g-new' });
      assert.strictEqual(created.status, 200); assert.ok(created.json.data.token);
    });

    // ---------------- H3 / H4 / restock / refund flag / customer refund view
    console.log('Orders: deletion, cancellation, restock, refund visibility');
    const [admin, superadmin] = await Promise.all([
      User.create({ name: 'Admin', email: 'admin@test.local', password: 'Admin-Passw0rd#1', role: 'admin', isVerified: true }),
      User.create({ name: 'Super', email: 'super@test.local', password: 'Super-Passw0rd#1', role: 'superadmin', isVerified: true }),
    ]);
    const [aT, sT] = [tok(admin), tok(superadmin)];
    const tea = await Product.create({ name: 'Tea', category: 'Drinks', description: 'Tea', stock: 10, variants: [{ volume: '200g', price: 300, offerPrice: 300, actualPrice: 300, stock: 10, weight: 0.2 }] });
    const stock = async () => (await Product.findById(tea._id).lean())!.variants[0].stock;
    const mkOrder = (paymentStatus: string, orderStatus = 'processing', quantity = 2) => Order.create({
      user: victim._id, paymentMethod: 'icici', paymentStatus, orderStatus, fulfillmentMethod: 'delivery', subtotal: 300 * quantity, total: 300 * quantity,
      items: [{ product: tea._id, variantId: tea.variants[0]._id, name: 'Tea', quantity, price: 300, subtotal: 300 * quantity }],
      shippingAddress: { street: '1 MG Road', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' },
    });
    const setStatus = (id: unknown, orderStatus: string) => call('PUT', `/payments/admin/orders/${id}/status`, { orderStatus }, aT);

    await test('delete: admins may delete any order (pending, failed, paid, test, refunded); each is archived first', async () => {
      const archived = () => mongoose.connection.collection('deletedorders').countDocuments();
      const a0 = await archived();
      for (const [ps, token] of [['pending', aT], ['failed', sT], ['completed', aT], ['refunded', sT]] as const) {
        const o = await mkOrder(ps, ps === 'completed' ? 'shipped' : 'processing');
        const r = await call('DELETE', `/payments/admin/orders/${o._id}`, undefined, token);
        assert.strictEqual(r.status, 200, `${ps}: ${JSON.stringify(r.json)}`);
        assert.strictEqual(await Order.exists({ _id: o._id }), null, `${ps} deleted`);
      }
      assert.strictEqual(await archived(), a0 + 4, 'a copy of each deleted order is kept');
      const uat = await mkOrder('completed'); await Order.updateOne({ _id: uat._id }, { $set: { testPayment: true } });
      assert.strictEqual((await call('DELETE', `/payments/admin/orders/${uat._id}`, undefined, aT)).status, 200, 'test order');
    });
    await test('delete: a paid order not yet shipped returns its stock once; a shipped one does not', async () => {
      const s0 = await stock();
      const o = await mkOrder('completed');
      assert.strictEqual((await call('DELETE', `/payments/admin/orders/${o._id}`, undefined, sT)).status, 200);
      assert.strictEqual(await stock(), s0 + 2, 'restocked');
      const shipped = await mkOrder('completed', 'shipped');
      assert.strictEqual((await call('DELETE', `/payments/admin/orders/${shipped._id}`, undefined, sT)).status, 200);
      assert.strictEqual(await stock(), s0 + 2, 'shipped: not restocked');
    });
    await test('cancel before shipping: stock restored exactly once (a repeated cancel changes nothing); paid order flagged refund "required"', async () => {
      const o = await mkOrder('completed'); const s0 = await stock();
      const r = await setStatus(o._id, 'cancelled'); assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(await stock(), s0 + 2, 'restocked');
      assert.strictEqual((await setStatus(o._id, 'cancelled')).status, 200); // "unchanged"
      await afterOrderCancelled(o._id, 'processing'); // a racing ERP event / retry
      assert.strictEqual(await stock(), s0 + 2, 'never twice');
      const after = (await Order.findById(o._id).lean())!;
      assert.ok(after.stockRestoredAt, 'restock recorded'); assert.strictEqual(after.refund?.status, 'required');
      assert.strictEqual(r.json.data.refund?.status, 'required', 'the admin reply shows the flag');
    });
    await test('cancel after shipping: NO automatic restock; paid order still flagged for refund', async () => {
      const o = await mkOrder('completed'); assert.strictEqual((await setStatus(o._id, 'shipped')).status, 200);
      const s0 = await stock();
      assert.strictEqual((await setStatus(o._id, 'cancelled')).status, 200);
      const after = (await Order.findById(o._id).lean())!;
      assert.deepStrictEqual([await stock(), after.stockRestoredAt, after.refund?.status], [s0, undefined, 'required']);
    });
    await test('cancel an unpaid order before shipping: restocked, no refund flag; delivered orders cannot be cancelled', async () => {
      const o = await mkOrder('pending', 'processing', 1); const s0 = await stock();
      await setStatus(o._id, 'cancelled');
      const after = (await Order.findById(o._id).lean())!;
      assert.deepStrictEqual([await stock(), after.refund?.status], [s0 + 1, undefined]);
      const d = await mkOrder('completed', 'delivered');
      assert.strictEqual((await setStatus(d._id, 'cancelled')).status, 409);
    });
    await test('a refund already under way is not overwritten by the cancellation flag', async () => {
      const o = await mkOrder('completed'); await Order.updateOne({ _id: o._id }, { $set: { 'refund.status': 'pending' } });
      await setStatus(o._id, 'cancelled');
      assert.strictEqual((await Order.findById(o._id).lean())!.refund?.status, 'pending');
    });
    await test('customer view: no refund -> null; flagged -> "in_progress"; processed -> "refunded" with amount and date; nothing internal', async () => {
      const none = await mkOrder('completed', 'processing', 1);
      const due = await mkOrder('completed', 'processing', 1); await setStatus(due._id, 'cancelled');
      const done = await mkOrder('refunded', 'cancelled', 1);
      const when = new Date('2026-11-20T10:00:00Z');
      await Order.updateOne({ _id: done._id }, { $set: { refund: { status: 'processed', amountPaise: 30000, reason: 'staff-only reason', razorpayRefundId: 'rfnd_secret',
        events: [{ at: when, by: String(superadmin._id), action: 'gateway-status', outcome: 'processed', detail: 'ICICI 000 internal' }] } } });
      const mine = (await call('GET', '/payments/myorders', undefined, vT)).json.data;
      const view = (id: unknown) => mine.find((x: any) => x._id === String(id)).refund;
      assert.strictEqual(view(none._id), null);
      assert.deepStrictEqual(view(due._id), { state: 'in_progress', amount: 300, refundedAt: null });
      assert.deepStrictEqual(view(done._id), { state: 'refunded', amount: 300, refundedAt: when.toISOString() });
      const text = JSON.stringify(mine);
      for (const secret of ['staff-only reason', 'rfnd_secret', 'ICICI 000 internal', String(superadmin._id)]) assert.ok(!text.includes(secret), `leaks ${secret}`);
    });

    console.log(`\n${passed} passed`);
  } finally {
    server.close();
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
  }
};

run().catch((err) => { console.error('❌', err); process.exit(1); });
