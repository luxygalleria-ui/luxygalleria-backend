import path from 'path';
import mongoose from 'mongoose';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Product } from '../models/Product';
import { Category } from '../models/Category';
import { Brand } from '../models/Brand';
import { User } from '../models/User';
import Order from '../models/Order';
import { ErpEvent } from '../models/ErpEvent';
import { CheckoutSession } from '../models/CheckoutSession';
import { ORDER_STATUSES, canMoveOrderStatus as canMove } from '../utils/orderStatus';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';
import { parseWeightFromVolume } from '../utils/shippingCalculator';
import { escapeRegex } from './contactController';
import { sendOrderStatusEmail } from './paymentController';

// ---------- shared ----------

const fail = (res: Response, status: number, message: string, code: string, field?: string) =>
  errorResponse(res, status, message, [{ code, ...(field ? { field } : {}) }]);

const invalid = (res: Response, err: z.ZodError) =>
  errorResponse(res, 400, 'Validation failed', err.issues.map((i) => ({
    field: i.path.join('.') || undefined, code: 'VALIDATION_ERROR', message: i.message,
  })));

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a 24-character hex id');
const isoDate = z.string().datetime({ offset: true, message: 'must be an ISO 8601 timestamp, e.g. 2026-10-17T10:00:00Z' });
const sku = z.string().trim().min(1).max(64);
const money = z.number().finite().min(0).max(10_000_000);
const httpsUrl = z.string().trim().url().max(2048).refine((u) => u.startsWith('https://'), 'must be an https URL');
const PAYMENT_STATUSES = ['pending', 'completed', 'failed', 'refunded'] as const;
const itemListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(100).optional(),
}).strict();

// Stock updates keep the product-level total equal to the sum of its variants, in one atomic write.
const syncProductStock = (id: unknown) =>
  Product.updateOne({ _id: id }, [{ $set: { stock: { $sum: '$variants.stock' } } }]);

/** The one variant carrying this SKU. Several carriers mean bad data the ERP must not paper over. */
const findSku = async (code: string) => {
  const products = await Product.find({ 'variants.sku': code });
  const hits = products.flatMap((product) => product.variants.filter((v) => v.sku === code).map((variant) => ({ product, variant })));
  return hits;
};

const skuLookupError = (res: Response, code: string, count: number) =>
  count === 0
    ? fail(res, 404, `SKU not found: ${code}`, 'NOT_FOUND', 'sku')
    : fail(res, 409, `SKU ${code} is used by ${count} website variants; fix the duplicate before syncing`, 'DUPLICATE_SKU', 'sku');

// ---------- items ----------

const variantFields = {
  size: z.string().trim().min(1).max(50).optional(),
  volume: z.string().trim().min(1).max(50).optional(),
  flavor: z.string().trim().min(1).max(50).optional(),
  offerPrice: money.optional(),
  actualPrice: money.optional(),
  weight: z.number().finite().min(0).max(1000).optional(), // kg
  image: httpsUrl.optional(),
};
const productFields = {
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(5000).optional(),
  category: z.string().trim().min(1).max(100).optional(), // name or id
  brand: z.string().trim().min(1).max(100).optional(), // name
  brandId: objectId.optional(),
  imageUrls: z.array(httpsUrl).max(10).optional(),
};
const upsertSchema = z.object({
  ...productFields,
  variants: z.array(z.object({ sku, ...variantFields, stock: z.number().int().min(0).max(1_000_000).optional() }).strict()).min(1).max(50),
}).strict();
const patchSchema = z.object({ ...productFields, ...variantFields }).strict()
  .refine((o) => Object.keys(o).length > 0, 'send at least one field to change');

type ProductInput = z.infer<typeof upsertSchema> | z.infer<typeof patchSchema>;
type VariantInput = Partial<Record<keyof typeof variantFields, any>>;

