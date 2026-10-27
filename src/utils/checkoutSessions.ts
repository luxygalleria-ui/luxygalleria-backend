import crypto from 'crypto';
import mongoose from 'mongoose';
import { Product } from '../models/Product';
import Order from '../models/Order';
import { Settings } from '../models/Settings';
import { CheckoutSession, ICheckoutSession } from '../models/CheckoutSession';
import { effectiveCheckoutSettings } from './checkoutSettings';
import type { OrderQuote } from './orderPricing';
import type { ResolvedLine } from './shippingCalculator';

/**
 * Checkout session lifecycle: stock reservation, the immutable quote snapshot, and the single path that turns a
 * confirmed payment into an order (used by /payments/verify, the Razorpay webhook and reconciliation alike).
 */

/** Unpaid sessions release their stock after this long (CHECKOUT_SESSION_TTL_MINUTES, default 30, minimum 5). */
export const sessionTtlMs = () => Math.max(5, Number(process.env.CHECKOUT_SESSION_TTL_MINUTES) || 30) * 60_000;
/** A session left "processing" this long (crashed mid-finalize) may be claimed again. */
const STUCK_PROCESSING_MS = 2 * 60_000;

type StockLine = { product: unknown; variantId: unknown; quantity: number; name: string };

/** Releases stock taken by reserveStock. */
export const releaseStock = async (lines: StockLine[]) => {
  for (const l of lines) {
    await Product.updateOne({ _id: l.product, 'variants._id': l.variantId }, { $inc: { 'variants.$.stock': l.quantity, stock: l.quantity } });
  }
};

/**
 * Takes stock for every line, all or nothing. Each decrement is a single conditional update (stock >= wanted),
 * so concurrent checkouts can never take the same units: the database refuses the second one.
 */
export const reserveStock = async (lines: StockLine[]): Promise<{ ok: true } | { ok: false; name: string; available: number }> => {
  const wanted = new Map<string, StockLine>();
  for (const l of lines) {
    // Explicit fields: lines may be Mongoose subdocuments, whose properties do not survive an object spread
    const k = `${l.product}:${l.variantId}`;
    const w = wanted.get(k);
    wanted.set(k, { product: l.product, variantId: l.variantId, name: l.name, quantity: (w?.quantity ?? 0) + Number(l.quantity) });
  }
  const taken: StockLine[] = [];
  for (const w of wanted.values()) {
    const r = await Product.updateOne(
      { _id: w.product, variants: { $elemMatch: { _id: w.variantId, stock: { $gte: w.quantity } } } },
      { $inc: { 'variants.$.stock': -w.quantity, stock: -w.quantity } },
    );
    if (!r.modifiedCount) {
      await releaseStock(taken);
      const p: any = await Product.findOne({ _id: w.product }, { variants: 1 }).lean();
      const available = Math.max(0, Number(p?.variants?.find((v: any) => String(v._id) === String(w.variantId))?.stock) || 0);
      return { ok: false, name: w.name, available };
    }
    taken.push(w);
  }
  return { ok: true };
};

/** Fingerprint of the checkout settings a quote was priced with (audit: which rules applied). */
export const settingsFingerprint = async () => {
  const doc: any = await Settings.findOne().lean();
  const { settings, fallbackItemWeightKg } = effectiveCheckoutSettings(doc);
  const version = crypto.createHash('sha256').update(JSON.stringify({ settings, fallbackItemWeightKg })).digest('hex').slice(0, 16);
  return { version, updatedAt: doc?.updatedAt as Date | undefined };
};

