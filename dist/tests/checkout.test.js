"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Checkout & fulfilment: shipping zones and methods, store pickup, chocolate packaging, GST, settings APIs.
 * Part 1 is pure (no database). Part 2 runs the API against a throwaway local database in mock-payment mode.
 * Run: npx ts-node --transpile-only src/tests/checkout.test.ts
 */
const assert_1 = __importDefault(require("assert"));
// Before the app (and dotenv) load: test database, mock payments, no history login, no mail
const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_checkout_test';
process.env.NODE_ENV = 'development';
process.env.HISTORY_READ_ENABLED = 'false';
process.env.SENDGRID_API_KEY = '';
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET; // mock payment mode (development only)
const mongoose_1 = __importDefault(require("mongoose"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const app_1 = __importDefault(require("../app"));
const env_1 = require("../config/env");
const User_1 = require("../models/User");
const Product_1 = require("../models/Product");
const Banner_1 = require("../models/Banner");
const Order_1 = __importDefault(require("../models/Order"));
const crypto_1 = __importDefault(require("crypto"));
const paymentController_1 = require("../controllers/paymentController");
const shippingCalculator_1 = require("../utils/shippingCalculator");
const checkoutSettings_1 = require("../utils/checkoutSettings");
const orderPricing_1 = require("../utils/orderPricing");
let passed = 0;
const test = async (name, fn) => {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
};
const rejects = (fn, code) => {
    try {
        fn();
    }
    catch (e) {
        assert_1.default.ok(e instanceof orderPricing_1.CheckoutRuleError, String(e));
        assert_1.default.strictEqual(e.code, code, e.message);
        return e;
    }
    assert_1.default.fail(`expected ${code}`);
};
/** Kerala road 40/80 at 500 g, outside Kerala road 60/120, air outside 150/250; air in Kerala off. */
const fixture = () => {
    const s = structuredClone((0, checkoutSettings_1.defaultCheckoutSettings)(shippingCalculator_1.DEFAULT_SHIPPING_CONFIG));
    s.shipping.zones.outsideKerala = {
        ...s.shipping.zones.outsideKerala,
        land: { ...s.shipping.zones.outsideKerala.land, chargeBelow: 60, chargeAtOrAbove: 120, eta: '4-7 days' },
        air: { ...s.shipping.zones.outsideKerala.land, enabled: true, chargeBelow: 150, chargeAtOrAbove: 250, extraPerKg: 50, eta: '1-2 days' },
    };
    s.pickup = { enabled: true, storeName: 'Luxy Galleria', address: 'MG Road, Kochi', openingHours: '10am-8pm', phone: '0484 000000', email: '', instructions: 'Bring the order ID', readyTime: 'Same day', charge: 0 };
    return s;
};
const withChocolate = (s, over = {}) => {
    s.chocolate = { ...s.chocolate, enabled: true, rateConfirmed: true, ...over };
    return s;
};
const line = (over) => ({ product: 'p', variantId: 'v', name: 'Item', price: 300, weight: 0.2, quantity: 1, ...over });
const choc = (grams, over = {}) => line({ name: 'Chocolate', price: 500, weight: grams / 1000, requiresSpecialPackaging: true, ...over });
const pure = async () => {
    console.log('Pricing (pure):');
    await test('legacy settings (nothing saved): quote equals the existing formula for every cart', () => {
        const s = (0, checkoutSettings_1.defaultCheckoutSettings)(shippingCalculator_1.DEFAULT_SHIPPING_CONFIG);
        for (const lines of [[line({})], [line({ weight: 0.5 })], [line({ weight: 1.6, quantity: 2 })], [line({ price: 99.5, weight: 0.12, quantity: 3 })]]) {
            const legacy = (0, shippingCalculator_1.calculateShippingPure)(lines);
            const q = (0, orderPricing_1.priceOrder)(lines, s, { fulfillment: 'delivery', state: 'Kerala' });
            assert_1.default.deepStrictEqual([q.shipping, q.grandTotal, q.baseShipping, q.extraWeightCharge], [legacy.shipping, legacy.grandTotal, legacy.baseShipping, legacy.extraWeightCharge]);
            assert_1.default.strictEqual((0, orderPricing_1.priceOrder)(lines, s, { fulfillment: 'delivery', state: 'Tamil Nadu' }).grandTotal, legacy.grandTotal, 'same rates outside Kerala until configured');
        }
    });
    await test('1. Kerala standard delivery: road rate for Kerala', () => {
        const q = (0, orderPricing_1.priceOrder)([line({})], fixture(), { fulfillment: 'delivery', shippingMethod: 'land', state: ' kerala ' });
        assert_1.default.deepStrictEqual([q.zone, q.shippingMethod, q.shipping, q.grandTotal], ['kerala', 'land', 40, 340]);
    });
    await test('2. delivery outside Kerala: outside rate, weight threshold and free-shipping tier', () => {
        const s = fixture();
        assert_1.default.strictEqual((0, orderPricing_1.priceOrder)([line({})], s, { fulfillment: 'delivery', state: 'Tamil Nadu' }).shipping, 60);
        assert_1.default.strictEqual((0, orderPricing_1.priceOrder)([line({ weight: 0.6 })], s, { fulfillment: 'delivery', state: 'Karnataka' }).shipping, 120);
        s.shipping.zones.outsideKerala.land.freeShippingThreshold = 1000;
        const q = (0, orderPricing_1.priceOrder)([line({ price: 1000 })], s, { fulfillment: 'delivery', state: 'Delhi' });
        assert_1.default.deepStrictEqual([q.shipping, q.freeShippingApplied, q.grandTotal], [0, true, 1000]);
        assert_1.default.strictEqual((0, checkoutSettings_1.zoneOfState)('KL'), 'kerala');
        assert_1.default.strictEqual((0, checkoutSettings_1.zoneOfState)(''), null);
    });
    await test('3. air vs land: each method its own rate; a disabled method is refused, not substituted', () => {
        const s = fixture();
        const land = (0, orderPricing_1.priceOrder)([line({ weight: 1.5 })], s, { fulfillment: 'delivery', shippingMethod: 'land', state: 'Goa' });
        const air = (0, orderPricing_1.priceOrder)([line({ weight: 1.5 })], s, { fulfillment: 'delivery', shippingMethod: 'air', state: 'Goa' });
        assert_1.default.deepStrictEqual([land.shipping, air.shipping], [120 + 20, 250 + 50]);
        rejects(() => (0, orderPricing_1.priceOrder)([line({})], s, { fulfillment: 'delivery', shippingMethod: 'air', state: 'Kerala' }), 'OPTION_UNAVAILABLE');
        s.shipping.zones.outsideKerala.enabled = false;
        const e = rejects(() => (0, orderPricing_1.priceOrder)([line({})], s, { fulfillment: 'delivery', state: 'Goa' }), 'OPTION_UNAVAILABLE');
        assert_1.default.match(e.message, /do not deliver/);
        assert_1.default.ok(e.options.find((o) => o.fulfillment === 'pickup').allowed, 'options tell the customer pickup still works');
    });
    await test('5. store pickup: no delivery charge; an explicitly configured pickup charge applies', () => {
        const s = fixture();
        let q = (0, orderPricing_1.priceOrder)([line({ weight: 3 })], s, { fulfillment: 'pickup' });
        assert_1.default.deepStrictEqual([q.fulfillmentMethod, q.shipping, q.pickupFee, q.grandTotal, q.zone], ['pickup', 0, 0, 300, null]);
        assert_1.default.strictEqual(q.pickupDetails.storeName, 'Luxy Galleria');
        s.pickup.charge = 25;
        q = (0, orderPricing_1.priceOrder)([line({})], s, { fulfillment: 'pickup' });
        assert_1.default.deepStrictEqual([q.shipping, q.pickupFee, q.grandTotal], [0, 25, 325]);
        s.pickup.enabled = false;
        rejects(() => (0, orderPricing_1.priceOrder)([line({})], s, { fulfillment: 'pickup' }), 'OPTION_UNAVAILABLE');
    });
    await test('6. normal + chocolate products: packaging fee on the chocolate weight only, shown separately', () => {
        const s = withChocolate(fixture());
        const q = (0, orderPricing_1.priceOrder)([line({ weight: 0.4 }), choc(250)], s, { fulfillment: 'delivery', state: 'Kerala' });
        assert_1.default.deepStrictEqual([q.specialPackagingFee, q.specialPackaging.weightG, q.shipping], [10, 250, 80]);
        assert_1.default.strictEqual(q.grandTotal, 300 + 500 + 80 + 10);
        const off = (0, orderPricing_1.priceOrder)([line({}), choc(250)], fixture(), { fulfillment: 'delivery', state: 'Kerala' });
        assert_1.default.strictEqual(off.specialPackagingFee, 0, 'feature disabled (default): no fee');
    });
    await test('7. chocolate increments: 250 g, 500 g, 260 g, several products charged once on combined weight', () => {
        const s = withChocolate(fixture());
        const fee = (lines) => (0, orderPricing_1.priceOrder)(lines, s, { fulfillment: 'delivery', state: 'Kerala' }).specialPackagingFee;
        assert_1.default.strictEqual(fee([choc(250)]), 10);
        assert_1.default.strictEqual(fee([choc(500)]), 20);
        assert_1.default.strictEqual(fee([choc(260)]), 20, 'every started step counts');
        assert_1.default.strictEqual(fee([choc(100), choc(100, { product: 'q' })]), 10, 'two 100 g bars: one 250 g step, not two fees');
        assert_1.default.strictEqual(fee([choc(250, { quantity: 3 })]), 30);
        rejects(() => fee([choc(0)]), 'WEIGHT_MISSING'); // no weight: not guessed as one step
        s.chocolate.unitGrams = 500;
        s.chocolate.feeAmount = 15;
        assert_1.default.strictEqual(fee([choc(750)]), 30);
        s.chocolate.basis = 'flat_per_order';
        assert_1.default.strictEqual(fee([choc(750), choc(250, { product: 'q' })]), 15, 'flat: once per order');
        assert_1.default.strictEqual((0, orderPricing_1.priceOrder)([choc(500)], s, { fulfillment: 'pickup' }).specialPackagingFee, 0, 'pickup: no packaging fee');
    });
    await test('7b. unconfirmed chocolate rate cannot be enabled; unsupported methods, zones and months are refused', () => {
        const base = (0, checkoutSettings_1.defaultCheckoutSettings)(shippingCalculator_1.DEFAULT_SHIPPING_CONFIG).chocolate;
        assert_1.default.strictEqual(base.enabled, false, '₹10/250 g reference is stored but inactive');
        assert_1.default.strictEqual(checkoutSettings_1.chocolateSchema.safeParse({ ...base, enabled: true }).success, false);
        assert_1.default.strictEqual(checkoutSettings_1.chocolateSchema.safeParse({ ...base, enabled: true, rateConfirmed: true }).success, true);
        const s = withChocolate(fixture(), { allowedMethods: { land: false, air: true } });
        rejects(() => (0, orderPricing_1.priceOrder)([choc(250)], s, { fulfillment: 'delivery', shippingMethod: 'land', state: 'Goa' }), 'OPTION_UNAVAILABLE');
        assert_1.default.strictEqual((0, orderPricing_1.priceOrder)([choc(250)], s, { fulfillment: 'delivery', state: 'Goa' }).shippingMethod, 'air', 'default picks the allowed method');
        assert_1.default.strictEqual((0, orderPricing_1.priceOrder)([line({})], s, { fulfillment: 'delivery', shippingMethod: 'land', state: 'Goa' }).shipping, 60, 'restrictions only apply to carts with chocolate');
        s.chocolate.allowedZones.outsideKerala = false;
        rejects(() => (0, orderPricing_1.priceOrder)([choc(250)], s, { fulfillment: 'delivery', shippingMethod: 'air', state: 'Goa' }), 'OPTION_UNAVAILABLE');
        const may = new Date('2026-05-15T06:00:00Z');
        s.chocolate.blockedMonths = [4, 5];
        const blocked = rejects(() => (0, orderPricing_1.priceOrder)([choc(250)], withChocolate(fixture(), { blockedMonths: [5] }), { fulfillment: 'delivery', state: 'Kerala' }, { now: may }), 'OPTION_UNAVAILABLE');
        assert_1.default.match(blocked.message, /this month/);
        assert_1.default.strictEqual((0, orderPricing_1.priceOrder)([choc(250)], withChocolate(fixture(), { blockedMonths: [5] }), { fulfillment: 'pickup' }, { now: may }).fulfillmentMethod, 'pickup');
    });
    await test('8. GST inclusive vs exclusive: never added twice; missing rates handled safely', () => {
        const s = fixture();
        s.tax = { enabled: true, pricesIncludeTax: true, showPriceLabel: true };
        let q = (0, orderPricing_1.priceOrder)([line({ price: 118, taxRate: 18 })], s, { fulfillment: 'pickup' });
        assert_1.default.deepStrictEqual([q.tax.taxAmount, q.tax.taxableValue, q.tax.addedToTotal, q.grandTotal], [18, 100, 0, 118]);
        s.tax.pricesIncludeTax = false;
        q = (0, orderPricing_1.priceOrder)([line({ price: 100, taxRate: 18 })], s, { fulfillment: 'pickup' });
        assert_1.default.deepStrictEqual([q.tax.taxAmount, q.tax.taxableValue, q.tax.addedToTotal, q.grandTotal], [18, 100, 18, 118]);
        q = (0, orderPricing_1.priceOrder)([line({ price: 100, taxRate: 5 }), line({ price: 100, taxRate: 18, product: 'q' })], s, { fulfillment: 'pickup' });
        assert_1.default.deepStrictEqual([q.tax.taxAmount, q.grandTotal], [23, 223], 'per-product rates, not one store-wide rate');
        rejects(() => (0, orderPricing_1.priceOrder)([line({ taxRate: null })], s, { fulfillment: 'pickup' }), 'TAX_RATE_MISSING');
        s.tax.pricesIncludeTax = true;
        q = (0, orderPricing_1.priceOrder)([line({ taxRate: null })], s, { fulfillment: 'pickup' });
        assert_1.default.deepStrictEqual([q.tax.taxAmount, q.tax.missingRates, q.grandTotal], [0, ['Item'], 300], 'inclusive: payable unchanged, rate flagged');
        q = (0, orderPricing_1.priceOrder)([line({ price: 118, taxRate: 18 })], fixture(), { fulfillment: 'pickup' });
        assert_1.default.deepStrictEqual([q.tax.enabled, q.tax.taxAmount, q.grandTotal], [false, 0, 118], 'tax off (default): today’s totals');
    });
    await test('9. discount, shipping, tax rounding and final amount are consistent', () => {
        const s = fixture();
        s.tax = { enabled: true, pricesIncludeTax: true, showPriceLabel: true };
        let q = (0, orderPricing_1.priceOrder)([line({ price: 1000, taxRate: 18 })], s, { fulfillment: 'delivery', state: 'Kerala', discount: 100 });
        assert_1.default.deepStrictEqual([q.discount, q.tax.taxAmount, q.tax.taxableValue, q.shipping, q.grandTotal], [100, 137.29, 762.71, 40, 940]);
        s.tax.pricesIncludeTax = false;
        const lines = [line({ price: 99.99, quantity: 3, taxRate: 5 }), line({ price: 49.5, taxRate: 12, product: 'q' }), line({ price: 0.35, quantity: 7, taxRate: 18, product: 'r' })];
        q = (0, orderPricing_1.priceOrder)(lines, s, { fulfillment: 'delivery', state: 'Goa', discount: 33.33 });
        const subtotal = 299.97 + 49.5 + 2.45;
        assert_1.default.strictEqual(q.subtotal, subtotal);
        assert_1.default.strictEqual(q.tax.taxableValue, Math.round((subtotal - 33.33) * 100) / 100, 'discount spread exactly, no cent lost');
        assert_1.default.strictEqual(q.tax.taxAmount, Math.round(q.tax.lines.reduce((a, l) => a + l.taxAmount, 0) * 100) / 100);
        assert_1.default.ok(q.tax.lines.every((l) => Math.round(l.taxAmount * 100) === l.taxAmount * 100), 'each line rounded to paise');
        assert_1.default.strictEqual(q.grandTotal, Math.round((q.subtotal - q.discount + q.tax.taxAmount + q.shipping + q.specialPackagingFee + q.pickupFee) * 100) / 100);
        assert_1.default.strictEqual((0, orderPricing_1.priceOrder)([line({})], fixture(), { fulfillment: 'pickup', discount: 1e6 }).discount, 300, 'discount never exceeds the subtotal');
    });
    await test('required examples: ₹59 × 5 = ₹295, 50 g × 5 = 250 g, confirmed ₹10 / 250 g packaging charged exactly once', () => {
        const dairyMilk = (quantity, over = {}) => line({ name: 'Dairy Milk 50g', price: 59, weight: 0.05, quantity, ...over });
        // Production today: chocolate shipping off, nothing flagged -> no packaging line; 250 g is at/above a 200 g threshold
        const prod = (0, checkoutSettings_1.defaultCheckoutSettings)({ ...shippingCalculator_1.DEFAULT_SHIPPING_CONFIG, WEIGHT_THRESHOLD_KG: 0.2 });
        let q = (0, orderPricing_1.priceOrder)([dairyMilk(5)], prod, { fulfillment: 'delivery', state: 'Kerala' });
        assert_1.default.deepStrictEqual([q.subtotal, q.totalWeight, q.specialPackagingFee, q.shipping, q.grandTotal], [295, 0.25, 0, 80, 375]);
        // Confirmed rule enabled and the product marked: one ₹10 step for the combined 250 g, not one per bar
        const s = withChocolate(fixture());
        q = (0, orderPricing_1.priceOrder)([dairyMilk(5, { requiresSpecialPackaging: true })], s, { fulfillment: 'delivery', state: 'Kerala' });
        assert_1.default.deepStrictEqual([q.subtotal, q.totalWeight, q.specialPackaging.weightG, q.specialPackaging.steps, q.specialPackagingFee], [295, 0.25, 250, 1, 10]);
        assert_1.default.strictEqual(q.grandTotal, 295 + q.shipping + 10, 'subtotal, shipping and packaging stay separate and add once');
        assert_1.default.strictEqual((0, orderPricing_1.priceOrder)([dairyMilk(6, { requiresSpecialPackaging: true })], s, { fulfillment: 'delivery', state: 'Kerala' }).specialPackagingFee, 20, '300 g = 2 started steps');
        const mixed = (0, orderPricing_1.priceOrder)([dairyMilk(5, { requiresSpecialPackaging: true }), line({ name: 'Juice', price: 199, weight: 0.2, quantity: 2 })], s, { fulfillment: 'delivery', state: 'Kerala' });
        assert_1.default.deepStrictEqual([mixed.subtotal, mixed.totalWeight, mixed.specialPackagingFee], [295 + 398, 0.65, 10], 'juice adds weight for shipping, not packaging');
    });
    await test('missing weight: delivery refused with the product named (never guessed); pickup and an explicit fallback still work', () => {
        const s = fixture();
        const e = rejects(() => (0, orderPricing_1.priceOrder)([line({ name: 'Frooti', weight: 0 }), line({})], s, { fulfillment: 'delivery', state: 'Kerala' }), 'WEIGHT_MISSING');
        assert_1.default.match(e.message, /no weight is set for Frooti/);
        for (const bad of [-0.2, NaN, Infinity * 0])
            rejects(() => (0, orderPricing_1.priceOrder)([line({ weight: bad })], s, { fulfillment: 'delivery', state: 'Kerala' }), 'WEIGHT_MISSING');
        assert_1.default.ok(e.options.filter((o) => o.fulfillment === 'delivery').every((o) => !o.allowed), 'no delivery option offered');
        assert_1.default.strictEqual((0, orderPricing_1.priceOrder)([line({ weight: 0 })], fixture(), {}).fulfillmentMethod, 'pickup', 'no choice made: the available option (pickup) is quoted');
        assert_1.default.strictEqual((0, orderPricing_1.priceOrder)([line({ weight: 0 })], s, { fulfillment: 'pickup' }).grandTotal, 300);
        assert_1.default.strictEqual((0, orderPricing_1.priceOrder)([line({ weight: 0 })], s, { fulfillment: 'delivery', state: 'Kerala' }, { fallbackItemWeightKg: 0.6 }).shipping, 80, 'FALLBACK_ITEM_WEIGHT_KG is an explicit setting');
        s.pickup.enabled = false;
        rejects(() => (0, orderPricing_1.priceOrder)([line({ weight: 0 })], s, {}), 'WEIGHT_MISSING');
    });
    await test('production rules (200 g, ₹40/₹80, +₹20 per started kg over 1 kg): boundary and the reported ₹1,357 cart', () => {
        const prod = (0, checkoutSettings_1.defaultCheckoutSettings)({ ...shippingCalculator_1.DEFAULT_SHIPPING_CONFIG, WEIGHT_THRESHOLD_KG: 0.2 });
        const ship = (g) => (0, orderPricing_1.priceOrder)([line({ weight: g / 1000 })], prod, { fulfillment: 'delivery', state: 'Kerala' }).shipping;
        assert_1.default.deepStrictEqual([ship(199), ship(200), ship(1000), ship(1150), ship(2000), ship(2001)], [40, 80, 80, 100, 100, 120]);
        const q = (0, orderPricing_1.priceOrder)([line({ name: 'Dairy Milk', price: 59, weight: 0.05, quantity: 23 })], prod, { fulfillment: 'delivery', state: 'Kerala' });
        assert_1.default.deepStrictEqual([q.subtotal, q.totalWeight, q.baseShipping, q.extraWeightCharge, q.shipping, q.grandTotal], [1357, 1.15, 80, 20, 100, 1457]);
    });
    await test('reported local 400: Kerala on but Road and Air off, pickup off -> refused with reason; outside Kerala still priced', () => {
        const s = fixture();
        s.pickup.enabled = false;
        s.shipping.zones.kerala.land.enabled = false;
        const e = rejects(() => (0, orderPricing_1.priceOrder)([line({ price: 59, weight: 0.05, quantity: 23 })], s, { fulfillment: 'delivery', state: 'Kerala' }), 'NO_DELIVERY_METHOD');
        assert_1.default.strictEqual(e.message, 'No delivery method is currently available for Kerala. Please contact the store.');
        assert_1.default.ok(e.options.every((o) => !o.allowed), 'no option offered, so checkout stays disabled');
        assert_1.default.strictEqual((0, orderPricing_1.priceOrder)([line({ price: 59, weight: 0.05, quantity: 23 })], s, { fulfillment: 'delivery', state: 'Tamil Nadu' }).shipping, 140, '₹120 at/above threshold + ₹20 for the started kg over 1 kg');
    });
    await test('checkout chocolate info: shown and charged only for an enabled, confirmed rule and marked products', () => {
        const bar = (q = 5) => choc(50, { name: 'Dairy Milk', price: 59, quantity: q });
        const quote = (s, lines, sel = { fulfillment: 'delivery', state: 'Kerala' }) => (0, orderPricing_1.priceOrder)(lines, s, sel);
        // No chocolate in the cart
        let q = quote(withChocolate(fixture()), [line({})]);
        assert_1.default.deepStrictEqual([q.specialPackaging.items, q.specialPackagingFee], [[], 0]);
        // Feature disabled (default): marked products are not treated specially and nothing is charged or described
        q = quote(fixture(), [bar()]);
        assert_1.default.deepStrictEqual([q.specialPackaging.items, q.specialPackaging.rule, q.specialPackagingFee, q.specialPackaging.note], [[], null, 0, '']);
        // Stored as enabled but not confirmed (refused on save; guarded anyway): no fee, no rule
        const unconfirmed = withChocolate(fixture(), { rateConfirmed: false, customerNote: 'note' });
        q = quote(unconfirmed, [bar()]);
        assert_1.default.deepStrictEqual([q.specialPackaging.items, q.specialPackaging.rule, q.specialPackagingFee], [[], null, 0]);
        // Enabled + confirmed: eligible items, the saved rule, and the server-computed fee (250 g -> ₹10, 300 g -> ₹20)
        const on = withChocolate(fixture(), { customerNote: 'Packed to reduce heat exposure.' });
        q = quote(on, [bar(5), line({ name: 'Juice' })]);
        assert_1.default.deepStrictEqual([q.specialPackaging.items, q.specialPackaging.rule, q.specialPackaging.weightG, q.specialPackaging.steps, q.specialPackagingFee, q.specialPackaging.note], [['Dairy Milk'], { basis: 'per_weight_step', feeAmount: 10, unitGrams: 250 }, 250, 1, 10, 'Packed to reduce heat exposure.']);
        assert_1.default.strictEqual(quote(on, [bar(6)]).specialPackagingFee, 20);
        // Pickup: items still identified, no packaging charge
        q = quote(on, [bar(5)], { fulfillment: 'pickup' });
        assert_1.default.deepStrictEqual([q.specialPackaging.items, q.specialPackagingFee], [['Dairy Milk'], 0]);
        // Restricted destination and month: delivery refused with the reason; pickup allowed
        const restricted = withChocolate(fixture(), { allowedZones: { kerala: true, outsideKerala: false }, blockedMonths: [5] });
        assert_1.default.match(rejects(() => quote(restricted, [bar()], { fulfillment: 'delivery', state: 'Goa' }), 'OPTION_UNAVAILABLE').message, /cannot be delivered to this destination/);
        const may = new Date('2026-05-10T06:00:00Z');
        assert_1.default.match(rejects(() => (0, orderPricing_1.priceOrder)([bar()], restricted, { fulfillment: 'delivery', state: 'Kerala' }, { now: may }), 'OPTION_UNAVAILABLE').message, /this month/);
        assert_1.default.strictEqual((0, orderPricing_1.priceOrder)([bar()], restricted, { fulfillment: 'pickup' }, { now: may }).fulfillmentMethod, 'pickup');
    });
    await test('chocolate step boundaries: 249 / 250 / 251 g and several products combined', () => {
        const s = withChocolate(fixture());
        const fee = (lines) => (0, orderPricing_1.priceOrder)(lines, s, { fulfillment: 'delivery', state: 'Kerala' }).specialPackagingFee;
        assert_1.default.deepStrictEqual([fee([choc(249)]), fee([choc(250)]), fee([choc(251)])], [10, 10, 20]);
        assert_1.default.strictEqual(fee([choc(100, { product: 'a' }), choc(150, { product: 'b' }), choc(250, { product: 'c' })]), 20, '500 g over three products = 2 steps, charged once');
        assert_1.default.strictEqual(fee([choc(100, { product: 'a' }), choc(150, { product: 'b' }), choc(251, { product: 'c' })]), 30, '501 g = 3 steps');
        s.shipping.zones.kerala.land.freeShippingThreshold = 100; // free shipping does not remove the separate packaging fee
        const q = (0, orderPricing_1.priceOrder)([choc(250, { price: 500 })], s, { fulfillment: 'delivery', state: 'Kerala' });
        assert_1.default.deepStrictEqual([q.shipping, q.freeShippingApplied, q.specialPackagingFee, q.grandTotal], [0, true, 10, 510]);
    });
    await test('no delivery method for the destination: one clear message; pickup suggested only when it is available', () => {
        const s = fixture();
        s.shipping.zones.outsideKerala.land.enabled = false;
        s.shipping.zones.outsideKerala.air.enabled = false;
        let e = rejects(() => (0, orderPricing_1.priceOrder)([line({})], s, { fulfillment: 'delivery', state: 'Goa' }), 'NO_DELIVERY_METHOD');
        assert_1.default.strictEqual(e.message, 'No delivery method is currently available for addresses outside Kerala. Choose store pickup, or contact the store.');
        s.pickup.enabled = false;
        e = rejects(() => (0, orderPricing_1.priceOrder)([line({})], s, { fulfillment: 'delivery', state: 'Goa' }), 'NO_DELIVERY_METHOD');
        assert_1.default.match(e.message, /Please contact the store\.$/);
        assert_1.default.strictEqual((0, orderPricing_1.priceOrder)([line({})], s, { fulfillment: 'delivery', state: 'Kerala' }).shipping, 40, 'Kerala unaffected');
    });
    await test('public settings: only customer-facing data', () => {
        const p = (0, checkoutSettings_1.publicCheckoutSettings)(withChocolate(fixture()));
        const text = JSON.stringify(p);
        assert_1.default.ok(!text.includes('rateConfirmed'), 'internal confirmation flag hidden');
        assert_1.default.deepStrictEqual(p.pickup.paymentOptions, ['pay_now']);
        assert_1.default.deepStrictEqual((0, checkoutSettings_1.publicCheckoutSettings)(fixture()).chocolate, { enabled: false });
    });
};
const api = async () => {
    console.log('API (throwaway database, mock payments):');
    assert_1.default.ok(TEST_DB.includes('127.0.0.1') && TEST_DB.endsWith('_test'), 'refusing to run against a non-test database');
    // dotenv (loaded with the app) restores keys from .env: clear them now, and never reach Razorpay from this test
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    assert_1.default.ok((0, paymentController_1.isMockPaymentMode)(), 'mock payment mode required: refusing to call the payment gateway');
    await mongoose_1.default.connect(TEST_DB);
    await mongoose_1.default.connection.db.dropDatabase();
    await Order_1.default.init();
    const server = app_1.default.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const call = async (method, path, body, token) => {
        const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: r.status, json: await r.json().catch(() => null) };
    };
    try {
        const mk = (name, role) => User_1.User.create({ name, email: `${name.toLowerCase()}@test.local`, password: 'Passw0rd#123', role, isVerified: true });
        const [superadmin, admin, customer] = await Promise.all([mk('Super', 'superadmin'), mk('Admin', 'admin'), mk('Cust', 'customer')]);
        const tok = (u) => jsonwebtoken_1.default.sign({ id: String(u._id), role: u.role }, env_1.ENV.JWT_SECRET, { expiresIn: '10m' });
        const [superT, adminT, custT] = [tok(superadmin), tok(admin), tok(customer)];
        const product = await Product_1.Product.create({ name: 'Tea', category: 'Drinks', description: 'Tea', variants: [{ volume: '200g', price: 300, offerPrice: 300, actualPrice: 350, stock: 50, weight: 0.2 }], stock: 50 });
        const bar = await Product_1.Product.create({ name: 'Dark Chocolate', category: 'Chocolate', description: 'Bar', variants: [{ volume: '250g', price: 500, offerPrice: 500, actualPrice: 550, stock: 50, weight: 0.25 }], stock: 50 });
        const item = (p, quantity = 1) => ({ product: String(p._id), variantId: String(p.variants[0]._id), quantity });
        const kerala = { street: '1 MG Road', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' };
        await Banner_1.Banner.create({ title: 'Hello', image: 'https://example.com/b.jpg', status: 'ACTIVE' });
        // An order from before this change: no fulfilment, packaging or tax fields
        const legacyOrder = await Order_1.default.collection.insertOne({
            user: customer._id, items: [{ product: product._id, variantId: product.variants[0]._id, quantity: 1, price: 300 }],
            shippingAddress: kerala, subtotal: 300, discount: 0, shippingFee: 40, total: 340, paymentMethod: 'razorpay', paymentStatus: 'completed', orderStatus: 'delivered', createdAt: new Date(), updatedAt: new Date(),
        });
        await test('12a. nothing saved yet: quote and payment use today’s rates (₹40 under 500 g)', async () => {
            const q = await call('POST', '/payments/calculate-shipping', { items: [item(product)], shippingAddress: kerala });
            assert_1.default.strictEqual(q.status, 200, JSON.stringify(q.json));
            assert_1.default.deepStrictEqual([q.json.data.shipping, q.json.data.grandTotal, q.json.data.fulfillmentMethod], [40, 340, 'delivery']);
            const s = await call('GET', '/settings/checkout', undefined, adminT);
            assert_1.default.deepStrictEqual(s.json.data.saved, { shipping: false, pickup: false, chocolate: false, tax: false });
        });
        await test('tax settings API contract: default load, valid save, field-level refusals, GST off leaves totals alone', async () => {
            const loaded = (await call('GET', '/settings/checkout', undefined, superT)).json.data;
            assert_1.default.deepStrictEqual([loaded.settings.tax, loaded.saved.tax], [{ enabled: false, pricesIncludeTax: true, showPriceLabel: true }, false], 'documented default when nothing is saved');
            const before = (await call('POST', '/payments/calculate-shipping', { items: [item(product)], shippingAddress: kerala })).json.data;
            const off = await call('PUT', '/settings/checkout/tax', { enabled: false, pricesIncludeTax: true, showPriceLabel: false }, superT);
            assert_1.default.strictEqual(off.status, 200, JSON.stringify(off.json));
            assert_1.default.strictEqual(off.json.data.saved.tax, true);
            const bad = await call('PUT', '/settings/checkout/tax', { enabled: 'yes', pricesIncludeTax: true, showPriceLabel: true }, superT);
            assert_1.default.deepStrictEqual([bad.status, bad.json.errors[0].field], [400, 'enabled']);
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/tax', { enabled: false, pricesIncludeTax: true }, superT)).status, 400, 'missing field');
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/tax', { enabled: false, pricesIncludeTax: true, showPriceLabel: true, rate: 18 }, superT)).status, 400, 'unknown field (no store-wide rate)');
            const blocked = await call('PUT', '/settings/checkout/tax', { enabled: true, pricesIncludeTax: true, showPriceLabel: true }, superT);
            assert_1.default.deepStrictEqual([blocked.status, blocked.json.errors[0].field], [400, 'enabled']);
            assert_1.default.match(blocked.json.message, /confirmed rate on every product/);
            const hsn = await call('PUT', '/settings/checkout/products', { updates: [{ id: String(product._id), hsnCode: '12ab' }] }, superT);
            assert_1.default.deepStrictEqual([hsn.status, hsn.json.errors[0].field], [400, 'updates.0.hsnCode']);
            const after = (await call('POST', '/payments/calculate-shipping', { items: [item(product)], shippingAddress: kerala })).json.data;
            assert_1.default.deepStrictEqual([after.grandTotal, after.tax.enabled, after.tax.taxAmount], [before.grandTotal, false, 0], 'GST off: totals unchanged');
        });
        await test('11. unauthorised users cannot read or change checkout settings; validation is strict', async () => {
            const ship = (await call('GET', '/settings/checkout', undefined, adminT)).json.data.settings.shipping;
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/shipping', ship)).status, 401);
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/shipping', ship, custT)).status, 403);
            assert_1.default.strictEqual((await call('GET', '/settings/checkout', undefined, custT)).status, 403);
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/products', { updates: [{ id: String(bar._id), requiresSpecialPackaging: true }] }, custT)).status, 403);
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/tax', { enabled: true, pricesIncludeTax: true, showPriceLabel: true }, adminT)).status, 403, 'tax: super admin only');
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/products', { updates: [{ id: String(bar._id), taxRate: 5 }] }, adminT)).status, 403, 'GST rates: super admin only');
            const bad = await call('PUT', '/settings/checkout/shipping', { zones: { ...ship.zones, kerala: { ...ship.zones.kerala, land: { ...ship.zones.kerala.land, chargeBelow: -5 } } } }, adminT);
            assert_1.default.strictEqual(bad.status, 400);
            assert_1.default.strictEqual(bad.json.errors[0].field, 'zones.kerala.land.chargeBelow');
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/shipping', { ...ship, injected: 1 }, adminT)).status, 400, 'unknown keys refused');
            const choc = (await call('GET', '/settings/checkout', undefined, adminT)).json.data.settings.chocolate;
            const unconfirmed = await call('PUT', '/settings/checkout/chocolate', { ...choc, enabled: true }, adminT);
            assert_1.default.strictEqual(unconfirmed.status, 400);
            assert_1.default.strictEqual(unconfirmed.json.errors[0].field, 'rateConfirmed');
            const none = structuredClone(ship);
            for (const z of ['kerala', 'outsideKerala'])
                none.zones[z].enabled = false;
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/shipping', none, adminT)).status, 400, 'cannot leave no way to receive orders');
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/nope', {}, adminT)).status, 404);
            const noMethod = structuredClone(ship);
            noMethod.zones.kerala.land.enabled = false;
            noMethod.zones.kerala.air.enabled = false;
            const dead = await call('PUT', '/settings/checkout/shipping', noMethod, adminT);
            assert_1.default.strictEqual(dead.status, 400, 'Kerala "deliver here" with no method is refused');
            assert_1.default.strictEqual(dead.json.errors[0].field, 'zones.kerala.enabled');
            noMethod.zones.kerala.enabled = false;
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/shipping', noMethod, adminT)).status, 200, 'turning Kerala off explicitly is allowed');
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/shipping', ship, adminT)).status, 200, 'restored');
            const general = await call('PUT', '/settings', { whatsappNumber: '910000000000', shipping: { zones: {} } }, adminT);
            assert_1.default.strictEqual(general.status, 200);
            assert_1.default.strictEqual((await call('POST', '/payments/calculate-shipping', { items: [item(product)], shippingAddress: kerala })).json.data.shipping, 40, 'general PUT cannot write checkout sections');
        });
        await test('10. admin saves a setting and the very next checkout quote uses it', async () => {
            const ship = (await call('GET', '/settings/checkout', undefined, adminT)).json.data.settings.shipping;
            ship.zones.kerala.land.chargeBelow = 55;
            ship.zones.outsideKerala.air = { ...ship.zones.outsideKerala.land, enabled: true, chargeBelow: 150, chargeAtOrAbove: 250, eta: '1-2 days' };
            const saved = await call('PUT', '/settings/checkout/shipping', ship, adminT);
            assert_1.default.strictEqual(saved.status, 200, JSON.stringify(saved.json));
            assert_1.default.strictEqual(saved.json.data.saved.shipping, true);
            const q = await call('POST', '/payments/calculate-shipping', { items: [item(product)], shippingAddress: kerala });
            assert_1.default.strictEqual(q.json.data.shipping, 55);
            const air = await call('POST', '/payments/calculate-shipping', { items: [item(product)], shippingAddress: { ...kerala, state: 'Goa' }, fulfillment: { method: 'delivery', shippingMethod: 'air' } });
            assert_1.default.strictEqual(air.json.data.shipping, 150);
            const refused = await call('POST', '/payments/calculate-shipping', { items: [item(product)], shippingAddress: kerala, fulfillment: { method: 'delivery', shippingMethod: 'air' } });
            assert_1.default.strictEqual(refused.status, 400);
            assert_1.default.strictEqual(refused.json.code, 'OPTION_UNAVAILABLE');
            const pub = await call('GET', '/settings');
            assert_1.default.deepStrictEqual(pub.json.data.checkout.shipping.zones.outsideKerala.methods.map((m) => m.method), ['land', 'air']);
            assert_1.default.ok(!('shipping' in pub.json.data) && !JSON.stringify(pub.json.data).includes('rateConfirmed'), 'public view only');
        });
        await test('4. store pickup with Pay Now: no address, no delivery fee, pickup details saved on the order', async () => {
            const pickup = { enabled: true, storeName: 'Luxy Galleria', address: 'MG Road, Kochi', openingHours: '10am-8pm', phone: '0484 000000', email: '', instructions: 'Bring the order ID', readyTime: 'Same day', charge: 0 };
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/pickup', { ...pickup, storeName: '' }, adminT)).status, 400, 'store details required when enabled');
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/pickup', pickup, adminT)).status, 200);
            const body = { items: [item(product, 2)], fulfillment: { method: 'pickup' } };
            const created = await call('POST', '/payments/create-order', { ...body, total: 600 }, custT);
            assert_1.default.strictEqual(created.status, 200, JSON.stringify(created.json));
            assert_1.default.strictEqual(created.json.data.razorpayOrder.amount, 60000);
            assert_1.default.strictEqual((await call('POST', '/payments/create-order', { ...body, total: 655 }, custT)).status, 400, 'client total with a delivery fee is rejected');
            const verified = await call('POST', '/payments/verify', { ...body, razorpay_order_id: created.json.data.razorpayOrder.id, razorpay_payment_id: 'mock_payment', razorpay_signature: 'x' }, custT);
            assert_1.default.strictEqual(verified.status, 200, JSON.stringify(verified.json));
            const o = await Order_1.default.findById(verified.json.data._id).lean();
            assert_1.default.deepStrictEqual([o.fulfillmentMethod, o.shippingFee, o.pickupFee, o.total, o.shippingAddress?.city], ['pickup', 0, 0, 600, undefined]);
            assert_1.default.strictEqual(o.pickupDetails.storeName, 'Luxy Galleria');
            assert_1.default.strictEqual((await call('POST', '/payments/create-order', { items: [item(product)], total: 340 }, custT)).status, 400, 'delivery still requires an address');
        });
        await test('6/7. chocolate in the cart: flag set from admin, fee from the server, method rules enforced', async () => {
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/products', { updates: [{ id: String(bar._id), requiresSpecialPackaging: true }] }, adminT)).status, 200);
            const choc = (await call('GET', '/settings/checkout', undefined, adminT)).json.data.settings.chocolate;
            const on = await call('PUT', '/settings/checkout/chocolate', { ...choc, enabled: true, rateConfirmed: true, allowedMethods: { land: true, air: false } }, adminT);
            assert_1.default.strictEqual(on.status, 200, JSON.stringify(on.json));
            const q = await call('POST', '/payments/calculate-shipping', { items: [item(product), item(bar, 2)], shippingAddress: kerala });
            assert_1.default.deepStrictEqual([q.json.data.specialPackagingFee, q.json.data.specialPackaging.weightG], [20, 500]);
            assert_1.default.deepStrictEqual([q.json.data.specialPackaging.items, q.json.data.specialPackaging.rule], [['Dark Chocolate'], { basis: 'per_weight_step', feeAmount: 10, unitGrams: 250 }], 'API exposes eligible items and the saved rule');
            assert_1.default.strictEqual(q.json.data.grandTotal, 300 + 1000 + q.json.data.shipping + 20);
            const air = await call('POST', '/payments/calculate-shipping', { items: [item(bar)], shippingAddress: { ...kerala, state: 'Goa' }, fulfillment: { method: 'delivery', shippingMethod: 'air' } });
            assert_1.default.strictEqual(air.status, 400);
            assert_1.default.match(air.json.message, /cannot be sent by air/);
            const created = await call('POST', '/payments/create-order', { items: [item(bar)], shippingAddress: kerala, fulfillment: { method: 'delivery', shippingMethod: 'land' }, total: 500 + 55 }, custT);
            assert_1.default.strictEqual(created.status, 400, 'total without the packaging fee is rejected');
        });
        await test('8. GST: exclusive pricing blocked until every product has a rate; order records tax', async () => {
            const tax = { enabled: true, pricesIncludeTax: false, showPriceLabel: true };
            const blocked = await call('PUT', '/settings/checkout/tax', tax, superT);
            assert_1.default.strictEqual(blocked.status, 400);
            assert_1.default.match(blocked.json.message, /2 product\(s\) have none/);
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/products', { updates: [{ id: String(product._id), taxRate: 5, hsnCode: '0902' }, { id: String(bar._id), taxRate: 18 }] }, superT)).status, 200);
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/tax', tax, superT)).status, 200);
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/products', { updates: [{ id: String(bar._id), taxRate: null }] }, superT)).status, 400, 'cannot clear a rate while exclusive');
            const body = { items: [item(product)], fulfillment: { method: 'pickup' } };
            const created = await call('POST', '/payments/create-order', { ...body, total: 315 }, custT);
            assert_1.default.strictEqual(created.status, 200, JSON.stringify(created.json));
            const verified = await call('POST', '/payments/verify', { ...body, razorpay_order_id: created.json.data.razorpayOrder.id, razorpay_payment_id: 'mock_payment' }, custT);
            const o = await Order_1.default.findById(verified.json.data._id).lean();
            assert_1.default.deepStrictEqual([o.total, o.tax.taxAmount, o.tax.addedToTotal, o.items[0].taxRate, o.items[0].taxAmount], [315, 15, 15, 5, 15]);
            assert_1.default.strictEqual((await call('PUT', '/settings/checkout/tax', { ...tax, pricesIncludeTax: true }, superT)).status, 200);
            const inc = await call('POST', '/payments/calculate-shipping', { items: [item(product)], fulfillment: { method: 'pickup' } });
            assert_1.default.deepStrictEqual([inc.json.data.grandTotal, inc.json.data.tax.taxAmount], [300, 14.29], 'inclusive: GST extracted, not added');
        });
        await test('10. quote, payment amount and saved order carry the same breakdown; bad quantities and prices refused', async () => {
            const milk = await Product_1.Product.create({ name: 'Dairy Milk', category: 'Chocolates', description: 'Bar', requiresSpecialPackaging: true,
                variants: [{ volume: '50g', price: 59, offerPrice: 59, actualPrice: 65, stock: 50, weight: 0.05 }], stock: 50 });
            const body = { items: [item(milk, 5), item(product)], shippingAddress: kerala, fulfillment: { method: 'delivery', shippingMethod: 'land' } };
            const quote = (await call('POST', '/payments/calculate-shipping', body)).json.data;
            assert_1.default.deepStrictEqual([quote.subtotal, quote.totalWeight, quote.specialPackagingFee], [295 + 300, 0.45, 10]);
            const created = await call('POST', '/payments/create-order', { ...body, total: quote.grandTotal }, custT);
            assert_1.default.strictEqual(created.status, 200, JSON.stringify(created.json));
            assert_1.default.strictEqual(created.json.data.razorpayOrder.amount, Math.round(quote.grandTotal * 100), 'charged amount = quoted total');
            const verified = await call('POST', '/payments/verify', { ...body, razorpay_order_id: created.json.data.razorpayOrder.id, razorpay_payment_id: 'mock_payment' }, custT);
            const o = await Order_1.default.findById(verified.json.data._id).lean();
            assert_1.default.deepStrictEqual([o.subtotal, o.shippingFee, o.specialPackagingFee, o.discount, o.total], [quote.subtotal, quote.shipping, quote.specialPackagingFee, quote.discount, quote.grandTotal]);
            assert_1.default.deepStrictEqual(o.items.map((i) => [i.price, i.quantity, i.subtotal]), [[59, 5, 295], [300, 1, 300]]);
            for (const quantity of [0, -1, 2.5, 101, '3']) {
                const r = await call('POST', '/payments/calculate-shipping', { items: [{ ...item(milk), quantity }], shippingAddress: kerala });
                assert_1.default.strictEqual(r.status, 400, `quantity ${quantity}`);
            }
            const free = await Product_1.Product.create({ name: 'Unpriced', category: 'X', description: 'x', variants: [{ volume: '100g', price: 0, offerPrice: 0, actualPrice: 0, stock: 5, weight: 0.1 }] });
            const r = await call('POST', '/payments/calculate-shipping', { items: [item(free)], shippingAddress: kerala });
            assert_1.default.strictEqual(r.status, 400);
            assert_1.default.match(r.json.message, /no valid price/);
            const noWeight = await Product_1.Product.create({ name: 'Frooti', category: 'Juices', description: 'x', variants: [{ volume: 'Standard', price: 123, offerPrice: 123, actualPrice: 123, stock: 5, weight: 0 }] });
            const nw = await call('POST', '/payments/calculate-shipping', { items: [item(noWeight)], shippingAddress: kerala, fulfillment: { method: 'delivery' } });
            assert_1.default.deepStrictEqual([nw.status, nw.json.code], [400, 'WEIGHT_MISSING']);
            assert_1.default.match(nw.json.message, /Frooti/);
            // Weight comes from the stored variant, not the size text the browser sends
            const sized = await call('POST', '/payments/calculate-shipping', { items: [{ ...item(product), size: '1g' }], shippingAddress: kerala });
            assert_1.default.strictEqual(sized.json.data.totalWeight, 0.2);
            await Product_1.Product.deleteMany({ _id: { $in: [milk._id, free._id, noWeight._id] } });
        });
        await test('payment integrity (Razorpay stubbed, no network): exact amounts, failures, retry, duplicates, destination', async () => {
            // Fake keys + stubbed client: real-gateway code paths run, nothing leaves this machine
            const SECRET = 'test_secret_checkout';
            process.env.RAZORPAY_KEY_ID = 'rzp_test_unit_checkout';
            process.env.RAZORPAY_KEY_SECRET = SECRET;
            const realCreate = paymentController_1.razorpayInstance.orders.create, realFetch = paymentController_1.razorpayInstance.payments.fetch;
            let n = 0;
            const created = [];
            const payments = {};
            paymentController_1.razorpayInstance.orders.create = async (o) => { const ord = { id: `order_t${++n}`, amount: o.amount, currency: o.currency }; created.push(ord); return ord; };
            paymentController_1.razorpayInstance.payments.fetch = async (id) => { if (!payments[id])
                throw new Error('unexpected live call'); return payments[id]; };
            const sign = (o, p) => crypto_1.default.createHmac('sha256', SECRET).update(`${o}|${p}`).digest('hex');
            try {
                assert_1.default.ok(!(0, paymentController_1.isMockPaymentMode)(), 'real-gateway path under test');
                const body = { items: [item(product, 2)], shippingAddress: kerala, fulfillment: { method: 'delivery', shippingMethod: 'land' } };
                const quote = (await call('POST', '/payments/calculate-shipping', body)).json.data;
                const paise = Math.round(quote.grandTotal * 100);
                // 12. tampered client totals never reach the gateway
                for (const total of [quote.grandTotal - 1, quote.grandTotal + 0.5, 1, 0]) {
                    assert_1.default.strictEqual((await call('POST', '/payments/create-order', { ...body, total }, custT)).status, 400, `total ${total}`);
                }
                assert_1.default.strictEqual(created.length, 0);
                const c1 = await call('POST', '/payments/create-order', { ...body, total: quote.grandTotal }, custT);
                assert_1.default.strictEqual(c1.status, 200);
                assert_1.default.strictEqual(created[0].amount, paise, 'gateway amount = server total in paise');
                const ord = c1.json.data.razorpayOrder.id;
                const verify = (pay, extra = {}) => call('POST', '/payments/verify', { ...body, razorpay_order_id: ord, razorpay_payment_id: pay, razorpay_signature: sign(ord, pay), ...extra }, custT);
                const ordersBefore = await Order_1.default.countDocuments();
                // 14. failed payment, wrong amounts and a bad signature create no order
                payments.pay_failed = { order_id: ord, status: 'failed', amount: paise, currency: 'INR' };
                payments.pay_over = { order_id: ord, status: 'captured', amount: paise + 100, currency: 'INR' };
                payments.pay_under = { order_id: ord, status: 'captured', amount: paise - 1, currency: 'INR' };
                for (const p of ['pay_failed', 'pay_over', 'pay_under'])
                    assert_1.default.strictEqual((await verify(p)).status, 400, p);
                payments.pay_ok = { order_id: ord, status: 'captured', amount: paise, currency: 'INR' };
                assert_1.default.strictEqual((await verify('pay_ok', { razorpay_signature: 'deadbeef' })).status, 400, 'bad signature');
                assert_1.default.strictEqual(await Order_1.default.countDocuments(), ordersBefore, 'no order from any failed attempt');
                // Retry with the exact amount succeeds and persists the server breakdown
                const ok = await verify('pay_ok');
                assert_1.default.strictEqual(ok.status, 200, JSON.stringify(ok.json));
                const o = await Order_1.default.findById(ok.json.data._id).lean();
                assert_1.default.deepStrictEqual([o.total, o.subtotal, o.shippingFee, o.paymentStatus, o.razorpayPaymentId], [quote.grandTotal, quote.subtotal, quote.shipping, 'completed', 'pay_ok']);
                // Duplicate submission: same order back, never a second one; another customer replaying it is refused
                const again = await verify('pay_ok');
                assert_1.default.deepStrictEqual([again.status, again.json.data._id], [200, ok.json.data._id]);
                assert_1.default.strictEqual(await Order_1.default.countDocuments({ razorpayOrderId: ord }), 1);
                const other = await User_1.User.create({ name: 'Other', email: 'other@test.local', password: 'Passw0rd#123', role: 'customer', isVerified: true });
                const replay = await call('POST', '/payments/verify', { ...body, razorpay_order_id: ord, razorpay_payment_id: 'pay_ok', razorpay_signature: sign(ord, 'pay_ok') }, jsonwebtoken_1.default.sign({ id: String(other._id), role: 'customer' }, env_1.ENV.JWT_SECRET, { expiresIn: '5m' }));
                assert_1.default.strictEqual(replay.status, 409);
                // 13. destination outside India: no domestic rate is applied
                const abroad = { ...body, shippingAddress: { ...kerala, state: 'California', country: 'USA' } };
                const q = await call('POST', '/payments/calculate-shipping', abroad);
                assert_1.default.strictEqual(q.status, 400);
                assert_1.default.match(q.json.message, /within India only/);
                assert_1.default.strictEqual((await call('POST', '/payments/create-order', { ...abroad, total: quote.grandTotal }, custT)).status, 400);
                assert_1.default.strictEqual((await call('POST', '/payments/calculate-shipping', { ...body, shippingAddress: { ...kerala, country: 'india' } })).status, 200);
                await User_1.User.deleteOne({ _id: other._id });
            }
            finally {
                paymentController_1.razorpayInstance.orders.create = realCreate;
                paymentController_1.razorpayInstance.payments.fetch = realFetch;
                delete process.env.RAZORPAY_KEY_ID;
                delete process.env.RAZORPAY_KEY_SECRET;
            }
        });
        await test('addresses: country spellings normalised, blank country not treated as foreign, incomplete addresses refused', async () => {
            const q = (address) => call('POST', '/payments/calculate-shipping', { items: [item(product)], shippingAddress: address, fulfillment: { method: 'delivery' } });
            for (const country of [undefined, '', '   ', 'India', ' india ', 'IN', 'Bharat', 'Republic of India']) {
                const r = await q({ ...kerala, country });
                assert_1.default.strictEqual(r.status, 200, `country ${JSON.stringify(country)}: ${JSON.stringify(r.json)}`);
            }
            for (const country of ['USA', 'Indonesia', 'Sri Lanka']) {
                const r = await q({ ...kerala, country });
                assert_1.default.strictEqual(r.status, 400, country);
                assert_1.default.match(r.json.message, /within India only/);
            }
            const total = (await q(kerala)).json.data.grandTotal;
            for (const missing of ['state', 'zipCode', 'city']) {
                const r = await call('POST', '/payments/create-order', { items: [item(product)], fulfillment: { method: 'delivery' }, shippingAddress: { ...kerala, [missing]: '' }, total }, custT);
                assert_1.default.strictEqual(r.status, 400, `missing ${missing}`);
                assert_1.default.match(r.json.message, /shipping address/);
            }
            assert_1.default.strictEqual((await call('POST', '/payments/create-order', { items: [item(product)], fulfillment: { method: 'delivery' }, total }, custT)).status, 400, 'no address at all');
        });
        await test('GST cannot be enabled (either mode) while any product lacks a confirmed rate', async () => {
            const t = (await call('GET', '/settings/checkout', undefined, adminT)).json.data.settings.tax;
            const unrated = await Product_1.Product.create({ name: 'Unrated', category: 'X', description: 'x', variants: [{ volume: '100g', price: 10, offerPrice: 10, actualPrice: 10, stock: 1, weight: 0.1 }] });
            for (const pricesIncludeTax of [true, false]) {
                const r = await call('PUT', '/settings/checkout/tax', { ...t, enabled: true, pricesIncludeTax }, superT);
                assert_1.default.strictEqual(r.status, 400, `inclusive=${pricesIncludeTax}`);
                assert_1.default.match(r.json.message, /have none/);
            }
            await Product_1.Product.deleteOne({ _id: unrated._id });
        });
        await test('12b. existing order, products, banners, login and settings still work', async () => {
            const before = await Order_1.default.collection.findOne({ _id: legacyOrder.insertedId });
            const mine = await call('GET', '/payments/myorders', undefined, custT);
            const old = mine.json.data.find((o) => o._id === String(legacyOrder.insertedId));
            assert_1.default.deepStrictEqual([old.total, old.shippingFee, old.shippingAddress.city, old.fulfillmentMethod], [340, 40, 'Kochi', undefined], 'recorded amounts untouched, no new fields invented');
            assert_1.default.deepStrictEqual(await Order_1.default.collection.findOne({ _id: legacyOrder.insertedId }), before);
            assert_1.default.strictEqual((await call('GET', '/payments/admin/orders', undefined, adminT)).status, 200);
            assert_1.default.strictEqual((await call('GET', '/products')).status, 200);
            assert_1.default.strictEqual((await call('GET', '/banners')).status, 200);
            assert_1.default.strictEqual((await call('POST', '/auth/login', { email: 'super@test.local', password: 'Passw0rd#123' })).status, 200);
            const pub = await call('GET', '/settings');
            assert_1.default.strictEqual(pub.json.data.whatsappNumber, '910000000000');
        });
    }
    finally {
        await mongoose_1.default.connection.db.dropDatabase();
        await mongoose_1.default.disconnect();
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
    await mongoose_1.default.disconnect().catch(() => undefined);
    process.exit(1);
});
//# sourceMappingURL=checkout.test.js.map