import mongoose from 'mongoose';
import { Request, Response } from 'express';
import { Product } from '../models/Product';
import { Category } from '../models/Category';
import { Brand } from '../models/Brand';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';
import { parseWeightFromVolume } from '../utils/shippingCalculator';
import { escapeRegex } from './contactController';
import Order from '../models/Order';
import { CheckoutSession } from '../models/CheckoutSession';

const MAX_SKU_LENGTH = 64; // same limit as the ERP API's SKU rule (erpController)
const MAX_STOCK = 1_000_000;
/** Variant fields the admin product form may change on an existing variant. Never stock, stockAsOf or (here) sku. */
const EDITABLE_VARIANT_FIELDS = ['size', 'volume', 'flavor', 'offerPrice', 'actualPrice', 'price', 'oldPrice', 'weight', 'image', 'description', 'name'] as const;

/** A variant from the admin form in stored shape: legacy mirror fields kept in step, defaults as before. */
const normalizeVariant = (v: any) => {
  const size = v.size || v.volume || 'Standard';
  const parsedWeight = parseWeightFromVolume(size);
  const offerPrice = Number(v.offerPrice !== undefined ? v.offerPrice : (v.price || 0));
  const actualPrice = Number(v.actualPrice !== undefined ? v.actualPrice : (v.oldPrice || v.price || 0));
  return {
    ...v,
    size,
    flavor: v.flavor || 'Default',
    volume: size,
    offerPrice,
    actualPrice,
    price: offerPrice,
    oldPrice: actualPrice,
    weight: Number(v.weight !== undefined && v.weight > 0 ? v.weight : (parsedWeight !== null ? parsedWeight : 0)),
    stock: Number(v.stock !== undefined ? v.stock : 0),
    image: v.image || '',
    images: Array.isArray(v.images) ? v.images : (v.image ? [v.image] : []),
    sku: typeof v.sku === 'string' ? v.sku.trim() : '',
  };
};

/** Server-side variant rules, shared by create and update (the admin form checks the same, but is not trusted). */
const variantProblem = (v: ReturnType<typeof normalizeVariant>, label: string, { checkStock = true } = {}) => {
  if (!(Number.isFinite(v.offerPrice) && v.offerPrice > 0)) return `${label}: offer price must be greater than zero`;
  if (!Number.isFinite(v.actualPrice) || v.actualPrice < v.offerPrice) return `${label}: actual price (MRP) cannot be less than the offer price`;
  if (!Number.isFinite(v.weight) || v.weight < 0 || v.weight > 1000) return `${label}: weight must be between 0 and 1000 kg`;
  if (checkStock && !(Number.isInteger(v.stock) && v.stock >= 0 && v.stock <= MAX_STOCK)) return `${label}: stock must be a whole number, 0 or more`;
  if (v.sku.length > MAX_SKU_LENGTH) return `${label}: SKU must be at most ${MAX_SKU_LENGTH} characters`;
  return null;
};

/** New variant for $push / create: no client id, no ERP timestamp, no empty SKU. */
const freshVariant = (v: ReturnType<typeof normalizeVariant>) => {
  const { _id, stockAsOf, originalStock, ...fresh } = v;
  if (!fresh.sku) delete (fresh as any).sku;
  return fresh;
};

/**
 * SKUs (of those given) already carried by a variant anywhere in the catalogue. The ERP addresses exactly one variant
 * per SKU. Stored values are compared trimmed, so a legacy " ABC" still counts as ABC.
 */
const skusInUse = async (skus: string[]) => {
  if (!skus.length) return [];
  const patterns = skus.map((s) => new RegExp(`^\\s*${escapeRegex(s)}\\s*$`));
  const products = await Product.find({ 'variants.sku': { $in: patterns } }, { 'variants.sku': 1 }).lean();
  return [...new Set(products.flatMap((p: any) => p.variants.map((v: any) => (v.sku || '').trim()).filter((s: string) => skus.includes(s))))];
};

