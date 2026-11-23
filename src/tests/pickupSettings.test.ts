/**
 * Admin Store Pickup settings (PUT/GET /settings/checkout/pickup): valid saves persist and read back exactly; missing
 * mandatory fields, wrong types (incl. the live bug: a cleared charge sent as null) and unknown keys are refused with a
 * field error and change nothing; empty optional fields are accepted. Validation is the real zod schema, unweakened.
 * Needs a local MongoDB; uses (and drops) a throwaway database. No network.
 * Run: npx ts-node --transpile-only src/tests/pickupSettings.test.ts
 */
import assert from 'assert';
import { AddressInfo } from 'net';

const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_pickup_settings_test';
Object.assign(process.env, { NODE_ENV: 'development', HISTORY_READ_ENABLED: 'false', SENDGRID_API_KEY: '' });

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../app';
import { ENV } from '../config/env';
import { User } from '../models/User';
import { Product } from '../models/Product';
import { Settings } from '../models/Settings';

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`  ✅ ${name}`); };

const VALID = {
  enabled: true, storeName: 'Luxy Galleria', address: '1 MG Road, Kochi 682001', openingHours: 'Mon–Sat 10:00–20:00',
  phone: '+91 (484) 234-5678', email: 'store@example.test', instructions: 'Bring your order ID and a photo ID.',
  readyTime: 'Ready within 24 hours', charge: 25.5,
};

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
  try {
    const mk = (name: string, role: string) => User.create({ name, email: `${name.toLowerCase()}@test.local`, password: 'Passw0rd#123', role, isVerified: true });
    const tok = (u: any) => jwt.sign({ id: String(u._id), role: u.role }, ENV.JWT_SECRET, { expiresIn: '10m' });
    const [admin, customer] = await Promise.all([mk('Admin', 'admin'), mk('Cust', 'customer')]);
    const adminT = tok(admin), custT = tok(customer);
    const get = async () => (await call('GET', '/settings/checkout', undefined, adminT)).json.data;
    const put = (body: unknown, t = adminT) => call('PUT', '/settings/checkout/pickup', body, t);
    /** A refused save must leave the stored pickup settings exactly as they were. */
    const refused = async (label: string, body: unknown, field: string, message?: RegExp) => {
      const before = (await get()).settings.pickup;
      const r = await put(body);
      assert.strictEqual(r.status, 400, `${label}: ${JSON.stringify(r.json)}`);
      const err = (r.json.errors || []).find((e: any) => e.field === field);
      assert.ok(err, `${label}: field error for "${field}" (got ${JSON.stringify(r.json.errors)})`);
      if (message) assert.match(err.message, message, label);
      assert.deepStrictEqual((await get()).settings.pickup, before, `${label}: nothing changed`);
    };

    console.log('Valid settings and persistence');
    await test('valid enabled settings save (200) and read back exactly; marked as saved', async () => {
      const fresh = await get();
      assert.strictEqual(fresh.saved.pickup, false, 'never saved before');
      assert.deepStrictEqual(Object.keys(fresh.settings.pickup).sort(), Object.keys(VALID).sort(), 'GET returns exactly the fields PUT accepts');
      const r = await put(VALID);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.deepStrictEqual(r.json.data.settings.pickup, VALID);
      const after = await get();
      assert.deepStrictEqual([after.settings.pickup, after.saved.pickup], [VALID, true]);
    });
    await test('the admin flow: the object loaded by GET, edited and PUT back, is accepted (round trip)', async () => {
      const loaded = structuredClone((await get()).settings.pickup);
      const r = await put({ ...loaded, openingHours: 'Daily 09:00–21:00' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual((await get()).settings.pickup.openingHours, 'Daily 09:00–21:00');
      assert.strictEqual((await put(VALID)).status, 200);
    });
    await test('strings are trimmed before saving', async () => {
      const r = await put({ ...VALID, storeName: '  Luxy Galleria  ', readyTime: ' Ready in 2 hours ' });
      assert.strictEqual(r.status, 200);
      const p = (await get()).settings.pickup;
      assert.deepStrictEqual([p.storeName, p.readyTime], ['Luxy Galleria', 'Ready in 2 hours']);
      assert.strictEqual((await put(VALID)).status, 200);
    });
    await test('the storefront (public GET /settings) sees the saved pickup details and charge', async () => {
      const pub = await call('GET', '/settings');
      assert.strictEqual(pub.status, 200);
      const shown = pub.json.data.checkout.pickup;
      assert.deepStrictEqual(shown, { ...VALID, paymentOptions: ['pay_now'] });
    });

    console.log('Empty optional fields');
    await test('email, instructions and ready-time may be empty; charge 0 means free', async () => {
      const r = await put({ ...VALID, email: '', instructions: '', readyTime: '', charge: 0 });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const p = (await get()).settings.pickup;
      assert.deepStrictEqual([p.email, p.instructions, p.readyTime, p.charge], ['', '', '', 0]);
    });
    await test('pickup switched off may leave the store details empty (delivery remains available)', async () => {
      const r = await put({ ...VALID, enabled: false, storeName: '', address: '', openingHours: '', phone: '' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual((await put(VALID)).status, 200);
    });

    console.log('Missing mandatory fields (while pickup is enabled)');
    await test('store name, address, opening hours and phone are each required: empty or spaces -> 400 on that field', async () => {
      for (const f of ['storeName', 'address', 'openingHours', 'phone']) {
        await refused(`${f} empty`, { ...VALID, [f]: '' }, f, /Required while store pickup is enabled/);
        await refused(`${f} spaces`, { ...VALID, [f]: '   ' }, f, /Required while store pickup is enabled/);
      }
    });
    await test('a field left out of the body entirely -> 400 on that field', async () => {
      for (const f of Object.keys(VALID)) {
        const { [f as keyof typeof VALID]: _omit, ...rest } = VALID;
        await refused(`${f} missing`, rest, f);
      }
    });

    console.log('Invalid field types and values');
    await test('LIVE BUG: a cleared pickup charge arrives as null -> 400 "Expected number, received null", nothing saved', async () => {
      await refused('charge null', { ...VALID, charge: null }, 'charge', /Expected number, received null/);
      assert.strictEqual(JSON.stringify({ charge: NaN }), '{"charge":null}', 'why: JSON turns the NaN of an empty number input into null');
    });
    await test('charge must be a non-negative number with at most 2 decimals (no strings)', async () => {
      await refused('charge string', { ...VALID, charge: '50' }, 'charge', /Expected number/);
      await refused('charge negative', { ...VALID, charge: -1 }, 'charge');
      await refused('charge 3 decimals', { ...VALID, charge: 1.234 }, 'charge', /2 decimal/);
    });
    await test('enabled must be a boolean; text fields must be strings', async () => {
      await refused('enabled "true"', { ...VALID, enabled: 'true' }, 'enabled', /Expected boolean/);
      await refused('storeName number', { ...VALID, storeName: 123 }, 'storeName', /Expected string/);
      await refused('address object', { ...VALID, address: { line1: 'x' } }, 'address', /Expected string/);
    });
    await test('phone format and email format are checked', async () => {
      await refused('phone letters', { ...VALID, phone: 'call us' }, 'phone', /Digits, spaces/);
      await refused('phone with slash', { ...VALID, phone: '0484 2345678 / 98765 43210' }, 'phone', /Digits, spaces/);
      await refused('email invalid', { ...VALID, email: 'store@' }, 'email');
    });
    await test('length limits are enforced', async () => {
      await refused('storeName too long', { ...VALID, storeName: 'x'.repeat(121) }, 'storeName');
      await refused('openingHours too long', { ...VALID, openingHours: 'x'.repeat(301) }, 'openingHours');
    });
    await test('unknown fields are refused (strict schema), nothing saved', async () => {
      const r = await put({ ...VALID, paymentOptions: ['pay_now'] });
      assert.strictEqual(r.status, 400, JSON.stringify(r.json));
      assert.match(JSON.stringify(r.json.errors), /Unrecognized key/);
    });

    console.log('Checkout quotes with pickup (server-priced; nothing from the browser is trusted)');
    const tea = await Product.create({ name: 'Tea', category: 'Drinks', description: 'Tea', variants: [{ volume: '200g', price: 300, offerPrice: 300, actualPrice: 300, stock: 20, weight: 0.4 }], stock: 20 });
    const items = [{ product: String(tea._id), variantId: String(tea.variants[0]._id), quantity: 2 }];
    const kerala = { street: '1 MG Road', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' };
    // Delivery is never priced from guessed rates: save the shipping section once, exactly as the admin form does
    const ship = (await get()).settings.shipping;
    assert.strictEqual((await call('PUT', '/settings/checkout/shipping', ship, adminT)).status, 200);
    const quote = (fulfillment: object, extra: object = {}) => call('POST', '/payments/calculate-shipping', { items, fulfillment, ...extra });
    const pickupOpt = (q: any) => (q.json.data?.options || []).find((o: any) => o.fulfillment === 'pickup');
    await test('paid pickup: the configured charge once, no road/air shipping, no packaging; details and ready message from settings', async () => {
      assert.strictEqual((await put(VALID)).status, 200);
      const q = await quote({ method: 'pickup' }, { pickupFee: 0, shipping: 99, total: 1 }); // browser-sent amounts are ignored
      assert.strictEqual(q.status, 200, JSON.stringify(q.json));
      const d = q.json.data;
      assert.deepStrictEqual([d.fulfillmentMethod, d.shippingMethod, d.shipping, d.specialPackagingFee, d.pickupFee], ['pickup', null, 0, 0, 25.5]);
      assert.strictEqual(d.grandTotal, d.subtotal - d.discount + (d.tax?.addedToTotal ?? 0) + 25.5, 'pickup charge counted exactly once');
      assert.deepStrictEqual(d.pickupDetails, { storeName: VALID.storeName, address: VALID.address, openingHours: VALID.openingHours, phone: VALID.phone, instructions: VALID.instructions });
      assert.deepStrictEqual([pickupOpt(q).offered, pickupOpt(q).allowed, pickupOpt(q).fee, pickupOpt(q).eta], [true, true, 25.5, VALID.readyTime]);
    });
    await test('free pickup (charge 0): no pickup charge and no delivery fee; option says fee 0', async () => {
      assert.strictEqual((await put({ ...VALID, charge: 0 })).status, 200);
      const q = await quote({ method: 'pickup' });
      assert.deepStrictEqual([q.status, q.json.data.pickupFee, q.json.data.shipping, q.json.data.grandTotal === q.json.data.subtotal - q.json.data.discount + (q.json.data.tax?.addedToTotal ?? 0), pickupOpt(q).fee], [200, 0, 0, true, 0]);
      assert.strictEqual((await put(VALID)).status, 200);
    });
    await test('switching pickup <-> delivery re-prices: delivery adds shipping and drops the pickup charge, and back', async () => {
      const pick1 = (await quote({ method: 'pickup' })).json.data;
      const del = await quote({ method: 'delivery' }, { shippingAddress: kerala });
      assert.strictEqual(del.status, 200, JSON.stringify(del.json));
      assert.deepStrictEqual([del.json.data.fulfillmentMethod, del.json.data.pickupFee, del.json.data.pickupDetails], ['delivery', 0, null]);
      assert.ok(del.json.data.shipping > 0, 'delivery is charged shipping');
      assert.strictEqual(del.json.data.grandTotal, pick1.grandTotal - 25.5 + del.json.data.shipping + del.json.data.specialPackagingFee);
      assert.deepStrictEqual((await quote({ method: 'pickup' })).json.data, pick1, 'back to pickup: identical quote, no leftover delivery charge');
    });
    await test('pickup switched off: not selectable, with a reason; no store details, ready message or fee exposed', async () => {
      assert.strictEqual((await put({ ...VALID, enabled: false })).status, 200);
      const del = await quote({ method: 'delivery' }, { shippingAddress: kerala });
      assert.deepStrictEqual([pickupOpt(del).offered, pickupOpt(del).allowed, pickupOpt(del).reason, pickupOpt(del).eta, 'fee' in pickupOpt(del)], [false, false, 'Store pickup is not available right now', '', false]);
      const pick = await quote({ method: 'pickup' });
      assert.deepStrictEqual([pick.status, pick.json.code], [400, 'OPTION_UNAVAILABLE']);
      assert.deepStrictEqual((await call('GET', '/settings')).json.data.checkout.pickup, { enabled: false });
    });
    await test('switched on but required store details missing (hand-edited data): checkout refuses to price (503), never shows a blank store; an admin re-save restores it', async () => {
      await Settings.updateOne({}, { $set: { pickup: { ...VALID, address: '', phone: '   ' } } }); // bypasses the admin form's validation on purpose
      for (const f of [{ method: 'pickup' }, { method: 'delivery' }]) {
        const q = await quote(f, { shippingAddress: kerala });
        assert.deepStrictEqual([q.status, q.json.code], [503, 'SETTINGS_UNAVAILABLE'], JSON.stringify(f));
        assert.ok(!JSON.stringify(q.json).includes(VALID.storeName), 'no store details in the refusal');
      }
      const pub = await call('GET', '/settings');
      assert.ok(!(pub.json?.data?.checkout?.pickup?.enabled === true && !pub.json.data.checkout.pickup.address), 'public view never offers a pickup store without an address');
      assert.strictEqual((await put(VALID)).status, 200, 'saving complete details through the admin API restores it');
      assert.strictEqual((await quote({ method: 'pickup' })).status, 200);
    });

    console.log('Access');
    await test('only admins may change pickup settings', async () => {
      assert.strictEqual((await put(VALID, custT)).status, 403);
      assert.strictEqual((await call('PUT', '/settings/checkout/pickup', VALID)).status, 401);
    });

    console.log(`\n${passed} passed`);
  } finally {
    server.close();
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
  }
};

run().catch((err) => { console.error('❌', err); process.exit(1); });
