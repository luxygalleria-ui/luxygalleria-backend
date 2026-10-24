/**
 * Checkout & fulfilment: shipping zones and methods, store pickup, chocolate packaging, GST, settings APIs.
 * Part 1 is pure (no database). Part 2 runs the API against a throwaway local database in mock-payment mode.
 * Run: npx ts-node --transpile-only src/tests/checkout.test.ts
 */
import assert from 'assert';
import { AddressInfo } from 'net';

// Before the app (and dotenv) load: test database, mock payments, no history login, no mail
const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_checkout_test';
process.env.NODE_ENV = 'development';
process.env.HISTORY_READ_ENABLED = 'false';
process.env.SENDGRID_API_KEY = '';
delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET; // mock payment mode (development only)

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../app';
import { ENV } from '../config/env';
import { User } from '../models/User';
import { Product } from '../models/Product';
import { Banner } from '../models/Banner';
import Order from '../models/Order';
import { isMockPaymentMode } from '../controllers/paymentController';
import { DEFAULT_SHIPPING_CONFIG, calculateShippingPure } from '../utils/shippingCalculator';
import { CheckoutSettings, chocolateSchema, defaultCheckoutSettings, publicCheckoutSettings, zoneOfState } from '../utils/checkoutSettings';
import { CheckoutRuleError, PricedLine, priceOrder } from '../utils/orderPricing';

let passed = 0;
const test = async (name: string, fn: () => unknown | Promise<unknown>) => {
  await fn();
  passed++;
  console.log(`  ✅ ${name}`);
};
const rejects = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) { assert.ok(e instanceof CheckoutRuleError, String(e)); assert.strictEqual(e.code, code, e.message); return e; }
  assert.fail(`expected ${code}`);
};

/** Kerala road 40/80 at 500 g, outside Kerala road 60/120, air outside 150/250; air in Kerala off. */
const fixture = (): CheckoutSettings => {
  const s = structuredClone(defaultCheckoutSettings(DEFAULT_SHIPPING_CONFIG));
  s.shipping.zones.outsideKerala = {
    ...s.shipping.zones.outsideKerala,
    land: { ...s.shipping.zones.outsideKerala.land, chargeBelow: 60, chargeAtOrAbove: 120, eta: '4-7 days' },
    air: { ...s.shipping.zones.outsideKerala.land, enabled: true, chargeBelow: 150, chargeAtOrAbove: 250, extraPerKg: 50, eta: '1-2 days' },
  };
  s.pickup = { enabled: true, storeName: 'Luxy Galleria', address: 'MG Road, Kochi', openingHours: '10am-8pm', phone: '0484 000000', email: '', instructions: 'Bring the order ID', readyTime: 'Same day', charge: 0 };
  return s;
};
const withChocolate = (s: CheckoutSettings, over: Partial<CheckoutSettings['chocolate']> = {}) => {
  s.chocolate = { ...s.chocolate, enabled: true, rateConfirmed: true, ...over };
  return s;
};
const line = (over: Partial<PricedLine>): PricedLine => ({ product: 'p', variantId: 'v', name: 'Item', price: 300, weight: 0.2, quantity: 1, ...over });
const choc = (grams: number, over: Partial<PricedLine> = {}) => line({ name: 'Chocolate', price: 500, weight: grams / 1000, requiresSpecialPackaging: true, ...over });

