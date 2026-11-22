/**
 * Checkout address deletion (DELETE /users/addresses/:id, used by the checkout page): removes only the caller's own
 * address and returns the remaining list the page re-renders; another customer's address is untouchable; idempotent.
 * Needs a local MongoDB; uses (and drops) a throwaway database. No network.
 * Run: npx ts-node --transpile-only src/tests/addresses.test.ts
 */
import assert from 'assert';
import { AddressInfo } from 'net';

const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_addresses_test';
Object.assign(process.env, { NODE_ENV: 'development', HISTORY_READ_ENABLED: 'false', SENDGRID_API_KEY: '' });

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../app';
import { ENV } from '../config/env';
import { User } from '../models/User';
import Order from '../models/Order';

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`  ✅ ${name}`); };

const run = async () => {
  assert.ok(TEST_DB.endsWith('_test'));
  await mongoose.connect(TEST_DB);
  await mongoose.connection.db!.dropDatabase();
  await User.init();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, p: string, token?: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) as any };
  };
  try {
    const home = { street: '1 MG Road', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' };
    const office = { street: '9 Marine Drive', city: 'Mumbai', state: 'Maharashtra', zipCode: '400002', country: 'India' };
    const mk = (name: string, addresses: object[]) => User.create({ name, email: `${name.toLowerCase()}@test.local`, password: 'Passw0rd#123', role: 'customer', isVerified: true, addresses });
    const [ann, ben] = await Promise.all([mk('Ann', [home, office]), mk('Ben', [home])]);
    const tok = (u: any) => jwt.sign({ id: String(u._id), role: u.role }, ENV.JWT_SECRET, { expiresIn: '10m' });
    const [annT, benT] = [ann, ben].map(tok);
    const annIds = (await call('GET', '/users/addresses', annT)).json.data.map((a: any) => a._id);
    assert.strictEqual(annIds.length, 2);

    await test('another customer cannot delete it: their own list is returned unchanged and the address survives', async () => {
      const r = await call('DELETE', `/users/addresses/${annIds[1]}`, benT);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.data.length, 1, 'Ben still has his one address');
      assert.strictEqual((await call('GET', '/users/addresses', annT)).json.data.length, 2, "Ann's address is untouched");
    });
    await test("the owner deletes one address; the response is the remaining list (what checkout re-renders)", async () => {
      const r = await call('DELETE', `/users/addresses/${annIds[1]}`, annT);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json.data.map((a: any) => [a._id, a.city]), [[annIds[0], 'Kochi']]);
      assert.deepStrictEqual((await call('GET', '/users/addresses', annT)).json.data.map((a: any) => a._id), [annIds[0]]);
    });
    await test('deleting it again (double click, stale page) is harmless', async () => {
      const r = await call('DELETE', `/users/addresses/${annIds[1]}`, annT);
      assert.deepStrictEqual([r.status, r.json.data.length], [200, 1]);
    });
    await test('without a valid token: 401', async () => {
      assert.strictEqual((await call('DELETE', `/users/addresses/${annIds[0]}`)).status, 401);
      assert.strictEqual((await call('GET', '/users/addresses', annT)).json.data.length, 1);
    });
    await test('a malformed address id: 400, nothing removed', async () => {
      for (const bad of ['not-an-id', '123', `${annIds[0]}x`]) {
        const r = await call('DELETE', `/users/addresses/${bad}`, annT);
        assert.deepStrictEqual([r.status, r.json.message], [400, 'Invalid address id']);
      }
      assert.strictEqual((await call('GET', '/users/addresses', annT)).json.data.length, 1);
    });
    await test('deleting the last address leaves an empty list; a placed order keeps its delivery and billing snapshot', async () => {
      const snap = { street: '1 MG Road', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' };
      const order = await Order.create({ user: ann._id, items: [{ product: new mongoose.Types.ObjectId(), variantId: new mongoose.Types.ObjectId(), name: 'Tea', quantity: 1, price: 1, subtotal: 1 }], fulfillmentMethod: 'delivery',
        shippingAddress: snap, billingAddress: snap, subtotal: 1, total: 1, paymentMethod: 'icici' });
      const r = await call('DELETE', `/users/addresses/${annIds[0]}`, annT);
      assert.deepStrictEqual([r.status, r.json.data], [200, []]);
      const after = (await Order.findById(order._id).lean())!;
      assert.deepStrictEqual([after.shippingAddress, after.billingAddress], [snap, snap]);
      assert.ok(await User.exists({ _id: ann._id }), 'the account itself is untouched');
    });

    console.log(`\n${passed} passed`);
  } finally {
    server.close();
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
  }
};

run().catch((err) => { console.error('❌', err); process.exit(1); });
