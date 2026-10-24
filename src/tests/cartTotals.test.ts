/**
 * Cart totals as the storefront shows them, from the server quote: unit price × quantity, variant weight × quantity,
 * the weight-threshold shipping rule, free shipping, unknown address, tampered client values, and shipping/tax
 * charged once per order. Uses the reported cart: one 50 g bar at ₹59, quantity 10.
 * Needs a local MongoDB; uses (and drops) a throwaway database. Mock payments only (never calls Razorpay).
 * Run: npx ts-node --transpile-only src/tests/cartTotals.test.ts
 */
import assert from 'assert';
import { AddressInfo } from 'net';

const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_cart_totals_test';
process.env.NODE_ENV = 'development';
process.env.HISTORY_READ_ENABLED = 'false';
process.env.SENDGRID_API_KEY = '';

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../app';
import { ENV } from '../config/env';
import { User } from '../models/User';
import { Product } from '../models/Product';
import { Settings } from '../models/Settings';
import { isMockPaymentMode } from '../controllers/paymentController';
import { defaultCheckoutSettings, legacyShippingConfig } from '../utils/checkoutSettings';

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  passed++;
  console.log(`  ✅ ${name}`);
};

const run = async () => {
  assert.ok(TEST_DB.includes('127.0.0.1') && TEST_DB.endsWith('_test'), 'refusing to run against a non-test database');
  // dotenv (loaded with the app) may restore real keys from .env: clear them so no payment provider can be reached
  delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET;
  assert.ok(isMockPaymentMode(), 'mock payment mode required');
  await mongoose.connect(TEST_DB);
  await mongoose.connection.db!.dropDatabase();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) as any };
  };

  try {
    // The store's current rule (legacy settings): under 500 g ₹40, at or above 500 g ₹80, +₹20 per started kg over 1 kg
    await Settings.create({ shippingWeightThreshold: 500, shippingBelow500g: 40, shippingAbove500g: 80, freeShippingThreshold: 0 });
    const bar = await Product.create({
      name: 'Diary Milk', category: 'Chocolate', description: 'Bar', weight: 0.05, stock: 97, requiresSpecialPackaging: true,
      variants: [{ volume: '50g', price: 59, offerPrice: 59, actualPrice: 70, stock: 97, weight: 0.05 }],
    });
    // Parent weight differs from the variant on purpose: the variant's own weight must win
    const tea = await Product.create({
      name: 'Tea', category: 'Drinks', description: 'Tea', weight: 5, stock: 50,
      variants: [{ volume: '100g', price: 19.99, offerPrice: 19.99, actualPrice: 25, stock: 50, weight: 0.1 }],
    });
    const item = (p: any, quantity: number, extra: object = {}) => ({ product: String(p._id), variantId: String(p.variants[0]._id), quantity, ...extra });
    const quote = async (items: object[], extra: object = {}) => {
      const r = await call('POST', '/payments/calculate-shipping', { items, ...extra });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      return r.json.data;
    };
    const user = await User.create({ name: 'Cust', email: 'cust@test.local', password: 'Passw0rd#123', role: 'customer', isVerified: true });
    const T = jwt.sign({ id: String(user._id), role: user.role }, ENV.JWT_SECRET, { expiresIn: '10m' });

    await test('reported cart: ₹59 × 10 = ₹590; 50 g × 10 = 0.50 kg; shipping ₹80 (at the 500 g threshold); total ₹670', async () => {
      const d = await quote([item(bar, 10, { size: '50g' })]);
      assert.deepStrictEqual(d.lines.map((l: any) => [l.price, l.quantity, l.weight]), [[59, 10, 0.05]]);
      assert.deepStrictEqual([d.subtotal, d.totalWeight, d.baseShipping, d.extraWeightCharge, d.shipping, d.specialPackagingFee, d.grandTotal], [590, 0.5, 80, 0, 80, 0, 670]);
      assert.strictEqual(d.grandTotal, d.subtotal + d.shipping, 'total = subtotal + shipping (no packaging/tax while disabled)');
    });

    await test('quantity changes move subtotal, weight and the shipping band together', async () => {
      const rows = [] as number[][];
      for (const q of [1, 9, 10, 11, 20]) { const d = await quote([item(bar, q)]); rows.push([q, d.subtotal, d.totalWeight, d.shipping, d.grandTotal]); }
      assert.deepStrictEqual(rows, [
        [1, 59, 0.05, 40, 99],
        [9, 531, 0.45, 40, 571], // 450 g: below the threshold
        [10, 590, 0.5, 80, 670], // exactly 500 g: "at or above" pays the higher band
        [11, 649, 0.55, 80, 729],
        [20, 1180, 1, 80, 1260], // 1 kg is included in the base charge
      ]);
      const d = await quote([item(bar, 21)]); // 1.05 kg: one started kg over 1 kg
      assert.deepStrictEqual([d.baseShipping, d.extraWeightCharge, d.shipping], [80, 20, 100]);
    });

    await test('variant weight is used (not the parent product weight); paise-safe sums', async () => {
      const d = await quote([item(tea, 3)]);
      assert.deepStrictEqual([d.totalWeight, d.subtotal], [0.3, 59.97], 'parent weight 5 kg ignored; 19.99 × 3 = 59.97 exactly');
    });

    await test('destination: Kerala, outside Kerala and an unknown address are all priced; unknown is marked as assumed', async () => {
      const k = await quote([item(bar, 10)], { shippingAddress: { state: 'Kerala' } });
      const o = await quote([item(bar, 10)], { shippingAddress: { state: 'Tamil Nadu' } });
      const u = await quote([item(bar, 10)]);
      assert.deepStrictEqual([k.zone, k.zoneAssumed, k.shipping], ['kerala', false, 80]);
      assert.deepStrictEqual([o.zone, o.zoneAssumed, o.shipping], ['outsideKerala', false, 80], 'same rates until outside-Kerala rates are configured');
      assert.deepStrictEqual([u.zoneAssumed, u.shipping], [true, 80], 'cart estimate without an address');
    });

    await test('free shipping applies at the configured order value, per destination', async () => {
      const s = defaultCheckoutSettings(legacyShippingConfig(await Settings.findOne().lean()));
      s.shipping.zones.kerala.land.freeShippingThreshold = 590;
      await Settings.updateOne({}, { $set: { shipping: s.shipping } });
      const at = await quote([item(bar, 10)], { shippingAddress: { state: 'Kerala' } });
      const below = await quote([item(bar, 9)], { shippingAddress: { state: 'Kerala' } });
      const outside = await quote([item(bar, 10)], { shippingAddress: { state: 'Goa' } });
      assert.deepStrictEqual([at.shipping, at.freeShippingApplied, at.grandTotal], [0, true, 590]);
      assert.deepStrictEqual([below.shipping, below.freeShippingApplied], [40, false]);
      assert.deepStrictEqual([outside.shipping, outside.freeShippingApplied], [80, false], 'threshold only set for Kerala');
      await Settings.updateOne({}, { $unset: { shipping: 1 } });
    });

    await test('tampered client prices, fees and totals are ignored or refused', async () => {
      const d = await quote([item(bar, 10, { price: 1, subtotal: 10 })], { total: 1, shippingFee: 0, subtotal: 10 });
      assert.deepStrictEqual([d.subtotal, d.shipping, d.grandTotal], [590, 80, 670]);
      const addr = { street: '1 Rd', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' };
      const cheap = await call('POST', '/payments/create-order', { items: [item(bar, 10, { price: 1 })], total: 10, shippingAddress: addr }, T);
      assert.strictEqual(cheap.status, 400); assert.match(cheap.json.message, /Server calculated total of 670/);
      const ok = await call('POST', '/payments/create-order', { items: [item(bar, 10, { price: 1 })], total: 670, shippingAddress: addr }, T);
      assert.strictEqual(ok.status, 200); assert.strictEqual(ok.json.data.isMock, true); assert.strictEqual(ok.json.data.razorpayOrder.amount, 67000, 'charged amount is the server total');
    });

    await test('shipping is charged once per order on the combined weight, never per line', async () => {
      const d = await quote([item(bar, 5), item(tea, 3)]); // 250 g + 300 g = 550 g
      assert.deepStrictEqual([d.totalWeight, d.shipping, d.subtotal, d.grandTotal], [0.55, 80, 354.97, 434.97]);
      const split = await quote([item(bar, 5), item(bar, 5)]); // same variant on two lines: 500 g together
      assert.deepStrictEqual([split.totalWeight, split.shipping, split.grandTotal], [0.5, 80, 670]);
    });

    await test('GST: inclusive prices are not taxed again; exclusive adds each product’s own rate once', async () => {
      await Product.updateOne({ _id: bar._id }, { $set: { taxRate: 18 } });
      await Product.updateOne({ _id: tea._id }, { $set: { taxRate: 5 } });
      await Settings.updateOne({}, { $set: { tax: { enabled: true, pricesIncludeTax: true, showPriceLabel: true } } });
      const inc = await quote([item(bar, 10)]);
      assert.deepStrictEqual([inc.tax.taxAmount, inc.tax.addedToTotal, inc.grandTotal], [90, 0, 670], '590 includes ₹90 GST; payable unchanged');
      await Settings.updateOne({}, { $set: { tax: { enabled: true, pricesIncludeTax: false, showPriceLabel: true } } });
      const exc = await quote([item(bar, 10), item(tea, 3)]);
      assert.deepStrictEqual([exc.tax.taxAmount, exc.tax.addedToTotal], [109.2, 109.2], '590 × 18% + 59.97 × 5% = 106.20 + 3.00');
      assert.strictEqual(exc.grandTotal, Math.round((exc.subtotal + exc.tax.addedToTotal + exc.shipping) * 100) / 100, 'tax added once, shipping once');
      await Settings.updateOne({}, { $unset: { tax: 1 } });
    });

    await test('chocolate packaging stays off while the feature is disabled, even for a flagged product', async () => {
      await Settings.updateOne({}, { $set: { chocolate: { enabled: false, rateConfirmed: false, basis: 'per_weight_step', feeAmount: 10, unitGrams: 250, allowedMethods: { land: true, air: true }, allowedZones: { kerala: false, outsideKerala: true }, blockedMonths: [], customerNote: '' } } });
      const d = await quote([item(bar, 10)], { shippingAddress: { state: 'Kerala' } });
      assert.deepStrictEqual([d.specialPackagingFee, d.grandTotal], [0, 670], 'disabled: no fee and no Kerala restriction');
    });
  } finally {
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
    server.close();
  }
  console.log(`=== Summary: ${passed} passed, 0 failed ===`);
};

run().catch(async (e) => {
  console.error('❌', e?.stack || e);
  process.exitCode = 1;
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