const skuConflict = async (res: Response, skus: string[]) => {
  if (new Set(skus).size !== skus.length) return errorResponse(res, 400, 'Each SKU may be used by only one variant', [{ code: 'DUPLICATE_SKU', field: 'sku' }]);
  const taken = await skusInUse(skus);
  if (taken.length) return errorResponse(res, 409, `SKU already used by another variant: ${taken.join(', ')}`, [{ code: 'DUPLICATE_SKU', field: 'sku', skus: taken }]);
  return null;
};

/** Variant ids (of those given) referenced by an order or an open checkout; removing them would orphan that history or reservation. */
const variantsInUse = async (ids: unknown[]) => {
  const [ordered, open] = await Promise.all([
    Order.distinct('items.variantId', { 'items.variantId': { $in: ids } }),
    CheckoutSession.distinct('items.variantId', { status: { $in: ['pending', 'processing'] }, 'items.variantId': { $in: ids } }),
  ]);
  const used = new Set([...ordered, ...open].map(String));
  return ids.filter((id) => used.has(String(id)));
};

export const createProduct = asyncHandler(async (req: Request, res: Response) => {
  let existingImages: string[] = [];
  if (req.body.images) {
    if (Array.isArray(req.body.images)) {
      existingImages = req.body.images;
    } else if (typeof req.body.images === 'string') {
      existingImages = [req.body.images];
    }
  }

  const fileUrls = (req.files && Array.isArray(req.files)) ? req.files.map(file => file.path) : [];
  const finalImages = [...existingImages, ...fileUrls];

  req.body.images = finalImages;

  // Handle variants parsing if sent as a string (from FormData)
  if (typeof req.body.variants === 'string') {
    try {
      req.body.variants = JSON.parse(req.body.variants);
    } catch (e) {
      // do nothing, let validator catch it
    }
  }

  // A product without variants cannot be priced, stocked, bought or addressed by the ERP
  if (!Array.isArray(req.body.variants) || req.body.variants.length === 0) {
    return errorResponse(res, 400, 'At least one variant is required');
  }
  const variants = req.body.variants.map((raw: any) => normalizeVariant(raw && typeof raw === 'object' ? raw : {}));
  for (const [i, v] of variants.entries()) {
    const problem = variantProblem(v, `Variant ${i + 1} (${v.size})`);
    if (problem) return errorResponse(res, 400, problem);
  }
  const conflict = await skuConflict(res, variants.map((v: any) => v.sku).filter(Boolean));
  if (conflict) return conflict;
  req.body.variants = variants.map(freshVariant);
  req.body.weight = req.body.variants[0].weight;
  req.body.stock = req.body.variants.reduce((acc: number, curr: any) => acc + curr.stock, 0);
  delete req.body._id;

  if (req.body.categoryId) {
    const categoryObj = await Category.findById(req.body.categoryId);
    if (categoryObj) {
      req.body.category = categoryObj.name;
    }
  } else if (req.body.categoryId === "") {
    delete req.body.categoryId;
  }

  if (req.body.brandId === "") {
    delete req.body.brandId;
  }

  const product = await Product.create(req.body);
  successResponse(res, 201, 'Product created successfully', product);
});