/** Builds the snapshot document from a validated server quote. Client input contributes only the size label and image. */
export const snapshotFromQuote = (
  q: OrderQuote & { lines: ResolvedLine[] },
  clientItems: any[],
  extra: { user: unknown; razorpayOrderId: string; isMock: boolean; shippingAddress?: unknown; settingsVersion: string; settingsUpdatedAt?: Date },
) => ({
  user: extra.user,
  razorpayOrderId: extra.razorpayOrderId,
  isMock: extra.isMock,
  status: 'pending',
  stockReserved: true,
  expiresAt: new Date(Date.now() + sessionTtlMs()),
  items: q.lines.map((l, i) => ({
    product: l.product, variantId: l.variantId, name: l.name, sku: l.sku, price: l.price, quantity: l.quantity, weight: l.weight,
    size: typeof clientItems[i]?.size === 'string' ? clientItems[i].size.slice(0, 50) : undefined,
    image: typeof clientItems[i]?.image === 'string' ? clientItems[i].image.slice(0, 500) : undefined,
    subtotal: Math.round(l.price * l.quantity * 100) / 100,
    requiresSpecialPackaging: l.requiresSpecialPackaging,
    ...(q.tax.enabled ? { taxRate: q.tax.lines[i]?.rate ?? null, taxAmount: q.tax.lines[i]?.taxAmount ?? 0 } : {}),
  })),
  fulfillmentMethod: q.fulfillmentMethod,
  shippingMethod: q.shippingMethod ?? undefined,
  shippingZone: q.zone ?? undefined,
  shippingAddress: q.fulfillmentMethod === 'pickup' ? undefined : extra.shippingAddress,
  pickupDetails: q.pickupDetails ?? undefined,
  breakdown: {
    subtotal: q.subtotal, discount: q.discount, totalWeight: q.totalWeight, baseShipping: q.baseShipping, extraWeightCharge: q.extraWeightCharge,
    shipping: q.shipping, freeShippingApplied: q.freeShippingApplied, specialPackagingFee: q.specialPackagingFee, pickupFee: q.pickupFee,
    grandTotal: q.grandTotal,
    specialPackaging: { weightG: q.specialPackaging.weightG, steps: q.specialPackaging.steps, rule: q.specialPackaging.rule },
    tax: { enabled: q.tax.enabled, pricesIncludeTax: q.tax.pricesIncludeTax, taxableValue: q.tax.taxableValue, taxAmount: q.tax.taxAmount, addedToTotal: q.tax.addedToTotal },
  },
  amountPaise: Math.round(q.grandTotal * 100),
  currency: 'INR',
  settingsVersion: extra.settingsVersion,
  settingsUpdatedAt: extra.settingsUpdatedAt,
  events: [{ at: new Date(), type: 'created', detail: `amount ${Math.round(q.grandTotal * 100)} paise` }],
});

