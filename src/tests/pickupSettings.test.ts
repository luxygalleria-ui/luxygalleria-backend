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
