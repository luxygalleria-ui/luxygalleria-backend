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

    // ---- PIN / state rules on save and edit (POST / PUT /users/addresses): nothing is changed, the customer is told
    const cy = await mk('Cy', []);
    const cyT = tok(cy);
    const add = (a: object) => call('POST', '/users/addresses', cyT, a);
    await test('save: valid addresses across Indian destinations, Kerala, and the Mahé / Lakshadweep exceptions are accepted as typed', async () => {
      for (const a of [
        { street: '1 MG Road', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' },
        { street: 'Hilite', city: 'Kozhikode', state: 'kerala', zipCode: '673007', country: 'India' },
        { street: '2 Anna Salai', city: 'Chennai', state: 'Tamil Nadu', zipCode: '600002', country: 'India' },
        { street: '3 CP', city: 'New Delhi', state: 'Delhi', zipCode: '110001', country: '' },
        { street: '4 Beach Rd', city: 'Mahe', state: 'Puducherry', zipCode: '673310', country: 'India' },
        { street: '5 Lagoon', city: 'Kavaratti', state: 'Lakshadweep', zipCode: '682555', country: 'India' },
      ]) {
        const r = await add(a);
        assert.strictEqual(r.status, 201, `${a.state}: ${JSON.stringify(r.json)}`);
        assert.strictEqual(r.json.data.at(-1).state, a.state, 'state stored exactly as typed');
      }
    });
    await test('save: an invalid or contradictory PIN is refused with what to fix; nothing is stored', async () => {
      const before = (await call('GET', '/users/addresses', cyT)).json.data.length;
      for (const [label, a, msg] of [
        ['Kerala PIN with Tamil Nadu (the reported pair)', { street: 'Hilite 2', city: 'Kozhikode', state: 'Tamil Nadu', zipCode: '673007' }, /673007 is a Kerala PIN code, but the state is "Tamil Nadu"/],
        ['Kerala state with a Chennai PIN', { street: 'x1', city: 'Kochi', state: 'Kerala', zipCode: '600002' }, /600002 is not a Kerala PIN code/],
        ['5 digits', { street: 'x2', city: 'Kochi', state: 'Kerala', zipCode: '68200' }, /valid 6-digit PIN/],
        ['starts with 0', { street: 'x3', city: 'Kochi', state: 'Kerala', zipCode: '082001' }, /valid 6-digit PIN/],
        ['letters', { street: 'x4', city: 'Kochi', state: 'Kerala', zipCode: '68A001' }, /valid 6-digit PIN/],
        ['missing PIN', { street: 'x5', city: 'Kochi', state: 'Kerala' }, /valid 6-digit PIN/],
        ['Mahé PIN with Tamil Nadu', { street: 'x6', city: 'Mahe', state: 'Tamil Nadu', zipCode: '673310' }, /Kerala PIN code/],
      ] as const) {
        const r = await add(a);
        assert.strictEqual(r.status, 400, label); assert.match(r.json.message, msg, label);
      }
      assert.strictEqual((await call('GET', '/users/addresses', cyT)).json.data.length, before, 'nothing saved');
    });
    await test('save: an exact duplicate (any case / spacing) is a 409; the existing address is kept, nothing deleted', async () => {
      const before = (await call('GET', '/users/addresses', cyT)).json.data;
      const r = await add({ street: '  1 mg road ', city: 'KOCHI', state: 'kerala', zipCode: '682001', country: 'india' });
      assert.strictEqual(r.status, 409, JSON.stringify(r.json));
      assert.deepStrictEqual((await call('GET', '/users/addresses', cyT)).json.data.map((a: any) => a._id), before.map((a: any) => a._id));
      assert.strictEqual((await add({ street: '1 MG Road', apartment: 'Flat 2', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' })).status, 201, 'a different flat is not a duplicate');
    });
    await test('edit: the same rules apply; an edit may keep its own values; becoming a copy of another is a 409', async () => {
      const list = (await call('GET', '/users/addresses', cyT)).json.data;
      const kozhikode = list.find((a: any) => a.city === 'Kozhikode');
      const put = (id: string, a: object) => call('PUT', `/users/addresses/${id}`, cyT, a);
      const bad = await put(kozhikode._id, { street: 'Hilite', city: 'Kozhikode', state: 'Tamil Nadu', zipCode: '673007', country: 'India' });
      assert.strictEqual(bad.status, 400); assert.match(bad.json.message, /Kerala PIN code/);
      assert.strictEqual((await put(kozhikode._id, { street: 'Hilite', city: 'Kozhikode', state: 'Kerala', zipCode: '673007', country: 'India' })).status, 200, 'own values (state recapitalised)');
      const dup = await put(kozhikode._id, { street: '1 MG Road', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' });
      assert.strictEqual(dup.status, 409);
      const after = (await call('GET', '/users/addresses', cyT)).json.data.find((a: any) => a._id === kozhikode._id);
      assert.deepStrictEqual([after.city, after.state, after.zipCode], ['Kozhikode', 'Kerala', '673007'], 'refused edits changed nothing');
    });

    console.log(`\n${passed} passed`);
  } finally {
    server.close();
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
  }
};

run().catch((err) => { console.error('❌', err); process.exit(1); });