const pure = async () => {
  console.log('Pricing (pure):');

  await test('legacy settings (nothing saved): quote equals the existing formula for every cart', () => {
    const s = defaultCheckoutSettings(DEFAULT_SHIPPING_CONFIG);
    for (const lines of [[line({})], [line({ weight: 0.5 })], [line({ weight: 1.6, quantity: 2 })], [line({ price: 99.5, weight: 0.12, quantity: 3 })]]) {
      const legacy = calculateShippingPure(lines);
      const q = priceOrder(lines, s, { fulfillment: 'delivery', state: 'Kerala' });
      assert.deepStrictEqual([q.shipping, q.grandTotal, q.baseShipping, q.extraWeightCharge], [legacy.shipping, legacy.grandTotal, legacy.baseShipping, legacy.extraWeightCharge]);
      assert.strictEqual(priceOrder(lines, s, { fulfillment: 'delivery', state: 'Tamil Nadu' }).grandTotal, legacy.grandTotal, 'same rates outside Kerala until configured');
    }
  });

  await test('1. Kerala standard delivery: road rate for Kerala', () => {
    const q = priceOrder([line({})], fixture(), { fulfillment: 'delivery', shippingMethod: 'land', state: ' kerala ' });
    assert.deepStrictEqual([q.zone, q.shippingMethod, q.shipping, q.grandTotal], ['kerala', 'land', 40, 340]);
  });

  await test('2. delivery outside Kerala: outside rate, weight threshold and free-shipping tier', () => {
    const s = fixture();
    assert.strictEqual(priceOrder([line({})], s, { fulfillment: 'delivery', state: 'Tamil Nadu' }).shipping, 60);
    assert.strictEqual(priceOrder([line({ weight: 0.6 })], s, { fulfillment: 'delivery', state: 'Karnataka' }).shipping, 120);
    s.shipping.zones.outsideKerala.land.freeShippingThreshold = 1000;
    const q = priceOrder([line({ price: 1000 })], s, { fulfillment: 'delivery', state: 'Delhi' });
    assert.deepStrictEqual([q.shipping, q.freeShippingApplied, q.grandTotal], [0, true, 1000]);
    assert.strictEqual(zoneOfState('KL'), 'kerala');
    assert.strictEqual(zoneOfState(''), null);
  });

  await test('3. air vs land: each method its own rate; a disabled method is refused, not substituted', () => {
    const s = fixture();
    const land = priceOrder([line({ weight: 1.5 })], s, { fulfillment: 'delivery', shippingMethod: 'land', state: 'Goa' });
    const air = priceOrder([line({ weight: 1.5 })], s, { fulfillment: 'delivery', shippingMethod: 'air', state: 'Goa' });
    assert.deepStrictEqual([land.shipping, air.shipping], [120 + 20, 250 + 50]);
    rejects(() => priceOrder([line({})], s, { fulfillment: 'delivery', shippingMethod: 'air', state: 'Kerala' }), 'OPTION_UNAVAILABLE');
    s.shipping.zones.outsideKerala.enabled = false;
    const e: any = rejects(() => priceOrder([line({})], s, { fulfillment: 'delivery', state: 'Goa' }), 'OPTION_UNAVAILABLE');
    assert.match(e.message, /do not deliver/);
    assert.ok(e.options.find((o: any) => o.fulfillment === 'pickup').allowed, 'options tell the customer pickup still works');
  });

  await test('5. store pickup: no delivery charge; an explicitly configured pickup charge applies', () => {
    const s = fixture();
    let q = priceOrder([line({ weight: 3 })], s, { fulfillment: 'pickup' });
    assert.deepStrictEqual([q.fulfillmentMethod, q.shipping, q.pickupFee, q.grandTotal, q.zone], ['pickup', 0, 0, 300, null]);
    assert.strictEqual(q.pickupDetails!.storeName, 'Luxy Galleria');
    s.pickup.charge = 25;
    q = priceOrder([line({})], s, { fulfillment: 'pickup' });
    assert.deepStrictEqual([q.shipping, q.pickupFee, q.grandTotal], [0, 25, 325]);
    s.pickup.enabled = false;
    rejects(() => priceOrder([line({})], s, { fulfillment: 'pickup' }), 'OPTION_UNAVAILABLE');
  });

  await test('6. normal + chocolate products: packaging fee on the chocolate weight only, shown separately', () => {
    const s = withChocolate(fixture());
    const q = priceOrder([line({ weight: 0.4 }), choc(250)], s, { fulfillment: 'delivery', state: 'Kerala' });
    assert.deepStrictEqual([q.specialPackagingFee, q.specialPackaging.weightG, q.shipping], [10, 250, 80]);
    assert.strictEqual(q.grandTotal, 300 + 500 + 80 + 10);
    const off = priceOrder([line({}), choc(250)], fixture(), { fulfillment: 'delivery', state: 'Kerala' });
    assert.strictEqual(off.specialPackagingFee, 0, 'feature disabled (default): no fee');
  });

  await test('7. chocolate increments: 250 g, 500 g, 260 g, several products charged once on combined weight', () => {
    const s = withChocolate(fixture());
    const fee = (lines: PricedLine[]) => priceOrder(lines, s, { fulfillment: 'delivery', state: 'Kerala' }).specialPackagingFee;
    assert.strictEqual(fee([choc(250)]), 10);
    assert.strictEqual(fee([choc(500)]), 20);
    assert.strictEqual(fee([choc(260)]), 20, 'every started step counts');
    assert.strictEqual(fee([choc(100), choc(100, { product: 'q' })]), 10, 'two 100 g bars: one 250 g step, not two fees');
    assert.strictEqual(fee([choc(250, { quantity: 3 })]), 30);
    rejects(() => fee([choc(0)]), 'WEIGHT_MISSING'); // no weight: not guessed as one step
    s.chocolate.unitGrams = 500; s.chocolate.feeAmount = 15;
    assert.strictEqual(fee([choc(750)]), 30);
    s.chocolate.basis = 'flat_per_order';
    assert.strictEqual(fee([choc(750), choc(250, { product: 'q' })]), 15, 'flat: once per order');
    assert.strictEqual(priceOrder([choc(500)], s, { fulfillment: 'pickup' }).specialPackagingFee, 0, 'pickup: no packaging fee');
  });

  await test('7b. unconfirmed chocolate rate cannot be enabled; unsupported methods, zones and months are refused', () => {
    const base = defaultCheckoutSettings(DEFAULT_SHIPPING_CONFIG).chocolate;
    assert.strictEqual(base.enabled, false, '₹10/250 g reference is stored but inactive');
    assert.strictEqual(chocolateSchema.safeParse({ ...base, enabled: true }).success, false);
    assert.strictEqual(chocolateSchema.safeParse({ ...base, enabled: true, rateConfirmed: true }).success, true);

    const s = withChocolate(fixture(), { allowedMethods: { land: false, air: true } });
    rejects(() => priceOrder([choc(250)], s, { fulfillment: 'delivery', shippingMethod: 'land', state: 'Goa' }), 'OPTION_UNAVAILABLE');
    assert.strictEqual(priceOrder([choc(250)], s, { fulfillment: 'delivery', state: 'Goa' }).shippingMethod, 'air', 'default picks the allowed method');
    assert.strictEqual(priceOrder([line({})], s, { fulfillment: 'delivery', shippingMethod: 'land', state: 'Goa' }).shipping, 60, 'restrictions only apply to carts with chocolate');
    s.chocolate.allowedZones.outsideKerala = false;
    rejects(() => priceOrder([choc(250)], s, { fulfillment: 'delivery', shippingMethod: 'air', state: 'Goa' }), 'OPTION_UNAVAILABLE');
    const may = new Date('2026-05-15T06:00:00Z');
    s.chocolate.blockedMonths = [4, 5];
    const blocked: any = rejects(() => priceOrder([choc(250)], withChocolate(fixture(), { blockedMonths: [5] }), { fulfillment: 'delivery', state: 'Kerala' }, { now: may }), 'OPTION_UNAVAILABLE');
    assert.match(blocked.message, /this month/);
    assert.strictEqual(priceOrder([choc(250)], withChocolate(fixture(), { blockedMonths: [5] }), { fulfillment: 'pickup' }, { now: may }).fulfillmentMethod, 'pickup');
  });

  await test('8. GST inclusive vs exclusive: never added twice; missing rates handled safely', () => {
    const s = fixture();
    s.tax = { enabled: true, pricesIncludeTax: true, showPriceLabel: true };
    let q = priceOrder([line({ price: 118, taxRate: 18 })], s, { fulfillment: 'pickup' });
    assert.deepStrictEqual([q.tax.taxAmount, q.tax.taxableValue, q.tax.addedToTotal, q.grandTotal], [18, 100, 0, 118]);
    s.tax.pricesIncludeTax = false;
    q = priceOrder([line({ price: 100, taxRate: 18 })], s, { fulfillment: 'pickup' });
    assert.deepStrictEqual([q.tax.taxAmount, q.tax.taxableValue, q.tax.addedToTotal, q.grandTotal], [18, 100, 18, 118]);
    q = priceOrder([line({ price: 100, taxRate: 5 }), line({ price: 100, taxRate: 18, product: 'q' })], s, { fulfillment: 'pickup' });
    assert.deepStrictEqual([q.tax.taxAmount, q.grandTotal], [23, 223], 'per-product rates, not one store-wide rate');
    rejects(() => priceOrder([line({ taxRate: null })], s, { fulfillment: 'pickup' }), 'TAX_RATE_MISSING');
    s.tax.pricesIncludeTax = true;
    q = priceOrder([line({ taxRate: null })], s, { fulfillment: 'pickup' });
    assert.deepStrictEqual([q.tax.taxAmount, q.tax.missingRates, q.grandTotal], [0, ['Item'], 300], 'inclusive: payable unchanged, rate flagged');
    q = priceOrder([line({ price: 118, taxRate: 18 })], fixture(), { fulfillment: 'pickup' });
    assert.deepStrictEqual([q.tax.enabled, q.tax.taxAmount, q.grandTotal], [false, 0, 118], 'tax off (default): today’s totals');
  });

  await test('9. discount, shipping, tax rounding and final amount are consistent', () => {
    const s = fixture();
    s.tax = { enabled: true, pricesIncludeTax: true, showPriceLabel: true };
    let q = priceOrder([line({ price: 1000, taxRate: 18 })], s, { fulfillment: 'delivery', state: 'Kerala', discount: 100 });
    assert.deepStrictEqual([q.discount, q.tax.taxAmount, q.tax.taxableValue, q.shipping, q.grandTotal], [100, 137.29, 762.71, 40, 940]);

    s.tax.pricesIncludeTax = false;
    const lines = [line({ price: 99.99, quantity: 3, taxRate: 5 }), line({ price: 49.5, taxRate: 12, product: 'q' }), line({ price: 0.35, quantity: 7, taxRate: 18, product: 'r' })];
    q = priceOrder(lines, s, { fulfillment: 'delivery', state: 'Goa', discount: 33.33 });
    const subtotal = 299.97 + 49.5 + 2.45;
    assert.strictEqual(q.subtotal, subtotal);
    assert.strictEqual(q.tax.taxableValue, Math.round((subtotal - 33.33) * 100) / 100, 'discount spread exactly, no cent lost');
    assert.strictEqual(q.tax.taxAmount, Math.round(q.tax.lines.reduce((a, l) => a + l.taxAmount, 0) * 100) / 100);
    assert.ok(q.tax.lines.every((l) => Math.round(l.taxAmount * 100) === l.taxAmount * 100), 'each line rounded to paise');
    assert.strictEqual(q.grandTotal, Math.round((q.subtotal - q.discount + q.tax.taxAmount + q.shipping + q.specialPackagingFee + q.pickupFee) * 100) / 100);
    assert.strictEqual(priceOrder([line({})], fixture(), { fulfillment: 'pickup', discount: 1e6 }).discount, 300, 'discount never exceeds the subtotal');
  });

  await test('required examples: ₹59 × 5 = ₹295, 50 g × 5 = 250 g, confirmed ₹10 / 250 g packaging charged exactly once', () => {
    const dairyMilk = (quantity: number, over: Partial<PricedLine> = {}) => line({ name: 'Dairy Milk 50g', price: 59, weight: 0.05, quantity, ...over });
    // Production today: chocolate shipping off, nothing flagged -> no packaging line; 250 g is at/above a 200 g threshold
    const prod = defaultCheckoutSettings({ ...DEFAULT_SHIPPING_CONFIG, WEIGHT_THRESHOLD_KG: 0.2 });
    let q = priceOrder([dairyMilk(5)], prod, { fulfillment: 'delivery', state: 'Kerala' });
    assert.deepStrictEqual([q.subtotal, q.totalWeight, q.specialPackagingFee, q.shipping, q.grandTotal], [295, 0.25, 0, 80, 375]);
    // Confirmed rule enabled and the product marked: one ₹10 step for the combined 250 g, not one per bar
    const s = withChocolate(fixture());
    q = priceOrder([dairyMilk(5, { requiresSpecialPackaging: true })], s, { fulfillment: 'delivery', state: 'Kerala' });
    assert.deepStrictEqual([q.subtotal, q.totalWeight, q.specialPackaging.weightG, q.specialPackaging.steps, q.specialPackagingFee], [295, 0.25, 250, 1, 10]);
    assert.strictEqual(q.grandTotal, 295 + q.shipping + 10, 'subtotal, shipping and packaging stay separate and add once');
    assert.strictEqual(priceOrder([dairyMilk(6, { requiresSpecialPackaging: true })], s, { fulfillment: 'delivery', state: 'Kerala' }).specialPackagingFee, 20, '300 g = 2 started steps');
    const mixed = priceOrder([dairyMilk(5, { requiresSpecialPackaging: true }), line({ name: 'Juice', price: 199, weight: 0.2, quantity: 2 })], s, { fulfillment: 'delivery', state: 'Kerala' });
    assert.deepStrictEqual([mixed.subtotal, mixed.totalWeight, mixed.specialPackagingFee], [295 + 398, 0.65, 10], 'juice adds weight for shipping, not packaging');
  });

  await test('missing weight: delivery refused with the product named (never guessed); pickup and an explicit fallback still work', () => {
    const s = fixture();
    const e: any = rejects(() => priceOrder([line({ name: 'Frooti', weight: 0 }), line({})], s, { fulfillment: 'delivery', state: 'Kerala' }), 'WEIGHT_MISSING');
    assert.match(e.message, /no weight is set for Frooti/);
    assert.ok(e.options.filter((o: any) => o.fulfillment === 'delivery').every((o: any) => !o.allowed), 'no delivery option offered');
    assert.strictEqual(priceOrder([line({ weight: 0 })], fixture(), {}).fulfillmentMethod, 'pickup', 'no choice made: the available option (pickup) is quoted');
    assert.strictEqual(priceOrder([line({ weight: 0 })], s, { fulfillment: 'pickup' }).grandTotal, 300);
    assert.strictEqual(priceOrder([line({ weight: 0 })], s, { fulfillment: 'delivery', state: 'Kerala' }, { fallbackItemWeightKg: 0.6 }).shipping, 80, 'FALLBACK_ITEM_WEIGHT_KG is an explicit setting');
    s.pickup.enabled = false;
    rejects(() => priceOrder([line({ weight: 0 })], s, {}), 'WEIGHT_MISSING');
  });

  await test('public settings: only customer-facing data', () => {
    const p: any = publicCheckoutSettings(withChocolate(fixture()));
    const text = JSON.stringify(p);
    assert.ok(!text.includes('rateConfirmed'), 'internal confirmation flag hidden');
    assert.deepStrictEqual(p.pickup.paymentOptions, ['pay_now']);
    assert.deepStrictEqual(publicCheckoutSettings(fixture()).chocolate, { enabled: false });
  });
};

