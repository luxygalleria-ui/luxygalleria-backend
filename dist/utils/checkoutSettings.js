"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zoneOfState = exports.publicCheckoutSettings = exports.fulfilmentAvailable = exports.loadCheckoutSettings = exports.CheckoutSettingsError = exports.effectiveCheckoutSettings = exports.defaultCheckoutSettings = exports.legacyShippingConfig = exports.SECTIONS = exports.SECTION_SCHEMAS = exports.taxSchema = exports.chocolateSchema = exports.pickupSchema = exports.shippingSchema = void 0;
const zod_1 = require("zod");
const Settings_1 = require("../models/Settings");
const shippingCalculator_1 = require("./shippingCalculator");
/**
 * Checkout & fulfilment settings: shipping zones/methods, store pickup, chocolate (temperature-sensitive) shipping, tax display.
 * Stored on the single Settings document as four sections. A section that was never saved is derived from the
 * existing configuration, so current charges stay exactly as they are until an admin saves that section.
 * Writes are validated here (strict: unknown keys are refused). Reads fail loudly: no checkout runs on guessed rates.
 */
const money = zod_1.z.number().finite().min(0).max(1_000_000).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'At most 2 decimal places');
const text = (max) => zod_1.z.string().trim().max(max);
const rateSchema = zod_1.z.object({
    enabled: zod_1.z.boolean(),
    weightThresholdG: zod_1.z.number().finite().min(0).max(1_000_000),
    chargeBelow: money,
    chargeAtOrAbove: money,
    baseWeightKg: zod_1.z.number().finite().min(0).max(1000),
    extraPerKg: money,
    /** Order subtotal at or above which this method ships free. 0 = no free-shipping tier. */
    freeShippingThreshold: money,
    eta: text(120),
}).strict();
const zoneSchema = zod_1.z.object({
    /** Whether we deliver to this destination at all. */
    enabled: zod_1.z.boolean(),
    land: rateSchema,
    air: rateSchema,
    /** Customer-facing note, e.g. service limits. */
    note: text(300),
}).strict();
exports.shippingSchema = zod_1.z.object({
    zones: zod_1.z.object({ kerala: zoneSchema, outsideKerala: zoneSchema }).strict(),
}).strict();
exports.pickupSchema = zod_1.z.object({
    enabled: zod_1.z.boolean(),
    storeName: text(120),
    address: text(500),
    openingHours: text(300),
    phone: zod_1.z.string().trim().max(30).regex(/^[0-9+()\-\s]*$/, 'Digits, spaces, +, - and brackets only'),
    email: zod_1.z.union([zod_1.z.literal(''), zod_1.z.string().trim().email('Enter a valid email address').max(200)]),
    instructions: text(1000),
    readyTime: text(120),
    /** Charged on pickup orders only when greater than 0. */
    charge: money,
}).strict().superRefine((p, ctx) => {
    if (!p.enabled)
        return;
    for (const k of ['storeName', 'address', 'openingHours', 'phone']) {
        if (!p[k])
            ctx.addIssue({ code: zod_1.z.ZodIssueCode.custom, path: [k], message: 'Required while store pickup is enabled' });
    }
});
exports.chocolateSchema = zod_1.z.object({
    enabled: zod_1.z.boolean(),
    /** The business owner confirmed the fee below. The feature cannot be enabled without it. */
    rateConfirmed: zod_1.z.boolean(),
    basis: zod_1.z.enum(['per_weight_step', 'flat_per_order']),
    /** ₹ per started weight step (per_weight_step) or once per order (flat_per_order). */
    feeAmount: money,
    unitGrams: zod_1.z.number().int().min(1).max(100_000),
    allowedMethods: zod_1.z.object({ land: zod_1.z.boolean(), air: zod_1.z.boolean() }).strict(),
    allowedZones: zod_1.z.object({ kerala: zod_1.z.boolean(), outsideKerala: zod_1.z.boolean() }).strict(),
    /** Months (1-12) in which chocolate cannot be delivered (store pickup stays available). */
    blockedMonths: zod_1.z.array(zod_1.z.number().int().min(1).max(12)).max(12).refine((m) => new Set(m).size === m.length, 'Duplicate month'),
    customerNote: text(1000),
}).strict().superRefine((c, ctx) => {
    if (c.enabled && !c.rateConfirmed) {
        ctx.addIssue({ code: zod_1.z.ZodIssueCode.custom, path: ['rateConfirmed'], message: 'Confirm the fee with the business owner before enabling chocolate shipping' });
    }
});
exports.taxSchema = zod_1.z.object({
    /** Off: no tax lines are shown or added (current behaviour). */
    enabled: zod_1.z.boolean(),
    /** true: listed prices already include GST (tax is extracted, never added). false: GST is added at checkout. */
    pricesIncludeTax: zod_1.z.boolean(),
    /** Show "Inclusive of GST" / "+ GST" next to prices on the storefront. */
    showPriceLabel: zod_1.z.boolean(),
}).strict();
exports.SECTION_SCHEMAS = { shipping: exports.shippingSchema, pickup: exports.pickupSchema, chocolate: exports.chocolateSchema, tax: exports.taxSchema };
exports.SECTIONS = Object.keys(exports.SECTION_SCHEMAS);
/** Positive number or the fallback (same rule as the existing shipping config). */
const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};
/** The existing (pre-zone) shipping configuration: Settings document -> environment -> built-in defaults. */
const legacyShippingConfig = (doc, env = process.env) => {
    const d = shippingCalculator_1.DEFAULT_SHIPPING_CONFIG;
    const fromEnv = {
        WEIGHT_THRESHOLD_KG: num(env.WEIGHT_THRESHOLD_KG, d.WEIGHT_THRESHOLD_KG),
        SHIPPING_BELOW_THRESHOLD: num(env.SHIPPING_BELOW_THRESHOLD, d.SHIPPING_BELOW_THRESHOLD),
        SHIPPING_ABOVE_THRESHOLD: num(env.SHIPPING_ABOVE_THRESHOLD, d.SHIPPING_ABOVE_THRESHOLD),
        BASE_WEIGHT_KG: num(env.BASE_WEIGHT_KG, d.BASE_WEIGHT_KG),
        EXTRA_SHIPPING_PER_KG: num(env.EXTRA_SHIPPING_PER_KG, d.EXTRA_SHIPPING_PER_KG),
        FREE_SHIPPING_THRESHOLD: num(env.FREE_SHIPPING_THRESHOLD, d.FREE_SHIPPING_THRESHOLD),
        FALLBACK_ITEM_WEIGHT_KG: num(env.FALLBACK_ITEM_WEIGHT_KG, d.FALLBACK_ITEM_WEIGHT_KG),
    };
    if (!doc)
        return fromEnv;
    return {
        ...fromEnv,
        WEIGHT_THRESHOLD_KG: num(doc.shippingWeightThreshold, fromEnv.WEIGHT_THRESHOLD_KG * 1000) / 1000,
        SHIPPING_BELOW_THRESHOLD: num(doc.shippingBelow500g, fromEnv.SHIPPING_BELOW_THRESHOLD),
        SHIPPING_ABOVE_THRESHOLD: num(doc.shippingAbove500g, fromEnv.SHIPPING_ABOVE_THRESHOLD),
        FREE_SHIPPING_THRESHOLD: num(doc.freeShippingThreshold, fromEnv.FREE_SHIPPING_THRESHOLD),
    };
};
exports.legacyShippingConfig = legacyShippingConfig;
/** Defaults for never-saved sections. Road delivery everywhere at today's rates; nothing new switched on. */
const defaultCheckoutSettings = (legacy) => {
    const road = {
        enabled: true,
        weightThresholdG: Math.round(legacy.WEIGHT_THRESHOLD_KG * 1000),
        chargeBelow: legacy.SHIPPING_BELOW_THRESHOLD,
        chargeAtOrAbove: legacy.SHIPPING_ABOVE_THRESHOLD,
        baseWeightKg: legacy.BASE_WEIGHT_KG,
        extraPerKg: legacy.EXTRA_SHIPPING_PER_KG,
        freeShippingThreshold: legacy.FREE_SHIPPING_THRESHOLD,
        eta: '',
    };
    // Air: no confirmed rates exist, so it starts disabled with zero charges for the admin to fill in
    const air = { ...road, enabled: false, chargeBelow: 0, chargeAtOrAbove: 0, extraPerKg: 0, freeShippingThreshold: 0 };
    const zone = { enabled: true, land: road, air, note: '' };
    return {
        // Separate copies: editing one destination must never change the other
        shipping: { zones: { kerala: structuredClone(zone), outsideKerala: structuredClone(zone) } },
        pickup: { enabled: false, storeName: '', address: '', openingHours: '', phone: '', email: '', instructions: '', readyTime: '', charge: 0 },
        // ₹10 per 250 g is the owner's reference figure, NOT confirmed pricing: stored, editable, and inactive
        chocolate: {
            enabled: false, rateConfirmed: false, basis: 'per_weight_step', feeAmount: 10, unitGrams: 250,
            allowedMethods: { land: true, air: true }, allowedZones: { kerala: true, outsideKerala: true }, blockedMonths: [], customerNote: '',
        },
        tax: { enabled: false, pricesIncludeTax: true, showPriceLabel: true },
    };
};
exports.defaultCheckoutSettings = defaultCheckoutSettings;
/** Saved sections over defaults. A stored section that no longer validates is refused rather than half-applied. */
const effectiveCheckoutSettings = (doc, env = process.env) => {
    const legacy = (0, exports.legacyShippingConfig)(doc, env);
    const defaults = (0, exports.defaultCheckoutSettings)(legacy);
    const settings = { ...defaults };
    const saved = {};
    for (const section of exports.SECTIONS) {
        const stored = doc?.[section];
        saved[section] = stored != null;
        if (stored == null)
            continue;
        const parsed = exports.SECTION_SCHEMAS[section].safeParse(stored);
        if (!parsed.success)
            throw new CheckoutSettingsError(`Stored ${section} settings are invalid; re-save them in the admin`);
        settings[section] = parsed.data;
    }
    return { settings, saved, fallbackItemWeightKg: legacy.FALLBACK_ITEM_WEIGHT_KG };
};
exports.effectiveCheckoutSettings = effectiveCheckoutSettings;
class CheckoutSettingsError extends Error {
}
exports.CheckoutSettingsError = CheckoutSettingsError;
/** Current settings straight from the database (no cache: an admin save applies to the next checkout). Throws if unreadable. */
const loadCheckoutSettings = async () => {
    let doc;
    try {
        doc = await Settings_1.Settings.findOne().lean();
    }
    catch (err) {
        throw new CheckoutSettingsError(`Checkout settings could not be loaded: ${err?.message || err}`);
    }
    return (0, exports.effectiveCheckoutSettings)(doc);
};
exports.loadCheckoutSettings = loadCheckoutSettings;
/** At least one way to receive an order must stay available. */
const fulfilmentAvailable = (s) => s.pickup.enabled || ['kerala', 'outsideKerala'].some((z) => s.shipping.zones[z].enabled && (s.shipping.zones[z].land.enabled || s.shipping.zones[z].air.enabled));
exports.fulfilmentAvailable = fulfilmentAvailable;
/** What the storefront may see: what customers are charged and told, nothing internal. */
const publicCheckoutSettings = (s) => {
    const zone = (z) => ({
        enabled: z.enabled, note: z.note,
        methods: ['land', 'air'].filter((m) => z[m].enabled).map((m) => ({ method: m, eta: z[m].eta, freeShippingThreshold: z[m].freeShippingThreshold })),
    });
    return {
        shipping: { zones: { kerala: zone(s.shipping.zones.kerala), outsideKerala: zone(s.shipping.zones.outsideKerala) } },
        pickup: s.pickup.enabled
            ? { enabled: true, storeName: s.pickup.storeName, address: s.pickup.address, openingHours: s.pickup.openingHours, phone: s.pickup.phone, email: s.pickup.email, instructions: s.pickup.instructions, readyTime: s.pickup.readyTime, charge: s.pickup.charge, paymentOptions: ['pay_now'] }
            : { enabled: false },
        chocolate: s.chocolate.enabled
            ? { enabled: true, basis: s.chocolate.basis, feeAmount: s.chocolate.feeAmount, unitGrams: s.chocolate.unitGrams, allowedMethods: s.chocolate.allowedMethods, allowedZones: s.chocolate.allowedZones, blockedMonths: s.chocolate.blockedMonths, customerNote: s.chocolate.customerNote }
            : { enabled: false },
        tax: s.tax,
    };
};
exports.publicCheckoutSettings = publicCheckoutSettings;
/** Destination zone from the address state. Unknown/absent state -> null (caller decides). */
const zoneOfState = (state) => {
    if (typeof state !== 'string' || !state.trim())
        return null;
    return /^(kerala|kl)$/i.test(state.trim().replace(/\s+/g, ' ')) ? 'kerala' : 'outsideKerala';
};
exports.zoneOfState = zoneOfState;
//# sourceMappingURL=checkoutSettings.js.map