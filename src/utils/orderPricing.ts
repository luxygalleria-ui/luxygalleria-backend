import { calculateShippingPure, ShippingConfig } from './shippingCalculator';
import { CheckoutSettings, ShippingMethod, ShippingRate, TaxSettings, Zone, zoneOfState } from './checkoutSettings';

/**
 * The one place an order's money is worked out: shipping, chocolate packaging, pickup charge, discount and GST.
 * Pure (no database): the same function prices the checkout quote, the payment amount and the saved order.
 */

/** A cart line priced from the database. weight is kg per unit. */
export interface PricedLine {
  product: string;
  variantId: string;
  name: string;
  price: number;
  weight: number;
  quantity: number;
  requiresSpecialPackaging?: boolean;
  /** GST % for the product; null/undefined = not set. */
  taxRate?: number | null;
}

export interface Selection {
  fulfillment?: 'delivery' | 'pickup';
  shippingMethod?: ShippingMethod;
  /** Delivery address state; decides Kerala vs outside Kerala. */
  state?: string;
  /** ₹ off the subtotal, already validated by the caller. 0 at checkout today (no coupons are applied server-side). */
  discount?: number;
}

/** A customer choice that the settings do not allow: a 400, never a silent substitute. */
export class CheckoutRuleError extends Error {
  constructor(message: string, public code: string, public options?: CheckoutOption[]) { super(message); }
}

