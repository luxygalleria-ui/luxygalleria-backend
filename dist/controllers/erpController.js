"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadImage = exports.readImage = exports.imageStore = exports.orderStatusWebhook = exports.getOrder = exports.listOrders = exports.updateStock = exports.patchItem = exports.upsertItem = void 0;
const path_1 = __importDefault(require("path"));
const mongoose_1 = __importDefault(require("mongoose"));
const multer_1 = __importDefault(require("multer"));
const cloudinary_1 = require("cloudinary");
const zod_1 = require("zod");
const Product_1 = require("../models/Product");
const Category_1 = require("../models/Category");
const Brand_1 = require("../models/Brand");
const User_1 = require("../models/User");
const Order_1 = __importDefault(require("../models/Order"));
const ErpEvent_1 = require("../models/ErpEvent");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
const shippingCalculator_1 = require("../utils/shippingCalculator");
const contactController_1 = require("./contactController");
const paymentController_1 = require("./paymentController");
// ---------- shared ----------
const fail = (res, status, message, code, field) => (0, responseHandler_1.errorResponse)(res, status, message, [{ code, ...(field ? { field } : {}) }]);
const invalid = (res, err) => (0, responseHandler_1.errorResponse)(res, 400, 'Validation failed', err.issues.map((i) => ({
    field: i.path.join('.') || undefined, code: 'VALIDATION_ERROR', message: i.message,
})));
const objectId = zod_1.z.string().regex(/^[a-f\d]{24}$/i, 'must be a 24-character hex id');
const isoDate = zod_1.z.string().datetime({ offset: true, message: 'must be an ISO 8601 timestamp, e.g. 2026-10-17T10:00:00Z' });
const sku = zod_1.z.string().trim().min(1).max(64);
const money = zod_1.z.number().finite().min(0).max(10_000_000);
const httpsUrl = zod_1.z.string().trim().url().max(2048).refine((u) => u.startsWith('https://'), 'must be an https URL');
const ORDER_STATUSES = ['processing', 'shipped', 'delivered', 'cancelled'];
const PAYMENT_STATUSES = ['pending', 'completed', 'failed', 'refunded'];
// Stock updates keep the product-level total equal to the sum of its variants, in one atomic write.
const syncProductStock = (id) => Product_1.Product.updateOne({ _id: id }, [{ $set: { stock: { $sum: '$variants.stock' } } }]);
/** The one variant carrying this SKU. Several carriers mean bad data the ERP must not paper over. */
const findSku = async (code) => {
    const products = await Product_1.Product.find({ 'variants.sku': code });
    const hits = products.flatMap((product) => product.variants.filter((v) => v.sku === code).map((variant) => ({ product, variant })));
    return hits;
};
const skuLookupError = (res, code, count) => count === 0
    ? fail(res, 404, `SKU not found: ${code}`, 'NOT_FOUND', 'sku')
    : fail(res, 409, `SKU ${code} is used by ${count} website variants; fix the duplicate before syncing`, 'DUPLICATE_SKU', 'sku');
// ---------- items ----------
const variantFields = {
    size: zod_1.z.string().trim().min(1).max(50).optional(),
    volume: zod_1.z.string().trim().min(1).max(50).optional(),
    flavor: zod_1.z.string().trim().min(1).max(50).optional(),
    offerPrice: money.optional(),
    actualPrice: money.optional(),
    weight: zod_1.z.number().finite().min(0).max(1000).optional(), // kg
    image: httpsUrl.optional(),
};
const productFields = {
    name: zod_1.z.string().trim().min(1).max(200).optional(),
    description: zod_1.z.string().trim().min(1).max(5000).optional(),
    category: zod_1.z.string().trim().min(1).max(100).optional(), // name or id
    brand: zod_1.z.string().trim().min(1).max(100).optional(), // name
    brandId: objectId.optional(),
    imageUrls: zod_1.z.array(httpsUrl).max(10).optional(),
};
const upsertSchema = zod_1.z.object({
    ...productFields,
    variants: zod_1.z.array(zod_1.z.object({ sku, ...variantFields, stock: zod_1.z.number().int().min(0).max(1_000_000).optional() }).strict()).min(1).max(50),
}).strict();
const patchSchema = zod_1.z.object({ ...productFields, ...variantFields }).strict()
    .refine((o) => Object.keys(o).length > 0, 'send at least one field to change');
