"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.priceOrder = exports.specialPackagingFee = exports.computeTax = exports.checkoutOptions = exports.round2 = exports.CheckoutRuleError = void 0;
const shippingCalculator_1 = require("./shippingCalculator");
const checkoutSettings_1 = require("./checkoutSettings");
/** A customer choice that the settings do not allow: a 400, never a silent substitute. */
class CheckoutRuleError extends Error {
    code;
    options;
    constructor(message, code, options) {
        super(message);
        this.code = code;
        this.options = options;
    }
}
exports.CheckoutRuleError = CheckoutRuleError;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
exports.round2 = round2;
const METHOD_NAME = { land: 'road', air: 'air' };
const rateConfig = (r, fallbackItemWeightKg) => ({
    WEIGHT_THRESHOLD_KG: r.weightThresholdG / 1000,
    SHIPPING_BELOW_THRESHOLD: r.chargeBelow,
    SHIPPING_ABOVE_THRESHOLD: r.chargeAtOrAbove,
    BASE_WEIGHT_KG: r.baseWeightKg,
    EXTRA_SHIPPING_PER_KG: r.extraPerKg,
    FREE_SHIPPING_THRESHOLD: r.freeShippingThreshold,
    FALLBACK_ITEM_WEIGHT_KG: fallbackItemWeightKg,
});
/** Month 1-12 in the store's time zone. */
const monthInIndia = (now) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', month: 'numeric' }).format(now));
const specialLines = (lines, s) => (s.chocolate.enabled ? lines.filter((l) => l.requiresSpecialPackaging) : []);
/** Every way this cart could be received, with the reason when one is not allowed. */
const checkoutOptions = (lines, s, zone, now = new Date()) => {
    const special = specialLines(lines, s).length > 0;
    const blockedMonth = special && s.chocolate.blockedMonths.includes(monthInIndia(now));
    const z = s.shipping.zones[zone];
    const delivery = ['land', 'air'].map((m) => {
        const offered = z.enabled && z[m].enabled;
        let reason = '';
        if (!z.enabled)
            reason = 'We do not deliver to this destination yet';
        else if (!z[m].enabled)
            reason = `${METHOD_NAME[m] === 'air' ? 'Air' : 'Road'} shipping is not available for this destination`;
        else if (blockedMonth)
            reason = 'Temperature-sensitive items cannot be delivered this month; choose store pickup';
        else if (special && !s.chocolate.allowedZones[zone])
            reason = 'Temperature-sensitive items cannot be delivered to this destination';
        else if (special && !s.chocolate.allowedMethods[m])
            reason = `Temperature-sensitive items cannot be sent by ${METHOD_NAME[m]}`;
        return { fulfillment: 'delivery', shippingMethod: m, offered, allowed: !reason, reason, eta: z[m].eta };
    });
    const pickup = {
        fulfillment: 'pickup', shippingMethod: null, offered: s.pickup.enabled, allowed: s.pickup.enabled,
        reason: s.pickup.enabled ? '' : 'Store pickup is not available', eta: s.pickup.readyTime,
    };
    return [...delivery, pickup];
};
exports.checkoutOptions = checkoutOptions;
/** GST per line. Discount is spread over lines by value before tax. Inclusive prices never get GST added on top. */
const computeTax = (lines, discount, t) => {
    const totals = lines.map((l) => (0, exports.round2)(l.price * l.quantity));
    const subtotal = (0, exports.round2)(totals.reduce((a, b) => a + b, 0));
    if (!t.enabled) {
        return { enabled: false, pricesIncludeTax: t.pricesIncludeTax, taxableValue: (0, exports.round2)(subtotal - discount), taxAmount: 0, addedToTotal: 0, lines: [], missingRates: [] };
    }
    let allocated = 0;
    const missingRates = [];
    const out = lines.map((l, i) => {
        const share = i === lines.length - 1 ? (0, exports.round2)(discount - allocated) : subtotal ? (0, exports.round2)((discount * totals[i]) / subtotal) : 0;
        allocated = (0, exports.round2)(allocated + share);
        const net = (0, exports.round2)(totals[i] - share);
        const rate = typeof l.taxRate === 'number' && Number.isFinite(l.taxRate) ? l.taxRate : null;
        if (rate === null) {
            // Exclusive pricing cannot charge a correct total without the rate: refuse rather than under/over-charge
            if (!t.pricesIncludeTax)
                throw new CheckoutRuleError(`GST rate is not set for "${l.name}". Please contact the store.`, 'TAX_RATE_MISSING');
            missingRates.push(l.name);
            return { product: l.product, variantId: l.variantId, rate: null, taxableValue: net, taxAmount: 0 };
        }
        const taxAmount = t.pricesIncludeTax ? (0, exports.round2)((net * rate) / (100 + rate)) : (0, exports.round2)((net * rate) / 100);
        return { product: l.product, variantId: l.variantId, rate, taxableValue: t.pricesIncludeTax ? (0, exports.round2)(net - taxAmount) : net, taxAmount };
    });
    const taxAmount = (0, exports.round2)(out.reduce((a, x) => a + x.taxAmount, 0));
    return {
        enabled: true,
        pricesIncludeTax: t.pricesIncludeTax,
        taxableValue: (0, exports.round2)(out.reduce((a, x) => a + x.taxableValue, 0)),
        taxAmount,
        addedToTotal: t.pricesIncludeTax ? 0 : taxAmount,
        lines: out,
        missingRates,
    };
};
exports.computeTax = computeTax;
/** Weight used for a line: its stored weight, else the explicitly configured fallback (FALLBACK_ITEM_WEIGHT_KG), else none. */
const lineWeightKg = (l, fallbackKg) => (Number(l.weight) > 0 ? Number(l.weight) : fallbackKg);
/** Chocolate packaging: charged once per order on the combined weight of all such items, never per product. */
const specialPackagingFee = (lines, s, fallbackKg = 0) => {
    const special = specialLines(lines, s);
    if (!special.length)
        return { applied: false, weightG: 0, steps: 0, fee: 0 };
    const weightG = Math.round(special.reduce((a, l) => a + lineWeightKg(l, fallbackKg) * l.quantity * 1000, 0));
    if (s.chocolate.basis === 'flat_per_order')
        return { applied: true, weightG, steps: 1, fee: s.chocolate.feeAmount };
    // Every started step counts (250 g -> 1, 260 g -> 2). Lines without a weight never reach here for delivery (see priceOrder).
    const steps = Math.ceil(weightG / s.chocolate.unitGrams);
    return { applied: true, weightG, steps, fee: (0, exports.round2)(steps * s.chocolate.feeAmount) };
};
exports.specialPackagingFee = specialPackagingFee;
const priceOrder = (lines, s, sel = {}, opts = {}) => {
    const knownZone = (0, checkoutSettings_1.zoneOfState)(sel.state);
    const zone = knownZone ?? 'kerala';
    const fallbackKg = opts.fallbackItemWeightKg ?? 0;
    const options = (0, exports.checkoutOptions)(lines, s, zone, opts.now);
    // Delivery is priced by weight: without a weight for every item there is no correct charge, so delivery is not offered
    // (store pickup still is). Never assume a weight unless FALLBACK_ITEM_WEIGHT_KG is explicitly configured.
    const noWeight = lines.filter((l) => !(lineWeightKg(l, fallbackKg) > 0)).map((l) => l.name);
    const weightReason = noWeight.length
        ? `Delivery charge cannot be calculated: no weight is set for ${[...new Set(noWeight)].join(', ')}. Choose store pickup or contact the store.`
        : '';
    if (weightReason) {
        for (const o of options)
            if (o.fulfillment === 'delivery' && o.allowed) {
                o.allowed = false;
                o.reason = weightReason;
            }
    }
    // Explicit choice must be allowed; otherwise the first allowed delivery method, then pickup
    let chosen;
    if (sel.fulfillment === 'pickup')
        chosen = options.find((o) => o.fulfillment === 'pickup');
    else if (sel.fulfillment === 'delivery' && sel.shippingMethod)
        chosen = options.find((o) => o.shippingMethod === sel.shippingMethod);
    // No allowed method: report the most relevant reason (an offered method's, else the destination's)
    else if (sel.fulfillment === 'delivery')
        chosen = options.find((o) => o.fulfillment === 'delivery' && o.allowed) ?? options.find((o) => o.fulfillment === 'delivery' && o.offered) ?? options[0];
    else
        chosen = options.find((o) => o.allowed);
    if (!chosen) {
        throw new CheckoutRuleError(weightReason || 'No delivery or pickup option is available for this order', weightReason ? 'WEIGHT_MISSING' : 'NO_OPTION', options);
    }
    if (!chosen.allowed) {
        throw new CheckoutRuleError(chosen.reason || 'This option is not available', chosen.reason === weightReason && weightReason ? 'WEIGHT_MISSING' : 'OPTION_UNAVAILABLE', options);
    }
    const subtotal = (0, exports.round2)(lines.reduce((a, l) => a + l.price * l.quantity, 0));
    const discount = (0, exports.round2)(Math.min(Math.max(Number(sel.discount) || 0, 0), subtotal));
    const isPickup = chosen.fulfillment === 'pickup';
    const ship = isPickup
        ? { totalWeight: (0, shippingCalculator_1.calculateShippingPure)(lines).totalWeight, baseShipping: 0, extraWeightCharge: 0, shipping: 0, freeShippingApplied: false }
        : (0, shippingCalculator_1.calculateShippingPure)(lines, rateConfig(s.shipping.zones[zone][chosen.shippingMethod], fallbackKg));
    // Packaging protects goods in transit: pickup orders are not charged for it
    const packaging = isPickup ? { applied: false, weightG: 0, steps: 0, fee: 0 } : (0, exports.specialPackagingFee)(lines, s, fallbackKg);
    const pickupFee = isPickup ? s.pickup.charge : 0;
    const tax = (0, exports.computeTax)(lines, discount, s.tax);
    const grandTotal = (0, exports.round2)(subtotal - discount + tax.addedToTotal + ship.shipping + packaging.fee + pickupFee);
    return {
        fulfillmentMethod: chosen.fulfillment,
        shippingMethod: chosen.shippingMethod,
        zone: isPickup ? null : zone,
        zoneAssumed: !isPickup && !knownZone,
        eta: chosen.eta,
        subtotal,
        discount,
        totalWeight: ship.totalWeight,
        baseShipping: ship.baseShipping,
        extraWeightCharge: ship.extraWeightCharge,
        shipping: ship.shipping,
        freeShippingApplied: ship.freeShippingApplied,
        specialPackagingFee: packaging.fee,
        specialPackaging: { ...packaging, note: packaging.applied || specialLines(lines, s).length ? s.chocolate.customerNote : '' },
        pickupFee,
        pickupDetails: isPickup
            ? { storeName: s.pickup.storeName, address: s.pickup.address, openingHours: s.pickup.openingHours, phone: s.pickup.phone, instructions: s.pickup.instructions }
            : null,
        tax,
        grandTotal,
        options,
    };
};
exports.priceOrder = priceOrder;
//# sourceMappingURL=orderPricing.js.map