/**
 * Admin product API and variants: stable variant ids, SKU rules, and stock that only explicit adjustments change.
 * Needs a local MongoDB; uses (and drops) a throwaway database.
 * Run: npx ts-node --transpile-only src/tests/products.test.ts
 */
import assert from 'assert';
import { AddressInfo } from 'net';
process.env.NODE_ENV = 'development';
process.env.HISTORY_READ_ENABLED = 'false';
process.env.SENDGRID_API_KEY = '';
const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_products_test';

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../app';
import { ENV } from '../config/env';
import { User } from '../models/User';
import { Product } from '../models/Product';
import Order from '../models/Order';
import { CheckoutSession } from '../models/CheckoutSession';

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`  ✅ ${name}`); };

const run = async () => {
  assert.ok(TEST_DB.includes('127.0.0.1') && TEST_DB.endsWith('_test'), 'refusing to run against a non-test database');
  await mongoose.connect(TEST_DB);
  await mongoose.connection.db!.dropDatabase();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) as any };
  };

  try {
    const admin = await User.create({ name: 'Admin', email: 'admin@test.local', password: 'Admin#12345', role: 'admin', isVerified: true });
    const cust = await User.create({ name: 'Cust', email: 'cust@test.local', password: 'Cust#12345', role: 'customer', isVerified: true });
    const tok = (u: any) => jwt.sign({ id: String(u._id), role: u.role }, ENV.JWT_SECRET, { expiresIn: '10m' });
    const [adminT, custT] = [tok(admin), tok(cust)];
    const load = async (id: string) => (await Product.findById(id).lean()) as any;
    /** The variants as the admin form sends them back: loaded values, originalStock = the stock it showed. */
    const asLoaded = (p: any) => p.variants.map((v: any) => ({ ...v, _id: String(v._id), originalStock: v.stock }));

    const v = (size: string, price: number, stock: number, sku?: string) => ({ size, volume: size, flavor: 'Default', offerPrice: price, actualPrice: price, stock, weight: 0.1, ...(sku ? { sku } : {}) });
    let id = '';

    await test('create: several variants, each with its own id, SKU, price and stock; empty SKU is omitted, not ""', async () => {
      const r = await call('POST', '/products', { name: 'Oud', description: 'Oud oil', category: 'Perfume', variants: [v('30ml', 500, 4, ' OUD-30 '), v('50ml', 800, 6, 'OUD-50'), v('100ml', 1400, 2)] }, adminT);
      assert.strictEqual(r.status, 201, JSON.stringify(r.json));
      id = r.json.data._id;
      const p = await load(id);
      assert.strictEqual(new Set(p.variants.map((x: any) => String(x._id))).size, 3);
      assert.deepStrictEqual(p.variants.map((x: any) => [x.sku, x.offerPrice, x.stock]), [['OUD-30', 500, 4], ['OUD-50', 800, 6], [undefined, 1400, 2]]);
      assert.strictEqual(p.stock, 12);
    });

    await test('create: validated on the server (no variants, negative stock, bad price, duplicate SKUs); admin only', async () => {
      const bad = async (variants: any, status = 400) => assert.strictEqual((await call('POST', '/products', { name: 'X', description: 'x', category: 'Perfume', variants }, adminT)).status, status);
      await bad([]);
      await bad([v('30ml', 500, -1)]);
      await bad([v('30ml', 500, 1.5)]);
      await bad([v('30ml', 0, 1)]);
      await bad([{ ...v('30ml', 500, 1), actualPrice: 400 }]);
      await bad([v('30ml', 500, 1, 'DUP'), v('50ml', 500, 1, 'DUP')]);
      await bad([v('30ml', 500, 1, 'OUD-50')], 409); // used by another product
      await bad([v('30ml', 500, 1, 'X'.repeat(65))]);
      assert.strictEqual((await call('POST', '/products', { name: 'X', description: 'x', category: 'Perfume', variants: [v('30ml', 500, 1)] }, custT)).status, 403);
      assert.strictEqual(await Product.countDocuments(), 1, 'nothing created by refused requests');
    });

    await test('editing product details keeps variant ids, current stock and stockAsOf, even from a stale form', async () => {
      const opened = await load(id); // the admin opens the form...
      // ...meanwhile a checkout reserves 3 units and the ERP stamps its stock figure
      const asOf = new Date('2026-10-01T10:00:00Z');
      await Product.updateOne({ _id: id }, { $inc: { 'variants.0.stock': -3, stock: -3 }, $set: { 'variants.1.stockAsOf': asOf } });
      const r = await call('PUT', `/products/${id}`, { name: 'Royal Oud', description: 'New copy', stock: 999, variants: asLoaded(opened) }, adminT);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const p = await load(id);
      assert.deepStrictEqual(p.variants.map((x: any) => String(x._id)), opened.variants.map((x: any) => String(x._id)), 'same ids, same order');
      assert.deepStrictEqual(p.variants.map((x: any) => x.stock), [1, 6, 2], 'reservation kept; stale form stock ignored');
      assert.strictEqual(p.variants[1].stockAsOf.toISOString(), asOf.toISOString(), 'stockAsOf kept');
      assert.deepStrictEqual([p.name, p.stock], ['Royal Oud', 9], 'parent stock is derived, never taken from the form');
    });

    await test('editing one variant changes only that variant', async () => {
      const opened = await load(id);
      const variants = asLoaded(opened);
      variants[2] = { ...variants[2], offerPrice: 1300, actualPrice: 1500, flavor: 'Smoky' };
      assert.strictEqual((await call('PUT', `/products/${id}`, { variants }, adminT)).status, 200);
      const p = await load(id);
      assert.deepStrictEqual([p.variants[2].offerPrice, p.variants[2].price, p.variants[2].oldPrice, p.variants[2].flavor], [1300, 1300, 1500, 'Smoky']);
      for (const i of [0, 1]) assert.deepStrictEqual(p.variants[i], opened.variants[i], `variant ${i} untouched`);
    });

    await test('stock changes only by an explicit adjustment, refused when the stock moved since the form loaded', async () => {
      const opened = await load(id);
      const variants = asLoaded(opened);
      variants[0] = { ...variants[0], stock: 10 };
      assert.strictEqual((await call('PUT', `/products/${id}`, { variants }, adminT)).status, 200);
      let p = await load(id);
      assert.deepStrictEqual(p.variants.map((x: any) => x.stock), [10, 6, 2]);
      assert.strictEqual(p.variants[1].stockAsOf.toISOString(), opened.variants[1].stockAsOf.toISOString());
      assert.strictEqual(p.stock, 18);
      // Same stale form again (originalStock 1, but stock is now 10): refused, nothing written
      const stale = await call('PUT', `/products/${id}`, { name: 'Should not save', variants: asLoaded(opened).map((x: any, i: number) => (i === 0 ? { ...x, stock: 4 } : x)) }, adminT);
      assert.deepStrictEqual([stale.status, stale.json.errors[0].code], [409, 'STOCK_CHANGED']);
      p = await load(id);
      assert.deepStrictEqual([p.name, p.variants[0].stock], ['Royal Oud', 10]);
      const neg = asLoaded(p).map((x: any, i: number) => (i === 0 ? { ...x, stock: -5 } : x));
      assert.strictEqual((await call('PUT', `/products/${id}`, { variants: neg }, adminT)).status, 400);
    });

    await test('adding a variant: new id with its own starting stock; existing variants untouched', async () => {
      const opened = await load(id);
      const r = await call('PUT', `/products/${id}`, { variants: [...asLoaded(opened), v('200ml', 2500, 7, 'OUD-200')] }, adminT);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const p = await load(id);
      assert.strictEqual(p.variants.length, 4);
      assert.deepStrictEqual(p.variants.slice(0, 3), opened.variants);
      assert.deepStrictEqual([p.variants[3].sku, p.variants[3].stock, p.variants[3].stockAsOf], ['OUD-200', 7, undefined]);
      assert.strictEqual(p.stock, 25);
    });

    await test('SKU: can be set once on a variant without one; never changed, cleared or duplicated here', async () => {
      const opened = await load(id);
      const set = asLoaded(opened).map((x: any, i: number) => (i === 2 ? { ...x, sku: 'OUD-100' } : x));
      assert.strictEqual((await call('PUT', `/products/${id}`, { variants: set }, adminT)).status, 200);
      let p = await load(id);
      assert.deepStrictEqual([p.variants[2].sku, String(p.variants[2]._id)], ['OUD-100', String(opened.variants[2]._id)]);
      const change = await call('PUT', `/products/${id}`, { variants: asLoaded(p).map((x: any, i: number) => (i === 0 ? { ...x, sku: 'OTHER' } : x)) }, adminT);
      assert.deepStrictEqual([change.status, change.json.errors[0].code], [409, 'SKU_LOCKED']);
      const clear = await call('PUT', `/products/${id}`, { variants: asLoaded(p).map((x: any, i: number) => (i === 0 ? { ...x, sku: '' } : x)) }, adminT);
      assert.strictEqual(clear.status, 409);
      const other = await Product.create({ name: 'Musk', category: 'Perfume', description: 'Musk', variants: [{ volume: '30ml', price: 300, offerPrice: 300, actualPrice: 300, stock: 1, weight: 0.1 }] });
      const dup = await call('PUT', `/products/${other._id}`, { variants: [{ ...(await load(String(other._id))).variants[0], sku: 'OUD-30' }] }, adminT);
      assert.deepStrictEqual([dup.status, dup.json.errors[0].code], [409, 'DUPLICATE_SKU']);
      p = await load(id);
      assert.deepStrictEqual(p.variants.map((x: any) => x.sku), ['OUD-30', 'OUD-50', 'OUD-100', 'OUD-200']);
      await Product.deleteOne({ _id: other._id });
    });

    await test('legacy SKUs with surrounding or only spaces: product still saves; spaces-only counts as no SKU', async () => {
      // As older code could store them (written directly: the current API never stores untrimmed SKUs)
      const legacy = await Product.create({ name: 'Legacy', category: 'Perfume', description: 'x', variants: [
        { volume: '10ml', price: 100, offerPrice: 100, actualPrice: 100, stock: 3, weight: 0.01, sku: ' LEG-1 ' },
        { volume: '20ml', price: 200, offerPrice: 200, actualPrice: 200, stock: 4, weight: 0.02, sku: '   ' },
      ] });
      const lid = String(legacy._id);
      // What the admin form sends: the loaded SKUs, trimmed
      const asForm = async () => asLoaded(await load(lid)).map((x: any) => ({ ...x, sku: (x.sku || '').trim() }));
      const saved = await call('PUT', `/products/${lid}`, { name: 'Legacy Renamed', variants: await asForm() }, adminT);
      assert.strictEqual(saved.status, 200, JSON.stringify(saved.json));
      let p = await load(lid);
      assert.deepStrictEqual([p.name, p.variants[0].sku, p.variants[1].sku], ['Legacy Renamed', ' LEG-1 ', '   '], 'stored SKUs are not rewritten');
      // A stray-space SKU is still an assigned SKU: locked
      const change = await call('PUT', `/products/${lid}`, { variants: (await asForm()).map((x: any, i: number) => (i === 0 ? { ...x, sku: 'OTHER' } : x)) }, adminT);
      assert.deepStrictEqual([change.status, change.json.errors[0].code], [409, 'SKU_LOCKED']);
      // ...and it counts for duplicates, trimmed, anywhere in the catalogue
      const dup = await call('PUT', `/products/${lid}`, { variants: (await asForm()).map((x: any, i: number) => (i === 1 ? { ...x, sku: 'LEG-1' } : x)) }, adminT);
      assert.deepStrictEqual([dup.status, dup.json.errors[0].code], [409, 'DUPLICATE_SKU']);
      // The spaces-only variant can receive a real SKU
      const assign = await call('PUT', `/products/${lid}`, { variants: (await asForm()).map((x: any, i: number) => (i === 1 ? { ...x, sku: '  LEG-2 ' } : x)) }, adminT);
      assert.strictEqual(assign.status, 200, JSON.stringify(assign.json));
      p = await load(lid);
      assert.deepStrictEqual([p.variants[0].sku, p.variants[1].sku, p.variants[1].stock], [' LEG-1 ', 'LEG-2', 4]);
      // Creating with a spaces-only SKU stores none
      const created = await call('POST', '/products', { name: 'Blank Sku', description: 'x', category: 'Perfume', variants: [v('5ml', 50, 1, '   ')] }, adminT);
      assert.strictEqual(created.status, 201, JSON.stringify(created.json));
      assert.strictEqual((await load(created.json.data._id)).variants[0].sku, undefined);
      await Product.deleteMany({ _id: { $in: [legacy._id, created.json.data._id] } });
    });

    await test('a variant id from another product, or listed twice, is refused', async () => {
      const opened = await load(id);
      const foreign = await call('PUT', `/products/${id}`, { variants: [...asLoaded(opened), { ...asLoaded(opened)[0], _id: String(new mongoose.Types.ObjectId()) }] }, adminT);
      assert.strictEqual(foreign.status, 400);
      const twice = await call('PUT', `/products/${id}`, { variants: [...asLoaded(opened), asLoaded(opened)[0]] }, adminT);
      assert.strictEqual(twice.status, 400);
      assert.deepStrictEqual(await load(id), opened, 'nothing written');
    });

    await test('a variant in an order or open checkout cannot be removed; an unused one can', async () => {
      const opened = await load(id);
      const [ordered, held, , unused] = opened.variants;
      await Order.create({ user: cust._id, items: [{ product: id, variantId: ordered._id, quantity: 1, price: 500 }], fulfillmentMethod: 'pickup', subtotal: 500, total: 500, paymentMethod: 'razorpay' });
      await CheckoutSession.create({ user: cust._id, razorpayOrderId: 'order_hold', expiresAt: new Date(Date.now() + 60_000), stockReserved: true,
        items: [{ product: id, variantId: held._id, name: 'Royal Oud', price: 800, quantity: 1, weight: 0.1, subtotal: 800 }],
        fulfillmentMethod: 'pickup', breakdown: { grandTotal: 800 }, amountPaise: 80000, settingsVersion: 'test' });
      const without = (gone: any) => asLoaded(opened).filter((x: any) => x._id !== String(gone._id));
      for (const gone of [ordered, held]) {
        const r = await call('PUT', `/products/${id}`, { variants: without(gone) }, adminT);
        assert.deepStrictEqual([r.status, r.json.errors[0].code], [409, 'VARIANT_IN_USE']);
      }
      assert.strictEqual((await load(id)).variants.length, 4);
      assert.strictEqual((await call('PUT', `/products/${id}`, { variants: without(unused) }, adminT)).status, 200);
      const p = await load(id);
      assert.deepStrictEqual(p.variants.map((x: any) => String(x._id)), opened.variants.slice(0, 3).map((x: any) => String(x._id)));
      assert.strictEqual(p.stock, 18);
    });

    await test('a product in orders cannot be deleted; an unused one can', async () => {
      const r = await call('DELETE', `/products/${id}`, undefined, adminT);
      assert.deepStrictEqual([r.status, r.json.errors[0].code], [409, 'PRODUCT_IN_USE']);
      const spare = await Product.create({ name: 'Spare', category: 'Perfume', description: 'x', variants: [{ volume: '10ml', price: 100, offerPrice: 100, actualPrice: 100, stock: 1, weight: 0.01 }] });
      assert.strictEqual((await call('DELETE', `/products/${spare._id}`, undefined, adminT)).status, 200);
      assert.strictEqual((await call('DELETE', `/products/${id}`, undefined, custT)).status, 403);
    });

    await test('details-only update (no variants sent) leaves variants alone; parent stock cannot be set directly', async () => {
      const before = await load(id);
      assert.strictEqual((await call('PUT', `/products/${id}`, { offerText: 'FLAT 10% OFF', stock: 0 }, adminT)).status, 200);
      const p = await load(id);
      assert.deepStrictEqual([p.offerText, p.stock, p.variants], ['FLAT 10% OFF', before.stock, before.variants]);
    });
  } finally {
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
    server.close();
  }
  console.log(`=== Summary: ${passed} passed, 0 failed ===`);
};

run().catch(async (e) => { console.error('❌', e?.stack || e); process.exitCode = 1; await mongoose.disconnect().catch(() => undefined); process.exit(1); });