const byName = (Model, name) => Model.findOne({ name: { $regex: `^${(0, contactController_1.escapeRegex)(name)}$`, $options: 'i' } });
/** Product-level fields to set, with category/brand resolved to website records. Only supplied fields appear. */
const productUpdate = async (input) => {
    const fields = {};
    if (input.name !== undefined)
        fields.name = input.name;
    if (input.description !== undefined)
        fields.description = input.description;
    if (input.imageUrls !== undefined)
        fields.images = input.imageUrls;
    if (input.category !== undefined) {
        const cat = /^[a-f\d]{24}$/i.test(input.category) ? await Category_1.Category.findById(input.category) : await byName(Category_1.Category, input.category);
        if (!cat)
            return { error: ['category', `Unknown category: ${input.category}`] };
        fields.category = cat.name;
        fields.categoryId = cat._id;
    }
    if (input.brandId !== undefined || input.brand !== undefined) {
        const brand = input.brandId ? await Brand_1.Brand.findById(input.brandId) : await byName(Brand_1.Brand, input.brand);
        if (!brand)
            return { error: [input.brandId ? 'brandId' : 'brand', 'Unknown brand'] };
        fields.brandId = brand._id;
    }
    return { fields };
};
/** Applies supplied variant fields, keeping the legacy mirror fields (volume/price/oldPrice) in step. Never touches stock. */
const applyVariant = (v, input) => {
    const size = input.size ?? input.volume;
    if (size !== undefined) {
        v.size = size;
        v.volume = size;
    }
    if (input.flavor !== undefined)
        v.flavor = input.flavor;
    if (input.offerPrice !== undefined) {
        v.offerPrice = input.offerPrice;
        v.price = input.offerPrice;
    }
    if (input.actualPrice !== undefined) {
        v.actualPrice = input.actualPrice;
        v.oldPrice = input.actualPrice;
    }
    if (input.weight !== undefined)
        v.weight = input.weight;
    if (input.image !== undefined)
        v.image = input.image;
};
const priceProblem = (v, input) => (input.offerPrice !== undefined || input.actualPrice !== undefined) && v.offerPrice > v.actualPrice
    ? 'offerPrice cannot be higher than actualPrice (MRP)' : null;