export const getProducts = asyncHandler(async (req: Request, res: Response) => {
  req.query.admin = 'true';
  // Temporary DB cleanup to prevent CastError on empty strings during populate
  try {
    await Product.collection.updateMany({ brandId: "" }, { $unset: { brandId: "" } });
    await Product.collection.updateMany({ categoryId: "" }, { $unset: { categoryId: "" } });
  } catch (err) {
    console.error("Cleanup error:", err);
  }

  const query: any = {};
  let sortQuery: any = { createdAt: -1 };

  // Parse filters
  if (req.query.categoryId) {
    query.categoryId = req.query.categoryId;
  } else if (req.query.category && req.query.category !== 'all') {
    const categorySlug = escapeRegex(req.query.category.toString().replace(/-/g, ' '));
    const matchedCat = await Category.findOne({ name: { $regex: new RegExp(`^${categorySlug}$`, 'i') } });
    if (matchedCat) {
      query.$or = [
        { categoryId: matchedCat._id },
        { category: { $regex: new RegExp(`^${escapeRegex(matchedCat.name)}$`, 'i') } }
      ];
    } else {
      query.category = { $regex: new RegExp(`^${categorySlug}$`, 'i') };
    }
  }

  // Collection flags (Gifting / New Arrivals)
  const collectionScope: any = {};
  if (req.query.gifting === 'true') {
    collectionScope.isGifting = true;
  }
  if (req.query.newArrival === 'true') {
    collectionScope.isNewArrival = true;
    // Gifting is exclusive: a Gifting product never shows under New Arrivals
    collectionScope.isGifting = { $ne: true };
  }
  // Main Shop / homepage: everything except Gifting, which lives exclusively on /gifting.
  // New Arrivals also show here.
  if (req.query.general === 'true') {
    collectionScope.isGifting = { $ne: true };
  }
  Object.assign(query, collectionScope);

  // Filter facets: the categories/brands that actually occur inside this
  // collection. Scoped to the collection flags only (not the current
  // category/brand selection) so the sidebar never offers a dead option.
  if (req.query.facets === 'true') {
    const [legacyNames, categoryIds, brandIds] = await Promise.all([
      Product.distinct('category', collectionScope),
      Product.distinct('categoryId', collectionScope),
      Product.distinct('brandId', collectionScope)
    ]);
    const [cats, brands] = await Promise.all([
      Category.find({ _id: { $in: categoryIds.filter(Boolean) }, status: 'ACTIVE' }),
      Brand.find({ _id: { $in: brandIds.filter(Boolean) }, status: 'ACTIVE' })
    ]);
    const categories = [...new Set([...legacyNames, ...cats.map(c => c.name)])]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return res.status(200).json({
      success: true,
      message: 'Product facets fetched successfully',
      data: {
        categories,
        brands: brands.map(b => b.name).sort((a, b) => a.localeCompare(b))
      }
    });
  }

  if (req.query.brandId) {
    query.brandId = req.query.brandId;
  } else if (req.query.brand && req.query.brand !== 'all') {
    const brandSlug = escapeRegex(req.query.brand.toString().replace(/-/g, ' '));
    const matchedBrand = await Brand.findOne({ name: { $regex: new RegExp(`^${brandSlug}$`, 'i') } });
    if (matchedBrand) {
      query.brandId = matchedBrand._id;
    } else {
      query.brandId = new mongoose.Types.ObjectId();
    }
  }

  // Price range
  if (req.query.minPrice !== undefined || req.query.maxPrice !== undefined) {
    const min = Number(req.query.minPrice) || 0;
    const max = Number(req.query.maxPrice) || Infinity;
    // $elemMatch so a single variant must satisfy both bounds, not two different ones
    query.variants = { $elemMatch: { offerPrice: { $gte: min, $lte: max } } };
  }

  // Active / Inactive check for public catalog (DISABLED TO SHOW ALL PRODUCTS)
  const isAdmin = req.query.admin === 'true' || !!req.headers.authorization;
  /* 
  if (!isAdmin) {
    const activeCategories = await Category.find({ status: 'ACTIVE' });
    const activeCategoryIds = activeCategories.map(c => c._id);
    const activeCategoryNames = activeCategories.map(c => c.name);

    const activeBrands = await Brand.find({ status: 'ACTIVE' });
    const activeBrandIds = activeBrands.map(b => b._id);

    query.$and = query.$and || [];
    query.$and.push({
      $or: [
        { categoryId: { $in: activeCategoryIds } },
        { categoryId: { $exists: false } },
        { categoryId: null }
      ]
    });
    query.$and.push({
      $or: [
        { brandId: { $in: activeBrandIds } },
        { brandId: { $exists: false } },
        { brandId: null }
      ]
    });
  }
  */

  // Search filter
  const searchTerm = req.query.search ? escapeRegex(req.query.search.toString().trim().slice(0, 100)) : '';
  if (searchTerm) {
    const matchingBrands = await Brand.find({ name: { $regex: searchTerm, $options: 'i' } });
    const matchingBrandIds = matchingBrands.map(b => b._id);

    const matchingCategories = await Category.find({ name: { $regex: searchTerm, $options: 'i' } });
    const matchingCategoryIds = matchingCategories.map(c => c._id);

    query.$and = query.$and || [];
    query.$and.push({
      $or: [
        { name: { $regex: searchTerm, $options: 'i' } },
        { category: { $regex: searchTerm, $options: 'i' } },
        { categoryId: { $in: matchingCategoryIds } },
        { brandId: { $in: matchingBrandIds } }
      ]
    });
  }

  // Sort logic
  const sortVal = req.query.sort;
  if (sortVal === 'priceAsc') {
    sortQuery = { 'variants.offerPrice': 1 };
  } else if (sortVal === 'priceDesc') {
    sortQuery = { 'variants.offerPrice': -1 };
  } else if (sortVal === 'rating') {
    sortQuery = { starRating: -1 };
  } else if (sortVal === 'newest') {
    sortQuery = { createdAt: -1 };
  } else if (sortVal === 'featured' && req.query.gifting === 'true') {
    // Order chosen by the admin on the Gifting page
    sortQuery = { giftingOrder: 1, createdAt: -1 };
  } else if (sortVal === 'featured' && req.query.newArrival === 'true') {
    sortQuery = { newArrivalOrder: 1, createdAt: -1 };
  }

  // Execute queries
  const page = req.query.page ? Number(req.query.page) : null;
  const limit = req.query.limit ? Number(req.query.limit) : null;

  let products;
  let total;
  let pages = 1;

  if (page || limit) {
    const pageNum = page || 1;
    const limitNum = limit || 8;
    const skip = (pageNum - 1) * limitNum;

    total = await Product.countDocuments(query);
    products = await Product.find(query)
      .populate('categoryId')
      .populate('brandId')
      .sort(sortQuery)
      .skip(skip)
      .limit(limitNum);
    pages = Math.ceil(total / limitNum);
  } else {
    total = await Product.countDocuments(query);
    products = await Product.find(query)
      .populate('categoryId')
      .populate('brandId')
      .sort(sortQuery);
  }

  return res.status(200).json({
    success: true,
    message: 'Products fetched successfully',
    data: products,
    pagination: {
      total,
      page: page || 1,
      pages,
      limit: limit || total || 1
    }
  });
});