export interface CheckoutOption {
  fulfillment: 'delivery' | 'pickup';
  shippingMethod: ShippingMethod | null;
  /** Offered for this destination at all (hidden by the storefront when false). */
  offered: boolean;
  allowed: boolean;
  reason: string;
  eta: string;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const METHOD_NAME: Record<ShippingMethod, string> = { land: 'road', air: 'air' };

const rateConfig = (r: ShippingRate, fallbackItemWeightKg: number): ShippingConfig => ({
  WEIGHT_THRESHOLD_KG: r.weightThresholdG / 1000,
  SHIPPING_BELOW_THRESHOLD: r.chargeBelow,
  SHIPPING_ABOVE_THRESHOLD: r.chargeAtOrAbove,
  BASE_WEIGHT_KG: r.baseWeightKg,
  EXTRA_SHIPPING_PER_KG: r.extraPerKg,
  FREE_SHIPPING_THRESHOLD: r.freeShippingThreshold,
  FALLBACK_ITEM_WEIGHT_KG: fallbackItemWeightKg,
});

/** Month 1-12 in the store's time zone. */
const monthInIndia = (now: Date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', month: 'numeric' }).format(now));

const specialLines = (lines: PricedLine[], s: CheckoutSettings) => (s.chocolate.enabled ? lines.filter((l) => l.requiresSpecialPackaging) : []);

/** Every way this cart could be received, with the reason when one is not allowed. */
export const checkoutOptions = (lines: PricedLine[], s: CheckoutSettings, zone: Zone, now = new Date()): CheckoutOption[] => {
  const special = specialLines(lines, s).length > 0;
  const blockedMonth = special && s.chocolate.blockedMonths.includes(monthInIndia(now));
  const z = s.shipping.zones[zone];
  const delivery = (['land', 'air'] as ShippingMethod[]).map((m): CheckoutOption => {
    const offered = z.enabled && z[m].enabled;
    let reason = '';
    if (!z.enabled) reason = 'We do not deliver to this destination yet';
    else if (!z[m].enabled) reason = `${METHOD_NAME[m] === 'air' ? 'Air' : 'Road'} shipping is not available for this destination`;
    else if (blockedMonth) reason = 'Temperature-sensitive items cannot be delivered this month; choose store pickup';
    else if (special && !s.chocolate.allowedZones[zone]) reason = 'Temperature-sensitive items cannot be delivered to this destination';
    else if (special && !s.chocolate.allowedMethods[m]) reason = `Temperature-sensitive items cannot be sent by ${METHOD_NAME[m]}`;
    return { fulfillment: 'delivery', shippingMethod: m, offered, allowed: !reason, reason, eta: z[m].eta };
  });
  const pickup: CheckoutOption = {
    fulfillment: 'pickup', shippingMethod: null, offered: s.pickup.enabled, allowed: s.pickup.enabled,
    reason: s.pickup.enabled ? '' : 'Store pickup is not available', eta: s.pickup.readyTime,
  };
  return [...delivery, pickup];
};

/** GST per line. Discount is spread over lines by value before tax. Inclusive prices never get GST added on top. */
export const computeTax = (lines: PricedLine[], discount: number, t: TaxSettings) => {
  const totals = lines.map((l) => round2(l.price * l.quantity));
  const subtotal = round2(totals.reduce((a, b) => a + b, 0));
  if (!t.enabled) {
    return { enabled: false, pricesIncludeTax: t.pricesIncludeTax, taxableValue: round2(subtotal - discount), taxAmount: 0, addedToTotal: 0, lines: [], missingRates: [] as string[] };
  }
  let allocated = 0;
  const missingRates: string[] = [];
  const out = lines.map((l, i) => {
    const share = i === lines.length - 1 ? round2(discount - allocated) : subtotal ? round2((discount * totals[i]) / subtotal) : 0;
    allocated = round2(allocated + share);
    const net = round2(totals[i] - share);
    const rate = typeof l.taxRate === 'number' && Number.isFinite(l.taxRate) ? l.taxRate : null;
    if (rate === null) {
      // Exclusive pricing cannot charge a correct total without the rate: refuse rather than under/over-charge
      if (!t.pricesIncludeTax) throw new CheckoutRuleError(`GST rate is not set for "${l.name}". Please contact the store.`, 'TAX_RATE_MISSING');
      missingRates.push(l.name);
      return { product: l.product, variantId: l.variantId, rate: null, taxableValue: net, taxAmount: 0 };
    }
    const taxAmount = t.pricesIncludeTax ? round2((net * rate) / (100 + rate)) : round2((net * rate) / 100);
    return { product: l.product, variantId: l.variantId, rate, taxableValue: t.pricesIncludeTax ? round2(net - taxAmount) : net, taxAmount };
  });
  const taxAmount = round2(out.reduce((a, x) => a + x.taxAmount, 0));
  return {
    enabled: true,
    pricesIncludeTax: t.pricesIncludeTax,
    taxableValue: round2(out.reduce((a, x) => a + x.taxableValue, 0)),
    taxAmount,
    addedToTotal: t.pricesIncludeTax ? 0 : taxAmount,
    lines: out,
    missingRates,
  };
};

/** Chocolate packaging: charged once per order on the combined weight of all such items, never per product. */
export const specialPackagingFee = (lines: PricedLine[], s: CheckoutSettings) => {
  const special = specialLines(lines, s);
  if (!special.length) return { applied: false, weightG: 0, steps: 0, fee: 0 };
  const weightG = Math.round(special.reduce((a, l) => a + (Number(l.weight) || 0) * l.quantity * 1000, 0));
  if (s.chocolate.basis === 'flat_per_order') return { applied: true, weightG, steps: 1, fee: s.chocolate.feeAmount };
  // Every started step counts; an item with no recorded weight still counts as one step
  const steps = Math.max(1, Math.ceil(weightG / s.chocolate.unitGrams));
  return { applied: true, weightG, steps, fee: round2(steps * s.chocolate.feeAmount) };
};

export const priceOrder = (lines: PricedLine[], s: CheckoutSettings, sel: Selection = {}, opts: { now?: Date; fallbackItemWeightKg?: number } = {}) => {
  const knownZone = zoneOfState(sel.state);
  const zone: Zone = knownZone ?? 'kerala';
  const options = checkoutOptions(lines, s, zone, opts.now);

  // Explicit choice must be allowed; otherwise the first allowed delivery method, then pickup
  let chosen: CheckoutOption | undefined;
  if (sel.fulfillment === 'pickup') chosen = options.find((o) => o.fulfillment === 'pickup');
  else if (sel.fulfillment === 'delivery' && sel.shippingMethod) chosen = options.find((o) => o.shippingMethod === sel.shippingMethod);
  // No allowed method: report the most relevant reason (an offered method's, else the destination's)
  else if (sel.fulfillment === 'delivery') chosen = options.find((o) => o.fulfillment === 'delivery' && o.allowed) ?? options.find((o) => o.fulfillment === 'delivery' && o.offered) ?? options[0];
  else chosen = options.find((o) => o.allowed);
  if (!chosen) throw new CheckoutRuleError('No delivery or pickup option is available for this order', 'NO_OPTION', options);
  if (!chosen.allowed) throw new CheckoutRuleError(chosen.reason || 'This option is not available', 'OPTION_UNAVAILABLE', options);

  const subtotal = round2(lines.reduce((a, l) => a + l.price * l.quantity, 0));
  const discount = round2(Math.min(Math.max(Number(sel.discount) || 0, 0), subtotal));
  const isPickup = chosen.fulfillment === 'pickup';

  const ship = isPickup
    ? { totalWeight: calculateShippingPure(lines).totalWeight, baseShipping: 0, extraWeightCharge: 0, shipping: 0, freeShippingApplied: false }
    : calculateShippingPure(lines, rateConfig(s.shipping.zones[zone][chosen.shippingMethod!], opts.fallbackItemWeightKg ?? 0));

  // Packaging protects goods in transit: pickup orders are not charged for it
  const packaging = isPickup ? { applied: false, weightG: 0, steps: 0, fee: 0 } : specialPackagingFee(lines, s);
  const pickupFee = isPickup ? s.pickup.charge : 0;
  const tax = computeTax(lines, discount, s.tax);
  const grandTotal = round2(subtotal - discount + tax.addedToTotal + ship.shipping + packaging.fee + pickupFee);

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

export type OrderQuote = ReturnType<typeof priceOrder>;