const variantSummary = (v) => ({
    sku: v.sku, variantId: String(v._id), size: v.size || v.volume, flavor: v.flavor,
    offerPrice: v.offerPrice, actualPrice: v.actualPrice, stock: v.stock, weight: v.weight, image: v.image || null,
});
// POST /erp/items — create, or update the product that already carries these SKUs
exports.upsertItem = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const parsed = upsertSchema.safeParse(req.body);
    if (!parsed.success)
        return invalid(res, parsed.error);
    const input = parsed.data;
    const skus = input.variants.map((v) => v.sku);
    if (new Set(skus).size !== skus.length)
        return fail(res, 400, 'Each SKU may appear only once per request', 'VALIDATION_ERROR', 'variants');
    const products = await Product_1.Product.find({ 'variants.sku': { $in: skus } });
    for (const code of skus) {
        const count = products.reduce((n, p) => n + p.variants.filter((v) => v.sku === code).length, 0);
        if (count > 1)
            return skuLookupError(res, code, count);
    }
    if (products.length > 1)
        return fail(res, 409, 'These SKUs belong to different website products; send them separately', 'CONFLICT', 'variants');
    const update = await productUpdate(input);
    if ('error' in update)
        return fail(res, 400, update.error[1], 'VALIDATION_ERROR', update.error[0]);
    const isNew = products.length === 0;
    if (isNew) {
        const missing = ['name', 'description', 'category'].filter((f) => input[f] === undefined);
        if (missing.length) {
            return (0, responseHandler_1.errorResponse)(res, 400, 'Validation failed', missing.map((field) => ({ field, code: 'VALIDATION_ERROR', message: 'required when creating an item' })));
        }
    }
    const product = isNew ? new Product_1.Product({ ...update.fields, variants: [] }) : products[0];
    if (!isNew)
        product.set(update.fields);
    const created = [];
    const actions = {};
    for (const [i, vin] of input.variants.entries()) {
        const existing = product.variants.find((v) => v.sku === vin.sku);
        if (existing) {
            applyVariant(existing, vin); // stock of an existing variant changes only through PUT /erp/stock
            const problem = priceProblem(existing, vin);
            if (problem)
                return fail(res, 400, problem, 'VALIDATION_ERROR', `variants.${i}.offerPrice`);
            actions[vin.sku] = 'updated';
            continue;
        }
        if (vin.offerPrice === undefined || vin.actualPrice === undefined) {
            return fail(res, 400, 'offerPrice and actualPrice are required for a new variant', 'VALIDATION_ERROR', `variants.${i}`);
        }
        if (vin.offerPrice > vin.actualPrice)
            return fail(res, 400, 'offerPrice cannot be higher than actualPrice (MRP)', 'VALIDATION_ERROR', `variants.${i}.offerPrice`);
        const size = vin.size ?? vin.volume ?? 'Standard';
        created.push({
            sku: vin.sku, size, volume: size, flavor: vin.flavor ?? 'Default',
            offerPrice: vin.offerPrice, price: vin.offerPrice, actualPrice: vin.actualPrice, oldPrice: vin.actualPrice,
            stock: vin.stock ?? 0, weight: vin.weight ?? (0, shippingCalculator_1.parseWeightFromVolume)(size) ?? 0, image: vin.image ?? '',
        });
        actions[vin.sku] = 'created';
    }
    if (isNew) {
        product.variants.push(...created);
        product.weight = product.variants[0].weight;
        await product.save();
    }
    else {
        // Two saves so Mongoose issues targeted $set / $push, never a whole-array write that could undo a checkout's stock decrement
        await product.save();
        if (created.length) {
            product.variants.push(...created);
            await product.save();
        }
    }
    await syncProductStock(product._id);
    return (0, responseHandler_1.successResponse)(res, isNew ? 201 : 200, isNew ? 'Item created' : 'Item updated', {
        productId: String(product._id),
        action: isNew ? 'created' : 'updated',
        variants: product.variants.filter((v) => actions[v.sku]).map((v) => ({ ...variantSummary(v), action: actions[v.sku] })),
    });
});
// PATCH /erp/items/:sku — change only the supplied fields of this variant and its product
exports.patchItem = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success)
        return invalid(res, parsed.error);
    const input = parsed.data;
    const code = req.params.sku.trim();
    const hits = await findSku(code);
    if (hits.length !== 1)
        return skuLookupError(res, code, hits.length);
    const { product, variant } = hits[0];
    const update = await productUpdate(input);
    if ('error' in update)
        return fail(res, 400, update.error[1], 'VALIDATION_ERROR', update.error[0]);
    product.set(update.fields);
    applyVariant(variant, input);
    const problem = priceProblem(variant, input);
    if (problem)
        return fail(res, 400, problem, 'VALIDATION_ERROR', 'offerPrice');
    await product.save();
    return (0, responseHandler_1.successResponse)(res, 200, 'Item updated', {
        productId: String(product._id),
        name: product.name,
        category: product.category,
        images: product.images,
        updatedFields: Object.keys(input),
        variant: variantSummary(variant),
    });
});
// ---------- stock ----------
const stockSchema = zod_1.z.object({
    quantity: zod_1.z.number().int().min(0).max(1_000_000),
    asOf: isoDate,
}).strict();
/** Units of this variant in website orders placed after the ERP's snapshot — not yet reflected in its figure. */
const pendingQuantity = async (variantId, since) => {
    const id = new mongoose_1.default.Types.ObjectId(String(variantId));
    const [row] = await Order_1.default.aggregate([
        { $match: { createdAt: { $gt: since }, orderStatus: { $ne: 'cancelled' }, 'items.variantId': id } },
        { $unwind: '$items' },
        { $match: { 'items.variantId': id } },
        { $group: { _id: null, qty: { $sum: '$items.quantity' } } },
    ]);
    return row?.qty || 0;
};
// PUT /erp/stock/:sku — absolute sellable quantity for one variant
exports.updateStock = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const parsed = stockSchema.safeParse(req.body);
    if (!parsed.success)
        return invalid(res, parsed.error);
    const asOf = new Date(parsed.data.asOf);
    if (asOf.getTime() > Date.now() + 5 * 60 * 1000)
        return fail(res, 400, 'asOf is in the future', 'VALIDATION_ERROR', 'asOf');
    const code = req.params.sku.trim();
    const hits = await findSku(code);
    if (hits.length !== 1)
        return skuLookupError(res, code, hits.length);
    const { product, variant } = hits[0];
    // ponytail: provisional reconcile rule (ERP to confirm). A checkout landing between this read and the
    // write below can be counted twice (under-sells, never over-sells); a transaction removes that window.
    const pending = await pendingQuantity(variant._id, asOf);
    const quantity = Math.max(0, parsed.data.quantity - pending);
    // Only this variant's stock, and only if no newer ERP figure was applied — checkout's $inc on other fields is untouched.
    const r = await Product_1.Product.updateOne({ _id: product._id, variants: { $elemMatch: { _id: variant._id, sku: code, $or: [{ stockAsOf: { $exists: false } }, { stockAsOf: null }, { stockAsOf: { $lt: asOf } }] } } }, { $set: { 'variants.$.stock': quantity, 'variants.$.stockAsOf': asOf } });
    const base = { sku: code, productId: String(product._id), variantId: String(variant._id), asOf: asOf.toISOString() };
    if (!r.matchedCount) {
        const current = (await Product_1.Product.findById(product._id))?.variants.find((v) => String(v._id) === String(variant._id));
        if (current?.stockAsOf && current.stockAsOf.getTime() === asOf.getTime()) {
            // Same update delivered again: answer as before, change nothing
            return (0, responseHandler_1.successResponse)(res, 200, 'Stock already at this update', { ...base, previousQuantity: current.stock, quantity: current.stock, applied: false, updatedAt: new Date().toISOString() });
        }
        return (0, responseHandler_1.errorResponse)(res, 409, 'A newer stock update has already been applied', [{ code: 'STALE_UPDATE', field: 'asOf', currentAsOf: current?.stockAsOf?.toISOString() ?? null }]);
    }
    await syncProductStock(product._id);
    return (0, responseHandler_1.successResponse)(res, 200, 'Stock updated', {
        ...base,
        previousQuantity: variant.stock,
        quantity,
        erpQuantity: parsed.data.quantity,
        pendingOrderQuantity: pending,
        applied: true,
        updatedAt: new Date().toISOString(),
    });
});
// ---------- orders ----------
const listSchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(50),
    status: zod_1.z.enum(ORDER_STATUSES).optional(),
    paymentStatus: zod_1.z.enum(PAYMENT_STATUSES).optional(),
    updatedSince: isoDate.optional(),
}).strict();
/** Loads referenced products/users ourselves so ids survive even when the referenced record was deleted. */
const loadRefs = async (orders) => {
    const productIds = [...new Set(orders.flatMap((o) => o.items.map((i) => String(i.product))))];
    const userIds = [...new Set(orders.map((o) => String(o.user)))];
    const [products, users] = await Promise.all([
        Product_1.Product.find({ _id: { $in: productIds } }).select('name variants._id variants.sku').lean(),
        User_1.User.find({ _id: { $in: userIds } }).select('name email phone').lean(),
    ]);
    return {
        products: new Map(products.map((p) => [String(p._id), p])),
        users: new Map(users.map((u) => [String(u._id), u])),
    };
};
const orderLines = (order, products) => order.items.map((it) => {
    const p = products.get(String(it.product));
    const v = p?.variants?.find((x) => String(x._id) === String(it.variantId));
    return {
        productId: String(it.product),
        variantId: String(it.variantId),
        sku: v?.sku || null, // current SKU of the variant; not stored on the order
        name: p?.name ?? null,
        size: it.size ?? null,
        quantity: it.quantity,
        unitPrice: it.price,
        lineTotal: it.subtotal ?? it.price * it.quantity,
    };
});
const orderSummary = (o, refs) => {
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
        customer: { customerId: String(o.user), name: u?.name ?? null, email: u?.email ?? null },
        items: orderLines(o, refs.products),
        erp: { erpOrderId: o.erpOrderId ?? null, trackingNumber: o.trackingNumber ?? null },
    };
};
// GET /erp/orders
exports.listOrders = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success)
        return invalid(res, parsed.error);
    const { page, limit, status, paymentStatus, updatedSince } = parsed.data;
    const filter = {};
    if (status)
        filter.orderStatus = status;
    if (paymentStatus)
        filter.paymentStatus = paymentStatus;
    if (updatedSince)
        filter.updatedAt = { $gte: new Date(updatedSince) };
    const [total, orders] = await Promise.all([
        Order_1.default.countDocuments(filter),
        Order_1.default.find(filter).sort({ updatedAt: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
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
exports.getOrder = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!/^[a-f\d]{24}$/i.test(req.params.orderId))
        return fail(res, 400, 'orderId must be a 24-character hex id', 'VALIDATION_ERROR', 'orderId');
    const o = await Order_1.default.findById(req.params.orderId).lean();
    if (!o)
        return fail(res, 404, 'Order not found', 'NOT_FOUND', 'orderId');
    const refs = await loadRefs([o]);
    const summary = orderSummary(o, refs);
    (0, responseHandler_1.successResponse)(res, 200, 'Order fetched', {
        ...summary,
        customer: { ...summary.customer, phone: refs.users.get(String(o.user))?.phone ?? null },
        shippingAddress: o.shippingAddress,
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
const webhookSchema = zod_1.z.object({
    eventId: zod_1.z.string().trim().min(1).max(100),
    orderId: objectId,
    erpOrderId: zod_1.z.string().trim().min(1).max(100).optional(),
    status: zod_1.z.enum(ORDER_STATUSES),
    trackingNumber: zod_1.z.string().trim().min(1).max(100).optional(),
    occurredAt: isoDate,
}); // unknown fields are ignored so the ERP can add data without breaking delivery
const RANK = { processing: 0, shipped: 1, delivered: 2 };
/** Forward only; cancel allowed until delivered; delivered and cancelled are final. */
const canMove = (from, to) => to === 'cancelled' ? from === 'processing' || from === 'shipped' : from !== 'cancelled' && RANK[to] > RANK[from];
// POST /erp/webhooks/order-status
exports.orderStatusWebhook = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const parsed = webhookSchema.safeParse(req.body);
    if (!parsed.success)
        return invalid(res, parsed.error);
    const e = parsed.data;
    const occurredAt = new Date(e.occurredAt);
    const prior = await ErpEvent_1.ErpEvent.findOne({ eventId: e.eventId }).lean();
    if (prior)
        return (0, responseHandler_1.successResponse)(res, 200, 'Event already processed', { eventId: e.eventId, duplicate: true, outcome: prior.outcome });
    const order = await Order_1.default.findById(e.orderId);
    if (!order)
        return fail(res, 404, 'Order not found', 'NOT_FOUND', 'orderId');
    if (e.erpOrderId && order.erpOrderId && order.erpOrderId !== e.erpOrderId) {
        return fail(res, 409, 'erpOrderId does not match the ERP order already linked to this order', 'CONFLICT', 'erpOrderId');
    }
    const previousStatus = order.orderStatus;
    let outcome;
    if (order.statusUpdatedAt && occurredAt <= order.statusUpdatedAt)
        outcome = 'stale';
    else if (e.status === previousStatus)
        outcome = 'unchanged';
    else if (canMove(previousStatus, e.status))
        outcome = 'applied';
    else
        return fail(res, 409, `Order cannot move from ${previousStatus} to ${e.status}`, 'INVALID_TRANSITION', 'status');
    const set = {};
    if (e.erpOrderId)
        set.erpOrderId = e.erpOrderId;
    if (outcome !== 'stale') {
        set.statusUpdatedAt = occurredAt;
        if (e.trackingNumber)
            set.trackingNumber = e.trackingNumber;
    }
    if (outcome === 'applied')
        set.orderStatus = e.status;
    if (Object.keys(set).length) {
        // Conditional on what we decided from, so two racing events cannot both apply
        const r = await Order_1.default.updateOne({ _id: order._id, orderStatus: previousStatus, statusUpdatedAt: order.statusUpdatedAt ?? { $exists: false } }, { $set: set });
        if (!r.matchedCount)
            return fail(res, 409, 'Order changed while processing this event; retry it', 'CONFLICT');
    }
    await ErpEvent_1.ErpEvent.create({ eventId: e.eventId, type: 'order-status', orderId: order._id, status: e.status, occurredAt, outcome, keyId: req.erpKeyId })
        .catch((err) => { if (err?.code !== 11000)
        throw err; });
    if (outcome === 'applied') {
        // One email per real change. Not awaited: a mail problem must never make the ERP redeliver the event.
        Order_1.default.findById(order._id).populate('user', 'name email role').populate('items.product', 'name images variants')
            .then((o) => o && (0, paymentController_1.sendOrderStatusEmail)(o, e.status))
            .catch((err) => console.error('ERP status email failed:', err));
    }
    (0, responseHandler_1.successResponse)(res, 200, outcome === 'applied' ? 'Status updated' : 'Event recorded; status not changed', {
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
const EXT_KIND = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp' };
const MIME_KIND = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** What the bytes actually are — the client's MIME type and file name are only claims. */
const sniff = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpeg'
    : b.subarray(0, 8).equals(PNG_SIGNATURE) ? 'png'
        : b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' ? 'webp'
            : null;
/** Swappable in tests. Same Cloudinary folder as admin uploads; never local disk (not persistent on Render). */
exports.imageStore = {
    configured: () => Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET),
    upload: (file) => new Promise((resolve, reject) => {
        cloudinary_1.v2.uploader
            .upload_stream({ folder: 'luxygalleria_products', resource_type: 'image' }, (err, result) => (err || !result ? reject(err) : resolve(result.secure_url)))
            .end(file);
    }),
};
const memoryUpload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 } }).single('image');
/** Reads the multipart body into memory (signature covers the file bytes) and turns multer errors into API errors. */
const readImage = (req, res, next) => memoryUpload(req, res, (err) => {
    if (!err)
        return next();
    if (err.code === 'LIMIT_FILE_SIZE')
        return fail(res, 413, 'Image is larger than 15 MB', 'PAYLOAD_TOO_LARGE', 'image');
    return fail(res, 400, `Send exactly one file in the multipart field "image" (${err.message})`, 'VALIDATION_ERROR', 'image');
});
exports.readImage = readImage;
// POST /erp/images
exports.uploadImage = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const file = req.file;
    if (!file)
        return fail(res, 400, 'Send the image as multipart/form-data in the field "image"', 'VALIDATION_ERROR', 'image');
    const kind = sniff(file.buffer);
    if (!kind || EXT_KIND[path_1.default.extname(file.originalname).toLowerCase()] !== kind || MIME_KIND[file.mimetype] !== kind) {
        return fail(res, 400, 'Only JPG, PNG or WEBP images are allowed, with matching file extension and content type', 'VALIDATION_ERROR', 'image');
    }
    if (!exports.imageStore.configured())
        return fail(res, 503, 'Image storage is not configured', 'UNAVAILABLE');
    let url;
    try {
        url = await exports.imageStore.upload(file.buffer);
    }
    catch (err) {
        console.error('ERP image upload failed:', err);
        return fail(res, 502, 'Image storage failed; retry later', 'UPSTREAM_ERROR');
    }
    (0, responseHandler_1.successResponse)(res, 201, 'Image uploaded', { url, bytes: file.size, contentType: file.mimetype });
});
//# sourceMappingURL=erpController.js.map