/**
 * Updates a product without ever rewriting the variants array: existing variants are changed field by field by _id,
 * so their ids, current stock (checkout reservations, ERP figures) and ERP timestamps (stockAsOf) survive every edit.
 * Stock changes only by an explicit adjustment that names the value the admin saw (originalStock).
 */
export const updateProduct = asyncHandler(async (req: Request, res: Response) => {
  const product = await Product.findById(req.params.id);
  if (!product) {
    return errorResponse(res, 404, 'Product not found');
  }

  let existingImages: string[] = [];
  if (req.body.images) {
    if (Array.isArray(req.body.images)) {
      existingImages = req.body.images;
    } else if (typeof req.body.images === 'string') {
      existingImages = [req.body.images];
    }
  }

  const fileUrls = (req.files && Array.isArray(req.files)) ? req.files.map(file => file.path) : [];
  const finalImages = [...existingImages, ...fileUrls];

  req.body.images = finalImages;

  if (typeof req.body.variants === 'string') {
    try {
      req.body.variants = JSON.parse(req.body.variants);
    } catch (e) {
      // do nothing
    }
  }

  const fields: Record<string, any> = { ...req.body };
  const incoming = fields.variants;
  delete fields.variants;
  delete fields._id;
  delete fields.__v;
  delete fields.stock; // derived: the sum of the variants' stock
  const unset: Record<string, 1> = {};

  if (fields.categoryId) {
    const categoryObj = await Category.findById(fields.categoryId);
    if (categoryObj) {
      fields.category = categoryObj.name;
    }
  } else if (fields.categoryId === "") {
    delete fields.categoryId;
    unset.categoryId = 1;
  }

  if (fields.brandId === "") {
    delete fields.brandId;
    unset.brandId = 1;
  }

  const sets: Record<string, unknown> = {};
  const arrayFilters: Record<string, unknown>[] = [];
  const additions: any[] = [];
  const adjustments: { id: unknown; from: number; to: number }[] = [];
  const newSkus: string[] = [];
  let removedIds: unknown[] = [];

  if (incoming !== undefined) {
    if (!Array.isArray(incoming) || incoming.length === 0) return errorResponse(res, 400, 'At least one variant is required');
    const existingById = new Map(product.variants.map((v: any) => [String(v._id), v]));
    const kept = new Set<string>();

    for (const [i, raw] of incoming.entries()) {
      if (!raw || typeof raw !== 'object') return errorResponse(res, 400, `Variant ${i + 1} is invalid`);
      const v = normalizeVariant(raw);
      const label = `Variant ${i + 1} (${v.size})`;

      if (!raw._id) {
        const problem = variantProblem(v, label);
        if (problem) return errorResponse(res, 400, problem);
        const fresh = freshVariant(v);
        if (fresh.sku) newSkus.push(fresh.sku);
        additions.push(fresh);
        continue;
      }

      const existing: any = existingById.get(String(raw._id));
      if (!existing) return errorResponse(res, 400, `${label} does not belong to this product; reload it and try again`);
      if (kept.has(String(existing._id))) return errorResponse(res, 400, `${label} appears more than once`);
      kept.add(String(existing._id));
      const problem = variantProblem(v, label, { checkStock: false });
      if (problem) return errorResponse(res, 400, problem);

      const f = `v${i}`;
      arrayFilters.push({ [`${f}._id`]: existing._id });
      for (const key of EDITABLE_VARIANT_FIELDS) if (v[key] !== undefined) sets[`variants.$[${f}].${key}`] = v[key];

      // SKU: may be set once on a variant that has none; an existing ERP item code is never overwritten or cleared here.
      // Compared trimmed: stray spaces on a stored SKU are not a change, and a spaces-only SKU counts as none.
      const currentSku = (existing.sku || '').trim();
      if (raw.sku !== undefined && v.sku !== currentSku) {
        if (currentSku) {
          return errorResponse(res, 409, `${label} already has SKU "${currentSku}"; it cannot be changed or removed here`, [{ code: 'SKU_LOCKED', field: `variants.${i}.sku` }]);
        }
        sets[`variants.$[${f}].sku`] = v.sku;
        newSkus.push(v.sku);
      }

      // Stock: only an explicit adjustment, refused if the stock moved since the admin loaded it. Never touches stockAsOf.
      if (raw.originalStock !== undefined && raw.stock !== undefined && Number(raw.stock) !== Number(raw.originalStock)) {
        const from = Number(raw.originalStock);
        const to = Number(raw.stock);
        if (!(Number.isInteger(to) && to >= 0 && to <= MAX_STOCK)) return errorResponse(res, 400, `${label}: stock must be a whole number, 0 or more`);
        if (from !== existing.stock) {
          return errorResponse(res, 409, `${label}: stock is now ${existing.stock} (changed by orders or ERP sync since you opened this product). Reload and adjust again`, [{ code: 'STOCK_CHANGED', field: `variants.${i}.stock`, current: existing.stock }]);
        }
        adjustments.push({ id: existing._id, from, to });
      }
    }

    const removed = product.variants.filter((v: any) => !kept.has(String(v._id)));
    const inUse = await variantsInUse(removed.map((v: any) => v._id));
    if (inUse.length) {
      const names = removed.filter((v: any) => inUse.some((id) => String(id) === String(v._id))).map((v: any) => v.size || v.volume);
      return errorResponse(res, 409, `Cannot remove ${names.join(', ')}: part of existing orders or an open checkout`, [{ code: 'VARIANT_IN_USE', variantIds: inUse.map(String) }]);
    }
    removedIds = removed.map((v: any) => v._id);

    const conflict = await skuConflict(res, newSkus);
    if (conflict) return conflict;
  }

  // Explicit stock adjustments first: one conditional write each, so a concurrent checkout or ERP update is never overwritten
  for (const a of adjustments) {
    const r = await Product.updateOne(
      { _id: product._id, variants: { $elemMatch: { _id: a.id, stock: a.from } } },
      { $set: { 'variants.$.stock': a.to } }
    );
    if (!r.matchedCount) return errorResponse(res, 409, 'Stock changed while saving; reload and adjust again', [{ code: 'STOCK_CHANGED' }]);
  }

  await Product.updateOne(
    { _id: product._id },
    { $set: { ...fields, ...sets }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    { arrayFilters, runValidators: true }
  );
  if (removedIds.length) {
    // __v bump: a concurrent ERP save that addressed variants by position must fail rather than hit a shifted variant
    await Product.updateOne({ _id: product._id }, { $pull: { variants: { _id: { $in: removedIds } } }, $inc: { __v: 1 } });
  }
  if (additions.length) {
    await Product.updateOne({ _id: product._id }, { $push: { variants: { $each: additions } } }, { runValidators: true });
  }
  if (incoming !== undefined) {
    await Product.updateOne({ _id: product._id }, [{ $set: { stock: { $sum: '$variants.stock' }, weight: { $ifNull: [{ $arrayElemAt: ['$variants.weight', 0] }, 0] } } }]);
  }

  successResponse(res, 200, 'Product updated successfully', await Product.findById(product._id));
});

// Replaces a whole collection (Gifting / New Arrivals) in one call; array order becomes the display order.
// Gifting is exclusive: adding a product to Gifting removes it from New Arrivals,
// and Gifting products are refused when saving New Arrivals.
const setCollectionProducts = (flag: 'isGifting' | 'isNewArrival', orderField: 'giftingOrder' | 'newArrivalOrder') =>
  asyncHandler(async (req: Request, res: Response) => {
    const { productIds } = req.body;
    if (!Array.isArray(productIds) || !productIds.every(id => typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id))) {
      return errorResponse(res, 400, 'productIds must be an array of product IDs');
    }
    const ids = [...new Set(productIds as string[])].map(id => new mongoose.Types.ObjectId(id));

    if (flag === 'isNewArrival') {
      const conflicts = await Product.find({ _id: { $in: ids }, isGifting: true }).select('name').lean();
      if (conflicts.length > 0) {
        return errorResponse(res, 400, `Already in Gifting (remove from Gifting first): ${conflicts.map(p => p.name).join(', ')}`);
      }
    }
    const exclusive = flag === 'isGifting' ? { isNewArrival: false, newArrivalOrder: 0 } : {};

    await Product.bulkWrite([
      { updateMany: { filter: { _id: { $nin: ids }, [flag]: true }, update: { $set: { [flag]: false, [orderField]: 0 } } } },
      ...ids.map((_id, index) => ({ updateOne: { filter: { _id }, update: { $set: { [flag]: true, [orderField]: index, ...exclusive } } } })),
    ]);

    const products = await Product.find({ [flag]: true }).sort({ [orderField]: 1 });
    successResponse(res, 200, 'Collection updated successfully', products);
  });

export const setGiftingProducts = setCollectionProducts('isGifting', 'giftingOrder');
export const setNewArrivalProducts = setCollectionProducts('isNewArrival', 'newArrivalOrder');

export const deleteProduct = asyncHandler(async (req: Request, res: Response) => {
  const product = await Product.findById(req.params.id);
  if (!product) {
    return errorResponse(res, 404, 'Product not found');
  }
  // Orders and open checkouts point at its variants; deleting it would orphan order history and held stock
  if ((await variantsInUse(product.variants.map((v: any) => v._id))).length) {
    return errorResponse(res, 409, 'This product is part of existing orders or an open checkout and cannot be deleted. Set its stock to 0 to stop selling it.', [{ code: 'PRODUCT_IN_USE' }]);
  }
  await Product.deleteOne({ _id: product._id });
  successResponse(res, 200, 'Product deleted successfully', null);
});