const byName = (Model: any, name: string) => Model.findOne({ name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' } });

/** Product-level fields to set, with category/brand resolved to website records. Only supplied fields appear. */
const productUpdate = async (input: ProductInput): Promise<{ fields: Record<string, unknown> } | { error: [string, string] }> => {
  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) fields.name = input.name;
  if (input.description !== undefined) fields.description = input.description;
  if (input.imageUrls !== undefined) fields.images = input.imageUrls;
  if (input.category !== undefined) {
    const cat = /^[a-f\d]{24}$/i.test(input.category) ? await Category.findById(input.category) : await byName(Category, input.category);
    if (!cat) return { error: ['category', `Unknown category: ${input.category}`] };
    fields.category = cat.name;
    fields.categoryId = cat._id;
  }
  if (input.brandId !== undefined || input.brand !== undefined) {
    const brand = input.brandId ? await Brand.findById(input.brandId) : await byName(Brand, input.brand!);
    if (!brand) return { error: [input.brandId ? 'brandId' : 'brand', 'Unknown brand'] };
    fields.brandId = brand._id;
  }
  return { fields };
};

/** Applies supplied variant fields, keeping the legacy mirror fields (volume/price/oldPrice) in step. Never touches stock. */
const applyVariant = (v: any, input: VariantInput) => {
  const size = input.size ?? input.volume;
  if (size !== undefined) { v.size = size; v.volume = size; }
  if (input.flavor !== undefined) v.flavor = input.flavor;
  if (input.offerPrice !== undefined) { v.offerPrice = input.offerPrice; v.price = input.offerPrice; }
  if (input.actualPrice !== undefined) { v.actualPrice = input.actualPrice; v.oldPrice = input.actualPrice; }
  if (input.weight !== undefined) v.weight = input.weight;
  if (input.image !== undefined) v.image = input.image;
};

const priceProblem = (v: any, input: VariantInput) =>
  (input.offerPrice !== undefined || input.actualPrice !== undefined) && v.offerPrice > v.actualPrice
    ? 'offerPrice cannot be higher than actualPrice (MRP)' : null;

const variantSummary = (v: any) => ({
  sku: v.sku, variantId: String(v._id), size: v.size || v.volume, flavor: v.flavor,
  offerPrice: v.offerPrice, actualPrice: v.actualPrice, stock: v.stock, weight: v.weight, image: v.image || null,
});

// GET /erp/items/:sku — return the exact product variant addressed by SKU.
export const getItemBySku = asyncHandler(async (req: Request, res: Response) => {
  const code = req.params.sku.trim();
  const hits = await findSku(code);
  if (hits.length !== 1) return skuLookupError(res, code, hits.length);
  const { product, variant } = hits[0];

  successResponse(res, 200, 'Item fetched', {
    productId: String(product._id),
    name: product.name,
    description: product.description,
    category: product.category,
    images: product.images ?? [],
    variant: variantSummary(variant),
  });
});

// POST /erp/items — create, or update the product that already carries these SKUs
export const listItems = asyncHandler(async (req: Request, res: Response) => {
  const parsed = itemListSchema.safeParse(req.query);
  if (!parsed.success) return invalid(res, parsed.error);
  const { page, limit, search } = parsed.data;
  const filter = search
    ? { $or: [{ name: { $regex: escapeRegex(search), $options: 'i' } }, { 'variants.sku': { $regex: escapeRegex(search), $options: 'i' } }] }
    : {};

  const [total, products] = await Promise.all([
    Product.countDocuments(filter),
    Product.find(filter).sort({ updatedAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
  ]);

  successResponse(res, 200, 'Items fetched', {
    items: products.map((product: any) => ({
      productId: String(product._id),
      name: product.name,
      description: product.description,
      category: product.category,
      images: product.images ?? [],
      status: product.status,
      updatedAt: product.updatedAt,
      variants: product.variants.map((variant: any) => ({
        variantId: String(variant._id),
        sku: variant.sku ?? null,
        name: variant.name ?? null,
        size: variant.size || variant.volume || null,
        flavor: variant.flavor ?? null,
        offerPrice: variant.offerPrice ?? variant.price,
        actualPrice: variant.actualPrice ?? variant.oldPrice ?? null,
        stock: variant.stock,
        weight: variant.weight,
        image: variant.image ?? null,
      })),
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

export const upsertItem = asyncHandler(async (req: Request, res: Response) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const input = parsed.data;

  const skus = input.variants.map((v) => v.sku);
  if (new Set(skus).size !== skus.length) return fail(res, 400, 'Each SKU may appear only once per request', 'VALIDATION_ERROR', 'variants');

  const products = await Product.find({ 'variants.sku': { $in: skus } });
  for (const code of skus) {
    const count = products.reduce((n, p) => n + p.variants.filter((v) => v.sku === code).length, 0);
    if (count > 1) return skuLookupError(res, code, count);
  }
  if (products.length > 1) return fail(res, 409, 'These SKUs belong to different website products; send them separately', 'CONFLICT', 'variants');

  const update = await productUpdate(input);
  if ('error' in update) return fail(res, 400, update.error[1], 'VALIDATION_ERROR', update.error[0]);

  const isNew = products.length === 0;
  if (isNew) {
    const missing = (['name', 'description', 'category'] as const).filter((f) => input[f] === undefined);
    if (missing.length) {
      return errorResponse(res, 400, 'Validation failed', missing.map((field) => ({ field, code: 'VALIDATION_ERROR', message: 'required when creating an item' })));
    }
    // A website product of this name whose variants have no SKU yet is most likely this item: creating another would
    // duplicate it in the catalogue. The website team sets the ERP-approved SKU on it instead (no mapping is guessed here).
    const unmapped = await Product.findOne({
      name: { $regex: `^${escapeRegex(input.name!)}$`, $options: 'i' },
      variants: { $elemMatch: { $or: [{ sku: { $exists: false } }, { sku: null }, { sku: { $regex: '^\\s*$' } }] } },
    }).select('_id').lean();
    if (unmapped) {
      return errorResponse(res, 409, `Website product "${input.name}" already exists with variants that have no SKU. Ask the website team to set the SKUs on it instead of creating a new item`, [
        { code: 'UNMAPPED_PRODUCT', field: 'name', productId: String(unmapped._id) },
      ]);
    }
  }
  const product = isNew ? new Product({ ...update.fields, variants: [] }) : products[0];
  if (!isNew) product.set(update.fields);

  const created: any[] = [];
  const actions: Record<string, 'created' | 'updated'> = {};
  for (const [i, vin] of input.variants.entries()) {
    const existing: any = product.variants.find((v) => v.sku === vin.sku);
    if (existing) {
      applyVariant(existing, vin); // stock of an existing variant changes only through PUT /erp/stock
      const problem = priceProblem(existing, vin);
      if (problem) return fail(res, 400, problem, 'VALIDATION_ERROR', `variants.${i}.offerPrice`);
      actions[vin.sku] = 'updated';
      continue;
    }
    if (vin.offerPrice === undefined || vin.actualPrice === undefined) {
      return fail(res, 400, 'offerPrice and actualPrice are required for a new variant', 'VALIDATION_ERROR', `variants.${i}`);
    }
    if (vin.offerPrice > vin.actualPrice) return fail(res, 400, 'offerPrice cannot be higher than actualPrice (MRP)', 'VALIDATION_ERROR', `variants.${i}.offerPrice`);
    const size = vin.size ?? vin.volume ?? 'Standard';
    created.push({
      sku: vin.sku, size, volume: size, flavor: vin.flavor ?? 'Default',
      offerPrice: vin.offerPrice, price: vin.offerPrice, actualPrice: vin.actualPrice, oldPrice: vin.actualPrice,
      stock: vin.stock ?? 0, weight: vin.weight ?? parseWeightFromVolume(size) ?? 0, image: vin.image ?? '',
    });
    actions[vin.sku] = 'created';
  }

  if (isNew) {
    product.variants.push(...created);
    product.weight = product.variants[0].weight;
    await product.save();
  } else {
    // Two saves so Mongoose issues targeted $set / $push, never a whole-array write that could undo a checkout's stock decrement
    await product.save();
    if (created.length) {
      product.variants.push(...created);
      await product.save();
    }
  }
  await syncProductStock(product._id);

  return successResponse(res, isNew ? 201 : 200, isNew ? 'Item created' : 'Item updated', {
    productId: String(product._id),
    action: isNew ? 'created' : 'updated',
    variants: product.variants.filter((v) => actions[v.sku!]).map((v) => ({ ...variantSummary(v), action: actions[v.sku!] })),
  });
});

// PATCH /erp/items/:sku — change only the supplied fields of this variant and its product
export const patchItem = asyncHandler(async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const input = parsed.data;

  const code = req.params.sku.trim();
  const hits = await findSku(code);
  if (hits.length !== 1) return skuLookupError(res, code, hits.length);
  const { product, variant } = hits[0];

  const update = await productUpdate(input);
  if ('error' in update) return fail(res, 400, update.error[1], 'VALIDATION_ERROR', update.error[0]);
  product.set(update.fields);
  applyVariant(variant, input);
  const problem = priceProblem(variant, input);
  if (problem) return fail(res, 400, problem, 'VALIDATION_ERROR', 'offerPrice');
  await product.save();

  return successResponse(res, 200, 'Item updated', {
    productId: String(product._id),
    name: product.name,
    category: product.category,
    images: product.images,
    updatedFields: Object.keys(input),
    variant: variantSummary(variant),
  });
});

// ---------- stock ----------

const stockSchema = z.object({
  quantity: z.number().int().min(0).max(1_000_000),
  asOf: isoDate,
}).strict();

/** Units of this variant in website orders placed after the ERP's snapshot — not yet reflected in its figure. */
const pendingQuantity = async (variantId: unknown, since: Date) => {
  const id = new mongoose.Types.ObjectId(String(variantId));
  const [row] = await Order.aggregate([
    { $match: { createdAt: { $gt: since }, orderStatus: { $ne: 'cancelled' }, 'items.variantId': id } },
    { $unwind: '$items' },
    { $match: { 'items.variantId': id } },
    { $group: { _id: null, qty: { $sum: '$items.quantity' } } },
  ]);
  return row?.qty || 0;
};

/** Units of this variant held right now by unpaid or finishing checkouts. The ERP never sees these reservations. */
const reservedQuantity = async (variantId: unknown) => {
  const id = new mongoose.Types.ObjectId(String(variantId));
  const [row] = await CheckoutSession.aggregate([
    { $match: { stockReserved: true, status: { $in: ['pending', 'processing'] }, 'items.variantId': id } },
    { $unwind: '$items' },
    { $match: { 'items.variantId': id } },
    { $group: { _id: null, qty: { $sum: '$items.quantity' } } },
  ]);
  return row?.qty || 0;
};

const STOCK_WRITE_ATTEMPTS = 3;

// PUT /erp/stock/:sku — absolute sellable quantity for one variant
export const updateStock = asyncHandler(async (req: Request, res: Response) => {
  const parsed = stockSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const asOf = new Date(parsed.data.asOf);
  if (asOf.getTime() > Date.now() + 5 * 60 * 1000) return fail(res, 400, 'asOf is in the future', 'VALIDATION_ERROR', 'asOf');

  const code = req.params.sku.trim();
  const hits = await findSku(code);
  if (hits.length !== 1) return skuLookupError(res, code, hits.length);
  const { product, variant } = hits[0];
  const base = { sku: code, productId: String(product._id), variantId: String(variant._id), asOf: asOf.toISOString() };
  const newerOrSame = (v: any) => v?.stockAsOf && v.stockAsOf.getTime() >= asOf.getTime();

  // ponytail: provisional reconcile rule (ERP to confirm physical vs sellable). Stored = ERP figure minus website orders
  // after asOf minus units held by open checkouts (the ERP knows neither). Sessions are read before orders, so a checkout
  // finishing between the two reads is counted twice (under-sells), never missed. The write only applies if the stock
  // is still what it was when read, so a reservation or release in between is never overwritten; a transaction would
  // remove the double-count window too.
  let current: any = variant;
  let reserved = 0;
  let pending = 0;
  let quantity = 0;
  let applied = false;
  for (let attempt = 0; attempt < STOCK_WRITE_ATTEMPTS && current && !newerOrSame(current); attempt++) {
    reserved = await reservedQuantity(variant._id);
    pending = await pendingQuantity(variant._id, asOf);
    quantity = Math.max(0, parsed.data.quantity - pending - reserved);

    // Only this variant's stock, only if no newer ERP figure was applied, and only if nothing moved its stock since the read.
    const r = await Product.updateOne(
      { _id: product._id, variants: { $elemMatch: { _id: variant._id, sku: code, stock: current.stock, $or: [{ stockAsOf: { $exists: false } }, { stockAsOf: null }, { stockAsOf: { $lt: asOf } }] } } },
      { $set: { 'variants.$.stock': quantity, 'variants.$.stockAsOf': asOf } }
    );
    if (r.matchedCount) { applied = true; break; }
    const fresh: any = await Product.findById(product._id, { variants: 1 }).lean();
    current = fresh?.variants?.find((v: any) => String(v._id) === String(variant._id) && v.sku === code);
  }

  if (!applied) {
    if (!current) return fail(res, 404, `SKU not found: ${code}`, 'NOT_FOUND', 'sku');
    if (current.stockAsOf && current.stockAsOf.getTime() === asOf.getTime()) {
      // Same update delivered again: answer as before, change nothing
      return successResponse(res, 200, 'Stock already at this update', { ...base, previousQuantity: current.stock, quantity: current.stock, applied: false, updatedAt: new Date().toISOString() });
    }
    if (newerOrSame(current)) {
      return errorResponse(res, 409, 'A newer stock update has already been applied', [{ code: 'STALE_UPDATE', field: 'asOf', currentAsOf: current.stockAsOf.toISOString() }]);
    }
    return errorResponse(res, 409, 'Stock changed repeatedly while applying this update; retry it', [{ code: 'CONFLICT' }]);
  }
  await syncProductStock(product._id);

  return successResponse(res, 200, 'Stock updated', {
    ...base,
    previousQuantity: current.stock,
    quantity,
    erpQuantity: parsed.data.quantity,
    pendingOrderQuantity: pending,
    reservedQuantity: reserved,
    applied: true,
    updatedAt: new Date().toISOString(),
  });
});

// ---------- orders ----------

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(ORDER_STATUSES).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  updatedSince: isoDate.optional(),
}).strict();

/** Loads referenced products/users ourselves so ids survive even when the referenced record was deleted. */
const loadRefs = async (orders: any[]) => {
  const productIds = [...new Set(orders.flatMap((o) => o.items.map((i: any) => String(i.product))))];
  const userIds = [...new Set(orders.map((o) => String(o.user)))];
  const [products, users] = await Promise.all([
    Product.find({ _id: { $in: productIds } }).select('name variants._id variants.sku').lean(),
    User.find({ _id: { $in: userIds } }).select('name email phone').lean(),
  ]);
  return {
    products: new Map(products.map((p: any) => [String(p._id), p])),
    users: new Map(users.map((u: any) => [String(u._id), u])),
  };
};

const orderLines = (order: any, products: Map<string, any>) => order.items.map((it: any) => {
  const p = products.get(String(it.product));
  const v = p?.variants?.find((x: any) => String(x._id) === String(it.variantId));
  return {
    productId: String(it.product),
    variantId: String(it.variantId),
    sku: it.sku || v?.sku || null, // SKU as sold; older orders fall back to the variant's current SKU
    name: it.name ?? p?.name ?? null,
    size: it.size ?? null,
    quantity: it.quantity,
    unitPrice: it.price,
    lineTotal: it.subtotal ?? it.price * it.quantity,
    taxRate: it.taxRate ?? null,
    taxAmount: it.taxAmount ?? null,
  };
});

const orderSummary = (o: any, refs: Awaited<ReturnType<typeof loadRefs>>) => {
  const u = refs.users.get(String(o.user));
  return {
    orderId: String(o._id),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    orderStatus: o.orderStatus,
    paymentStatus: o.paymentStatus,
    currency: 'INR', // the store only charges INR; not stored per order
    subtotal: o.subtotal,
    discount: o.discount,
    shippingFee: o.shippingFee,
    total: o.total,
    // Added fields (orders placed before these existed: delivery, no extra charges)
    fulfillment: {
      method: o.fulfillmentMethod ?? 'delivery',
      shippingMethod: o.shippingMethod ?? null,
      zone: o.shippingZone ?? null,
      pickup: o.fulfillmentMethod === 'pickup' ? { storeName: o.pickupDetails?.storeName ?? null, address: o.pickupDetails?.address ?? null } : null,
    },
    charges: {
      pickupFee: o.pickupFee ?? 0,
      specialPackagingFee: o.specialPackagingFee ?? 0,
      tax: o.tax?.enabled ? { pricesIncludeTax: o.tax.pricesIncludeTax, taxableValue: o.tax.taxableValue, taxAmount: o.tax.taxAmount } : null,
    },
    customer: { customerId: String(o.user), name: u?.name ?? null, email: u?.email ?? null },
    items: orderLines(o, refs.products),
    erp: { erpOrderId: o.erpOrderId ?? null, trackingNumber: o.trackingNumber ?? null },
  };
};

// GET /erp/orders
export const listOrders = asyncHandler(async (req: Request, res: Response) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return invalid(res, parsed.error);
  const { page, limit, status, paymentStatus, updatedSince } = parsed.data;

  const filter: Record<string, unknown> = {};
  if (status) filter.orderStatus = status;
  if (paymentStatus) filter.paymentStatus = paymentStatus;
  if (updatedSince) filter.updatedAt = { $gte: new Date(updatedSince) };

  const [total, orders] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter).sort({ updatedAt: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  const refs = await loadRefs(orders);

  res.status(200).json({
    success: true,
    message: 'Orders fetched',
    data: orders.map((o) => orderSummary(o, refs)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// GET /erp/orders/:orderId
export const getOrder = asyncHandler(async (req: Request, res: Response) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.orderId)) return fail(res, 400, 'orderId must be a 24-character hex id', 'VALIDATION_ERROR', 'orderId');
  const o: any = await Order.findById(req.params.orderId).lean();
  if (!o) return fail(res, 404, 'Order not found', 'NOT_FOUND', 'orderId');
  const refs = await loadRefs([o]);
  const summary = orderSummary(o, refs);

  successResponse(res, 200, 'Order fetched', {
    ...summary,
    customer: { ...summary.customer, phone: refs.users.get(String(o.user))?.phone ?? null },
    shippingAddress: o.shippingAddress ?? null, // null for store-pickup orders
    payment: {
      method: o.paymentMethod,
      status: o.paymentStatus,
      gatewayOrderId: o.razorpayOrderId ?? null,
      gatewayPaymentId: o.razorpayPaymentId ?? null,
    },
    statusUpdatedAt: o.statusUpdatedAt ?? null,
  });
});

// ---------- order-status webhook ----------

const webhookSchema = z.object({
  eventId: z.string().trim().min(1).max(100),
  orderId: objectId,
  erpOrderId: z.string().trim().min(1).max(100).optional(),
  status: z.enum(ORDER_STATUSES),
  trackingNumber: z.string().trim().min(1).max(100).optional(),
  occurredAt: isoDate,
}); // unknown fields are ignored so the ERP can add data without breaking delivery


// POST /erp/webhooks/order-status
export const orderStatusWebhook = asyncHandler(async (req: Request, res: Response) => {
  const parsed = webhookSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const e = parsed.data;
  const occurredAt = new Date(e.occurredAt);

  const prior = await ErpEvent.findOne({ eventId: e.eventId }).lean();
  if (prior) return successResponse(res, 200, 'Event already processed', { eventId: e.eventId, duplicate: true, outcome: prior.outcome });

  const order = await Order.findById(e.orderId);
  if (!order) return fail(res, 404, 'Order not found', 'NOT_FOUND', 'orderId');
  if (e.erpOrderId && order.erpOrderId && order.erpOrderId !== e.erpOrderId) {
    return fail(res, 409, 'erpOrderId does not match the ERP order already linked to this order', 'CONFLICT', 'erpOrderId');
  }

  const previousStatus = order.orderStatus;
  let outcome: 'applied' | 'unchanged' | 'stale';
  if (order.statusUpdatedAt && occurredAt <= order.statusUpdatedAt) outcome = 'stale';
  else if (e.status === previousStatus) outcome = 'unchanged';
  else if (canMove(previousStatus, e.status)) outcome = 'applied';
  else return fail(res, 409, `Order cannot move from ${previousStatus} to ${e.status}`, 'INVALID_TRANSITION', 'status');

  const set: Record<string, unknown> = {};
  if (e.erpOrderId) set.erpOrderId = e.erpOrderId;
  if (outcome !== 'stale') {
    set.statusUpdatedAt = occurredAt;
    if (e.trackingNumber) set.trackingNumber = e.trackingNumber;
  }
  if (outcome === 'applied') set.orderStatus = e.status;
  if (Object.keys(set).length) {
    // Conditional on what we decided from, so two racing events cannot both apply
    const r = await Order.updateOne(
      { _id: order._id, orderStatus: previousStatus, statusUpdatedAt: order.statusUpdatedAt ?? { $exists: false } },
      { $set: set }
    );
    if (!r.matchedCount) return fail(res, 409, 'Order changed while processing this event; retry it', 'CONFLICT');
  }

  await ErpEvent.create({ eventId: e.eventId, type: 'order-status', orderId: order._id, status: e.status, occurredAt, outcome, keyId: req.erpKeyId })
    .catch((err: any) => { if (err?.code !== 11000) throw err; });

  if (outcome === 'applied') {
    // One email per real change. Not awaited: a mail problem must never make the ERP redeliver the event.
    Order.findById(order._id).populate('user', 'name email role').populate('items.product', 'name images variants')
      .then((o) => o && sendOrderStatusEmail(o, e.status))
      .catch((err) => console.error('ERP status email failed:', err));
  }

  successResponse(res, 200, outcome === 'applied' ? 'Status updated' : 'Event recorded; status not changed', {
    eventId: e.eventId,
    orderId: String(order._id),
    previousStatus,
    orderStatus: outcome === 'applied' ? e.status : previousStatus,
    applied: outcome === 'applied',
    outcome,
    duplicate: false,
  });
});

// ---------- images ----------

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const EXT_KIND: Record<string, string> = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp' };
const MIME_KIND: Record<string, string> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** What the bytes actually are — the client's MIME type and file name are only claims. */
const sniff = (b: Buffer) =>
  b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpeg'
    : b.subarray(0, 8).equals(PNG_SIGNATURE) ? 'png'
      : b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' ? 'webp'
        : null;

/** Swappable in tests. Same Cloudinary folder as admin uploads; never local disk (not persistent on Render). */
export const imageStore = {
  configured: () => Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET),
  upload: (file: Buffer) => new Promise<string>((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ folder: 'luxygalleria_products', resource_type: 'image' }, (err, result) => (err || !result ? reject(err) : resolve(result.secure_url)))
      .end(file);
  }),
};

const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 } }).single('image');

/** Reads the multipart body into memory (signature covers the file bytes) and turns multer errors into API errors. */
export const readImage = (req: Request, res: Response, next: NextFunction) =>
  memoryUpload(req, res, (err: any) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return fail(res, 413, 'Image is larger than 15 MB', 'PAYLOAD_TOO_LARGE', 'image');
    return fail(res, 400, `Send exactly one file in the multipart field "image" (${err.message})`, 'VALIDATION_ERROR', 'image');
  });

// POST /erp/images
export const uploadImage = asyncHandler(async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) return fail(res, 400, 'Send the image as multipart/form-data in the field "image"', 'VALIDATION_ERROR', 'image');
  const kind = sniff(file.buffer);
  if (!kind || EXT_KIND[path.extname(file.originalname).toLowerCase()] !== kind || MIME_KIND[file.mimetype] !== kind) {
    return fail(res, 400, 'Only JPG, PNG or WEBP images are allowed, with matching file extension and content type', 'VALIDATION_ERROR', 'image');
  }
  if (!imageStore.configured()) return fail(res, 503, 'Image storage is not configured', 'UNAVAILABLE');

  let url: string;
  try {
    url = await imageStore.upload(file.buffer);
  } catch (err) {
    console.error('ERP image upload failed:', err);
    return fail(res, 502, 'Image storage failed; retry later', 'UPSTREAM_ERROR');
  }
  successResponse(res, 201, 'Image uploaded', { url, bytes: file.size, contentType: file.mimetype });
});