const api = async () => {
  console.log('API (throwaway database, mock payments):');
  assert.ok(TEST_DB.includes('127.0.0.1') && TEST_DB.endsWith('_test'), 'refusing to run against a non-test database');
  // dotenv (loaded with the app) restores keys from .env: clear them now, and never reach Razorpay from this test
  delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET;
  assert.ok(isMockPaymentMode(), 'mock payment mode required: refusing to call the payment gateway');

  await mongoose.connect(TEST_DB);
  await mongoose.connection.db!.dropDatabase();
  await Order.init();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) as any };
  };

  try {
    const mk = (name: string, role: string) => User.create({ name, email: `${name.toLowerCase()}@test.local`, password: 'Passw0rd#123', role, isVerified: true });
    const [superadmin, admin, customer] = await Promise.all([mk('Super', 'superadmin'), mk('Admin', 'admin'), mk('Cust', 'customer')]);
    const tok = (u: any) => jwt.sign({ id: String(u._id), role: u.role }, ENV.JWT_SECRET, { expiresIn: '10m' });
    const [superT, adminT, custT] = [tok(superadmin), tok(admin), tok(customer)];

    const product = await Product.create({ name: 'Tea', category: 'Drinks', description: 'Tea', variants: [{ volume: '200g', price: 300, offerPrice: 300, actualPrice: 350, stock: 50, weight: 0.2 }], stock: 50 });
    const bar = await Product.create({ name: 'Dark Chocolate', category: 'Chocolate', description: 'Bar', variants: [{ volume: '250g', price: 500, offerPrice: 500, actualPrice: 550, stock: 50, weight: 0.25 }], stock: 50 });
    const item = (p: any, quantity = 1) => ({ product: String(p._id), variantId: String(p.variants[0]._id), quantity });
    const kerala = { street: '1 MG Road', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' };
    await Banner.create({ title: 'Hello', image: 'https://example.com/b.jpg', status: 'ACTIVE' });
    // An order from before this change: no fulfilment, packaging or tax fields
    const legacyOrder = await Order.collection.insertOne({
      user: customer._id, items: [{ product: product._id, variantId: product.variants[0]._id, quantity: 1, price: 300 }],
      shippingAddress: kerala, subtotal: 300, discount: 0, shippingFee: 40, total: 340, paymentMethod: 'razorpay', paymentStatus: 'completed', orderStatus: 'delivered', createdAt: new Date(), updatedAt: new Date(),
    });

    await test('12a. nothing saved yet: quote and payment use today’s rates (₹40 under 500 g)', async () => {
      const q = await call('POST', '/payments/calculate-shipping', { items: [item(product)], shippingAddress: kerala });
      assert.strictEqual(q.status, 200, JSON.stringify(q.json));
      assert.deepStrictEqual([q.json.data.shipping, q.json.data.grandTotal, q.json.data.fulfillmentMethod], [40, 340, 'delivery']);
      const s = await call('GET', '/settings/checkout', undefined, adminT);
      assert.deepStrictEqual(s.json.data.saved, { shipping: false, pickup: false, chocolate: false, tax: false });
    });

    await test('11. unauthorised users cannot read or change checkout settings; validation is strict', async () => {
      const ship = (await call('GET', '/settings/checkout', undefined, adminT)).json.data.settings.shipping;
      assert.strictEqual((await call('PUT', '/settings/checkout/shipping', ship)).status, 401);
      assert.strictEqual((await call('PUT', '/settings/checkout/shipping', ship, custT)).status, 403);
      assert.strictEqual((await call('GET', '/settings/checkout', undefined, custT)).status, 403);
      assert.strictEqual((await call('PUT', '/settings/checkout/products', { updates: [{ id: String(bar._id), requiresSpecialPackaging: true }] }, custT)).status, 403);
      assert.strictEqual((await call('PUT', '/settings/checkout/tax', { enabled: true, pricesIncludeTax: true, showPriceLabel: true }, adminT)).status, 403, 'tax: super admin only');
      assert.strictEqual((await call('PUT', '/settings/checkout/products', { updates: [{ id: String(bar._id), taxRate: 5 }] }, adminT)).status, 403, 'GST rates: super admin only');
      const bad = await call('PUT', '/settings/checkout/shipping', { zones: { ...ship.zones, kerala: { ...ship.zones.kerala, land: { ...ship.zones.kerala.land, chargeBelow: -5 } } } }, adminT);
      assert.strictEqual(bad.status, 400); assert.strictEqual(bad.json.errors[0].field, 'zones.kerala.land.chargeBelow');
      assert.strictEqual((await call('PUT', '/settings/checkout/shipping', { ...ship, injected: 1 }, adminT)).status, 400, 'unknown keys refused');
      const choc = (await call('GET', '/settings/checkout', undefined, adminT)).json.data.settings.chocolate;
      const unconfirmed = await call('PUT', '/settings/checkout/chocolate', { ...choc, enabled: true }, adminT);
      assert.strictEqual(unconfirmed.status, 400); assert.strictEqual(unconfirmed.json.errors[0].field, 'rateConfirmed');
      const none = structuredClone(ship); for (const z of ['kerala', 'outsideKerala']) none.zones[z].enabled = false;
      assert.strictEqual((await call('PUT', '/settings/checkout/shipping', none, adminT)).status, 400, 'cannot leave no way to receive orders');
      assert.strictEqual((await call('PUT', '/settings/checkout/nope', {}, adminT)).status, 404);
      const general = await call('PUT', '/settings', { whatsappNumber: '910000000000', shipping: { zones: {} } }, adminT);
      assert.strictEqual(general.status, 200);
      assert.strictEqual((await call('POST', '/payments/calculate-shipping', { items: [item(product)], shippingAddress: kerala })).json.data.shipping, 40, 'general PUT cannot write checkout sections');
    });

    await test('10. admin saves a setting and the very next checkout quote uses it', async () => {
      const ship = (await call('GET', '/settings/checkout', undefined, adminT)).json.data.settings.shipping;
      ship.zones.kerala.land.chargeBelow = 55;
      ship.zones.outsideKerala.air = { ...ship.zones.outsideKerala.land, enabled: true, chargeBelow: 150, chargeAtOrAbove: 250, eta: '1-2 days' };
      const saved = await call('PUT', '/settings/checkout/shipping', ship, adminT);
      assert.strictEqual(saved.status, 200, JSON.stringify(saved.json)); assert.strictEqual(saved.json.data.saved.shipping, true);
      const q = await call('POST', '/payments/calculate-shipping', { items: [item(product)], shippingAddress: kerala });
      assert.strictEqual(q.json.data.shipping, 55);
      const air = await call('POST', '/payments/calculate-shipping', { items: [item(product)], shippingAddress: { ...kerala, state: 'Goa' }, fulfillment: { method: 'delivery', shippingMethod: 'air' } });
      assert.strictEqual(air.json.data.shipping, 150);
      const refused = await call('POST', '/payments/calculate-shipping', { items: [item(product)], shippingAddress: kerala, fulfillment: { method: 'delivery', shippingMethod: 'air' } });
      assert.strictEqual(refused.status, 400); assert.strictEqual(refused.json.code, 'OPTION_UNAVAILABLE');
      const pub = await call('GET', '/settings');
      assert.deepStrictEqual(pub.json.data.checkout.shipping.zones.outsideKerala.methods.map((m: any) => m.method), ['land', 'air']);
      assert.ok(!('shipping' in pub.json.data) && !JSON.stringify(pub.json.data).includes('rateConfirmed'), 'public view only');
    });

    await test('4. store pickup with Pay Now: no address, no delivery fee, pickup details saved on the order', async () => {
      const pickup = { enabled: true, storeName: 'Luxy Galleria', address: 'MG Road, Kochi', openingHours: '10am-8pm', phone: '0484 000000', email: '', instructions: 'Bring the order ID', readyTime: 'Same day', charge: 0 };
      assert.strictEqual((await call('PUT', '/settings/checkout/pickup', { ...pickup, storeName: '' }, adminT)).status, 400, 'store details required when enabled');
      assert.strictEqual((await call('PUT', '/settings/checkout/pickup', pickup, adminT)).status, 200);
      const body = { items: [item(product, 2)], fulfillment: { method: 'pickup' } };
      const created = await call('POST', '/payments/create-order', { ...body, total: 600 }, custT);
      assert.strictEqual(created.status, 200, JSON.stringify(created.json)); assert.strictEqual(created.json.data.razorpayOrder.amount, 60000);
      assert.strictEqual((await call('POST', '/payments/create-order', { ...body, total: 655 }, custT)).status, 400, 'client total with a delivery fee is rejected');
      const verified = await call('POST', '/payments/verify', { ...body, razorpay_order_id: created.json.data.razorpayOrder.id, razorpay_payment_id: 'mock_payment', razorpay_signature: 'x' }, custT);
      assert.strictEqual(verified.status, 200, JSON.stringify(verified.json));
      const o = await Order.findById(verified.json.data._id).lean() as any;
      assert.deepStrictEqual([o.fulfillmentMethod, o.shippingFee, o.pickupFee, o.total, o.shippingAddress?.city], ['pickup', 0, 0, 600, undefined]);
      assert.strictEqual(o.pickupDetails.storeName, 'Luxy Galleria');
      assert.strictEqual((await call('POST', '/payments/create-order', { items: [item(product)], total: 340 }, custT)).status, 400, 'delivery still requires an address');
    });

    await test('6/7. chocolate in the cart: flag set from admin, fee from the server, method rules enforced', async () => {
      assert.strictEqual((await call('PUT', '/settings/checkout/products', { updates: [{ id: String(bar._id), requiresSpecialPackaging: true }] }, adminT)).status, 200);
      const choc = (await call('GET', '/settings/checkout', undefined, adminT)).json.data.settings.chocolate;
      const on = await call('PUT', '/settings/checkout/chocolate', { ...choc, enabled: true, rateConfirmed: true, allowedMethods: { land: true, air: false } }, adminT);
      assert.strictEqual(on.status, 200, JSON.stringify(on.json));
      const q = await call('POST', '/payments/calculate-shipping', { items: [item(product), item(bar, 2)], shippingAddress: kerala });
      assert.deepStrictEqual([q.json.data.specialPackagingFee, q.json.data.specialPackaging.weightG], [20, 500]);
      assert.strictEqual(q.json.data.grandTotal, 300 + 1000 + q.json.data.shipping + 20);
      const air = await call('POST', '/payments/calculate-shipping', { items: [item(bar)], shippingAddress: { ...kerala, state: 'Goa' }, fulfillment: { method: 'delivery', shippingMethod: 'air' } });
      assert.strictEqual(air.status, 400); assert.match(air.json.message, /cannot be sent by air/);
      const created = await call('POST', '/payments/create-order', { items: [item(bar)], shippingAddress: kerala, fulfillment: { method: 'delivery', shippingMethod: 'land' }, total: 500 + 55 }, custT);
      assert.strictEqual(created.status, 400, 'total without the packaging fee is rejected');
    });

    await test('8. GST: exclusive pricing blocked until every product has a rate; order records tax', async () => {
      const tax = { enabled: true, pricesIncludeTax: false, showPriceLabel: true };
      const blocked = await call('PUT', '/settings/checkout/tax', tax, superT);
      assert.strictEqual(blocked.status, 400); assert.match(blocked.json.message, /2 product\(s\) have none/);
      assert.strictEqual((await call('PUT', '/settings/checkout/products', { updates: [{ id: String(product._id), taxRate: 5, hsnCode: '0902' }, { id: String(bar._id), taxRate: 18 }] }, superT)).status, 200);
      assert.strictEqual((await call('PUT', '/settings/checkout/tax', tax, superT)).status, 200);
      assert.strictEqual((await call('PUT', '/settings/checkout/products', { updates: [{ id: String(bar._id), taxRate: null }] }, superT)).status, 400, 'cannot clear a rate while exclusive');
      const body = { items: [item(product)], fulfillment: { method: 'pickup' } };
      const created = await call('POST', '/payments/create-order', { ...body, total: 315 }, custT);
      assert.strictEqual(created.status, 200, JSON.stringify(created.json));
      const verified = await call('POST', '/payments/verify', { ...body, razorpay_order_id: created.json.data.razorpayOrder.id, razorpay_payment_id: 'mock_payment' }, custT);
      const o = await Order.findById(verified.json.data._id).lean() as any;
      assert.deepStrictEqual([o.total, o.tax.taxAmount, o.tax.addedToTotal, o.items[0].taxRate, o.items[0].taxAmount], [315, 15, 15, 5, 15]);
      assert.strictEqual((await call('PUT', '/settings/checkout/tax', { ...tax, pricesIncludeTax: true }, superT)).status, 200);
      const inc = await call('POST', '/payments/calculate-shipping', { items: [item(product)], fulfillment: { method: 'pickup' } });
      assert.deepStrictEqual([inc.json.data.grandTotal, inc.json.data.tax.taxAmount], [300, 14.29], 'inclusive: GST extracted, not added');
    });

    await test('10. quote, payment amount and saved order carry the same breakdown; bad quantities and prices refused', async () => {
      const milk = await Product.create({ name: 'Dairy Milk', category: 'Chocolates', description: 'Bar', requiresSpecialPackaging: true,
        variants: [{ volume: '50g', price: 59, offerPrice: 59, actualPrice: 65, stock: 50, weight: 0.05 }], stock: 50 });
      const body = { items: [item(milk, 5), item(product)], shippingAddress: kerala, fulfillment: { method: 'delivery', shippingMethod: 'land' } };
      const quote = (await call('POST', '/payments/calculate-shipping', body)).json.data;
      assert.deepStrictEqual([quote.subtotal, quote.totalWeight, quote.specialPackagingFee], [295 + 300, 0.45, 10]);
      const created = await call('POST', '/payments/create-order', { ...body, total: quote.grandTotal }, custT);
      assert.strictEqual(created.status, 200, JSON.stringify(created.json));
      assert.strictEqual(created.json.data.razorpayOrder.amount, Math.round(quote.grandTotal * 100), 'charged amount = quoted total');
      const verified = await call('POST', '/payments/verify', { ...body, razorpay_order_id: created.json.data.razorpayOrder.id, razorpay_payment_id: 'mock_payment' }, custT);
      const o = await Order.findById(verified.json.data._id).lean() as any;
      assert.deepStrictEqual([o.subtotal, o.shippingFee, o.specialPackagingFee, o.discount, o.total], [quote.subtotal, quote.shipping, quote.specialPackagingFee, quote.discount, quote.grandTotal]);
      assert.deepStrictEqual(o.items.map((i: any) => [i.price, i.quantity, i.subtotal]), [[59, 5, 295], [300, 1, 300]]);

      for (const quantity of [0, -1, 2.5, 101, '3']) {
        const r = await call('POST', '/payments/calculate-shipping', { items: [{ ...item(milk), quantity }], shippingAddress: kerala });
        assert.strictEqual(r.status, 400, `quantity ${quantity}`);
      }
      const free = await Product.create({ name: 'Unpriced', category: 'X', description: 'x', variants: [{ volume: '100g', price: 0, offerPrice: 0, actualPrice: 0, stock: 5, weight: 0.1 }] });
      const r = await call('POST', '/payments/calculate-shipping', { items: [item(free)], shippingAddress: kerala });
      assert.strictEqual(r.status, 400); assert.match(r.json.message, /no valid price/);
      const noWeight = await Product.create({ name: 'Frooti', category: 'Juices', description: 'x', variants: [{ volume: 'Standard', price: 123, offerPrice: 123, actualPrice: 123, stock: 5, weight: 0 }] });
      const nw = await call('POST', '/payments/calculate-shipping', { items: [item(noWeight)], shippingAddress: kerala, fulfillment: { method: 'delivery' } });
      assert.deepStrictEqual([nw.status, nw.json.code], [400, 'WEIGHT_MISSING']); assert.match(nw.json.message, /Frooti/);
      // Weight comes from the stored variant, not the size text the browser sends
      const sized = await call('POST', '/payments/calculate-shipping', { items: [{ ...item(product), size: '1g' }], shippingAddress: kerala });
      assert.strictEqual(sized.json.data.totalWeight, 0.2);
      await Product.deleteMany({ _id: { $in: [milk._id, free._id, noWeight._id] } });
    });

    await test('12b. existing order, products, banners, login and settings still work', async () => {
      const before = await Order.collection.findOne({ _id: legacyOrder.insertedId });
      const mine = await call('GET', '/payments/myorders', undefined, custT);
      const old = mine.json.data.find((o: any) => o._id === String(legacyOrder.insertedId));
      assert.deepStrictEqual([old.total, old.shippingFee, old.shippingAddress.city, old.fulfillmentMethod], [340, 40, 'Kochi', undefined], 'recorded amounts untouched, no new fields invented');
      assert.deepStrictEqual(await Order.collection.findOne({ _id: legacyOrder.insertedId }), before);
      assert.strictEqual((await call('GET', '/payments/admin/orders', undefined, adminT)).status, 200);
      assert.strictEqual((await call('GET', '/products')).status, 200);
      assert.strictEqual((await call('GET', '/banners')).status, 200);
      assert.strictEqual((await call('POST', '/auth/login', { email: 'super@test.local', password: 'Passw0rd#123' })).status, 200);
      const pub = await call('GET', '/settings');
      assert.strictEqual(pub.json.data.whatsappNumber, '910000000000');
    });
  } finally {
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
    server.close();
  }
};

(async () => {
  await pure();
  await api();
  console.log(`=== Summary: ${passed} passed, 0 failed ===`);
})().catch(async (e) => {
  console.error('❌', e?.stack || e);
  process.exitCode = 1;
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
