/**
 * Admin form validation failures (category, brand, coupon, banner, product) answer 400 with field-level messages,
 * never 500 and never the database driver's text (model names, "Cast to ...", echoed values). Valid saves still work.
 * Needs a local MongoDB; uses (and drops) a throwaway database. No network.
 * Run: npx ts-node --transpile-only src/tests/adminValidation.test.ts
 */
import assert from 'assert';
import { AddressInfo } from 'net';

const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_admin_validation_test';
Object.assign(process.env, { NODE_ENV: 'production', HISTORY_READ_ENABLED: 'false', SENDGRID_API_KEY: '' }); // production: generic 500s, so a 400 here is real

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../app';
import { ENV } from '../config/env';
import { User } from '../models/User';
import { clientInputError } from '../middlewares/errorHandler';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => { await fn(); passed++; console.log(`  ✅ ${name}`); };
const LEAKS = [/validation failed: \w+ validation/i, /Cast to/i, /Category|Brand|Coupon|Banner|Product validation/, /ObjectId/, /not-a-date|EVIL-VALUE/, /mongo/i];

const run = async () => {
  assert.ok(TEST_DB.endsWith('_test'));
  await mongoose.connect(TEST_DB);
  await mongoose.connection.db!.dropDatabase();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  let ip = 0; // a fresh client address per call: production rate limits stay out of the way
  const call = async (method: string, p: string, body: unknown, token: string) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Forwarded-For': `10.9.0.${++ip}` }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  /** 400, a message naming the problem, nothing from the driver. */
  const rejects = async (method: string, p: string, body: unknown, expect: RegExp) => {
    const r = await call(method, p, body, adminT);
    assert.strictEqual(r.status, 400, `${method} ${p}: ${r.status} ${r.json?.message}`);
    assert.match(r.json.message, expect);
    for (const leak of LEAKS) assert.doesNotMatch(r.json.message, leak, `${method} ${p} leaked: ${r.json.message}`);
    assert.strictEqual(r.json.errors ?? null, null, 'no stack or driver detail in errors');
    return r.json.message as string;
  };

  const admin = await User.create({ name: 'Boss', email: 'boss@test.local', password: 'Admin-Passw0rd#1', role: 'superadmin', isVerified: true });
  const adminT = jwt.sign({ id: String(admin._id), role: admin.role }, ENV.JWT_SECRET, { expiresIn: '10m' });
  const v = { size: '30ml', volume: '30ml', flavor: 'Default', offerPrice: 500, actualPrice: 500, stock: 1, weight: 0.1 };

  try {
    await test('category: missing image -> 400 "image is required"; valid category -> 201', async () => {
      await rejects('POST', '/categories', { name: 'Chocolates' }, /^Validation failed: image is required$/);
      assert.strictEqual((await call('POST', '/categories', { name: 'Chocolates', image: 'x.png' }, adminT)).status, 201);
    });
    await test('category: update with a malformed id -> 400 "Invalid _id"', async () => {
      await rejects('PUT', '/categories/not-an-id', { name: 'x' }, /^Invalid _id$/);
    });
    await test('brand: missing name -> 400; valid brand -> 201', async () => {
      await rejects('POST', '/brands', {}, /name is required/);
      assert.strictEqual((await call('POST', '/brands', { name: 'Lindt' }, adminT)).status, 201);
    });
    await test('coupon: every missing field listed; an unparsable date is "invalid" without echoing it', async () => {
      const msg = await rejects('POST', '/coupons', { code: 'SAVE10' }, /discount is required/);
      assert.match(msg, /expiryDate is required/);
      await rejects('POST', '/coupons', { code: 'SAVE10', discount: '10%', expiryDate: 'not-a-date' }, /^Validation failed: expiryDate is invalid$/);
      await rejects('POST', '/coupons', { code: 'SAVE10', discount: '10%', expiryDate: '2030-01-01', usageLimit: 'EVIL-VALUE' }, /usageLimit is invalid/);
      assert.strictEqual((await call('POST', '/coupons', { code: 'SAVE10', discount: '10%', expiryDate: '2030-01-01' }, adminT)).status, 201);
    });
    await test('banner: non-text title -> 400; malformed id -> 400; valid banner -> 201', async () => {
      await rejects('POST', '/banners', { title: { nested: 'EVIL-VALUE' } }, /title is invalid/);
      await rejects('PUT', '/banners/not-an-id', { title: 'x' }, /^Invalid _id$/);
      assert.strictEqual((await call('POST', '/banners', { title: 'Sale' }, adminT)).status, 201);
    });
    await test('product: missing description -> 400; malformed category id -> 400; existing checks still 400; valid -> 201', async () => {
      await rejects('POST', '/products', { name: 'Oud', category: 'Perfume', variants: [v] }, /description is required/);
      await rejects('POST', '/products', { name: 'Oud', description: 'x', category: 'Perfume', categoryId: 'not-an-id', variants: [v] }, /^Invalid _id$/);
      assert.strictEqual((await call('POST', '/products', { name: 'Oud', description: 'x', category: 'Perfume', variants: [] }, adminT)).json.message, 'At least one variant is required');
      assert.strictEqual((await call('POST', '/products', { name: 'Oud', description: 'Oud oil', category: 'Perfume', variants: [v] }, adminT)).status, 201);
    });
    await test('classifier: per-rule messages without the submitted value; non-validation errors untouched', () => {
      const ve = (errors: object) => Object.assign(new Error('X validation failed'), { name: 'ValidationError', errors });
      assert.deepStrictEqual(clientInputError(ve({ a: { path: 'name', kind: 'required', properties: {} } })), { statusCode: 400, message: 'Validation failed: name is required' });
      assert.strictEqual(clientInputError(ve({ a: { path: 'qty', kind: 'min', properties: { message: 'Path `qty` (-5) is less than minimum allowed value (0).', min: 0 } } }))!.message, 'Validation failed: qty must be at least 0');
      assert.strictEqual(clientInputError(ve({ a: { path: 'x', kind: 'enum', properties: {} }, b: { path: 'x', kind: 'enum', properties: {} } }))!.message, 'Validation failed: x has an unsupported value');
      assert.strictEqual(clientInputError(new Error('boom')), null);
      assert.strictEqual(clientInputError(Object.assign(new Error('E11000 duplicate key'), { code: 11000 })), null, 'not a validation error: stays a 500');
    });

    console.log(`\n${passed} passed`);
  } finally {
    server.close();
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
  }
};

run().then(() => process.exit(0), (err) => { console.error('❌', err); process.exit(1); });