/** Order fields copied verbatim from the snapshot: the order records exactly what was charged. */
const orderFromSession = (s: ICheckoutSession, paymentId: string, signature: string) => ({
  user: s.user,
  checkoutSession: s._id,
  items: s.items.map((i) => ({
    product: i.product, variantId: i.variantId, name: i.name, sku: i.sku, quantity: i.quantity, price: i.price, size: i.size, image: i.image, subtotal: i.subtotal,
    ...(s.breakdown.tax.enabled ? { taxRate: i.taxRate ?? null, taxAmount: i.taxAmount ?? 0 } : {}),
  })),
  fulfillmentMethod: s.fulfillmentMethod,
  shippingMethod: s.shippingMethod,
  shippingZone: s.shippingZone,
  shippingAddress: s.fulfillmentMethod === 'pickup' ? undefined : s.shippingAddress,
  pickupDetails: s.fulfillmentMethod === 'pickup' ? s.pickupDetails : undefined,
  pickupFee: s.breakdown.pickupFee,
  specialPackagingFee: s.breakdown.specialPackagingFee,
  tax: s.breakdown.tax,
  subtotal: s.breakdown.subtotal,
  discount: s.breakdown.discount,
  shippingFee: s.breakdown.shipping,
  total: s.breakdown.grandTotal,
  paymentMethod: 'razorpay',
  paymentStatus: 'completed',
  razorpayOrderId: s.razorpayOrderId,
  razorpayPaymentId: paymentId,
  razorpaySignature: signature,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type FinalizeOutcome = 'created' | 'existing' | 'unfulfillable' | 'processing';

/**
 * Turns a CONFIRMED payment (caller has checked signature/webhook signature, order id, status, currency and exact
 * amount against the snapshot) into exactly one order. Idempotent and race-safe: the session is claimed atomically,
 * the order collection refuses a second order for the same Razorpay order, and stock is never taken twice.
 */
export const finalizeSession = async (
  sessionId: mongoose.Types.ObjectId | string, paymentId: string, signature: string, source: 'verify' | 'webhook' | 'reconcile',
): Promise<{ order: any | null; outcome: FinalizeOutcome }> => {
  const claimed = await CheckoutSession.findOneAndUpdate(
    { _id: sessionId, $or: [{ status: { $in: ['pending', 'expired'] } }, { status: 'processing', updatedAt: { $lt: new Date(Date.now() - STUCK_PROCESSING_MS) } }] },
    { $set: { status: 'processing' }, $push: { events: { at: new Date(), type: 'claimed', detail: `${source} payment ${paymentId}` } } },
    { new: true },
  );
  if (!claimed) {
    // Already finished, or another request (e.g. the webhook) is finishing it right now
    for (let i = 0; i < 20; i++) {
      const s = await CheckoutSession.findById(sessionId).lean();
      if (s?.order) {
        const order = await Order.findById(s.order);
        return { order, outcome: s.status === 'unfulfillable' ? 'unfulfillable' : 'existing' };
      }
      if (!s || s.status !== 'processing') break;
      await sleep(250);
    }
    return { order: null, outcome: 'processing' };
  }

  // Crash recovery: an order may already exist for this Razorpay order
  let order: any = await Order.findOne({ razorpayOrderId: claimed.razorpayOrderId });
  let fulfillable = true;
  let issue = '';
  if (!order) {
    if (!claimed.stockReserved) {
      // The session expired and released its stock; take it again now that payment is confirmed
      const r = await reserveStock(claimed.items);
      if (r.ok) {
        await CheckoutSession.updateOne({ _id: claimed._id }, { $set: { stockReserved: true }, $push: { events: { at: new Date(), type: 'stock-rereserved' } } });
      } else {
        fulfillable = false;
        issue = `Paid after the checkout session expired; ${r.name} is no longer in stock (${r.available} left)`;
      }
    }
    const doc = new Order({
      ...orderFromSession(claimed, paymentId, signature),
      orderStatus: fulfillable ? 'processing' : 'cancelled',
      ...(fulfillable ? {} : {
        fulfillmentIssue: issue,
        refund: { status: 'required', amountPaise: claimed.amountPaise, reason: issue, events: [{ at: new Date(), by: 'system', action: 'flagged', detail: issue }] },
      }),
    });
    try {
      order = await doc.save();
    } catch (err: any) {
      if (err?.code !== 11000) {
        await CheckoutSession.updateOne({ _id: claimed._id }, { $set: { status: 'pending' }, $push: { events: { at: new Date(), type: 'finalize-error', detail: String(err?.message).slice(0, 200) } } });
        throw err;
      }
      order = await Order.findOne({ razorpayOrderId: claimed.razorpayOrderId }); // a concurrent request won
    }
  } else {
    fulfillable = order.orderStatus !== 'cancelled' || !order.fulfillmentIssue;
  }

  await CheckoutSession.updateOne({ _id: claimed._id }, {
    $set: { status: fulfillable ? 'paid' : 'unfulfillable', order: order._id, paymentId },
    $push: { events: { at: new Date(), type: fulfillable ? 'paid' : 'unfulfillable', detail: `${source} -> order ${order._id}` } },
  });
  return { order, outcome: fulfillable ? 'created' : 'unfulfillable' };
};

/**
 * Releases stock held by unpaid sessions past their deadline. The status flip and the "stock reserved" flag change
 * together in one conditional update, so the stock is returned exactly once and a late payment knows to re-reserve.
 */
export const expireStaleSessions = async (now = new Date()) => {
  const stale = await CheckoutSession.find({ status: 'pending', expiresAt: { $lt: now } }, { _id: 1 }).limit(500).lean();
  let expired = 0;
  for (const { _id } of stale) {
    const before = await CheckoutSession.findOneAndUpdate(
      { _id, status: 'pending' },
      { $set: { status: 'expired', stockReserved: false }, $push: { events: { at: new Date(), type: 'expired', detail: 'stock released' } } },
      { new: false },
    );
    if (before?.stockReserved) await releaseStock(before.items);
    if (before) expired++;
  }
  return expired;
};
