import mongoose from 'mongoose';
import { Request, Response } from 'express';
import { Product } from '../models/Product';
import { Category } from '../models/Category';
import { Brand } from '../models/Brand';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';
import { parseWeightFromVolume } from '../utils/shippingCalculator';

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

  if (req.body.variants && Array.isArray(req.body.variants)) {
    req.body.variants = req.body.variants.map((v: any) => {
      const size = v.size || v.volume || 'Standard';
      const flavor = v.flavor || 'Default';
      const volume = size;
      const parsedWeight = parseWeightFromVolume(size);
      const offerPrice = Number(v.offerPrice !== undefined ? v.offerPrice : (v.price || 0));
      const actualPrice = Number(v.actualPrice !== undefined ? v.actualPrice : (v.oldPrice || v.price || 0));
      const weight = Number(v.weight !== undefined && v.weight > 0 ? v.weight : (parsedWeight !== null ? parsedWeight : 0));
      const stock = Number(v.stock !== undefined ? v.stock : 0);
      const sku = v.sku || '';
      const image = v.image || '';
      const images = Array.isArray(v.images) ? v.images : (v.image ? [v.image] : []);
      return {
        ...v,
        size,
        flavor,
        volume,
        offerPrice,
        actualPrice,
        price: offerPrice,
        oldPrice: actualPrice,
        weight,
        stock,
        image,
        images,
        sku
      };
    });
    if (req.body.variants.length > 0) {
      req.body.weight = req.body.variants[0].weight;
      req.body.stock = req.body.variants.reduce((acc: number, curr: any) => acc + curr.stock, 0);
    }
  }

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
    const categorySlug = req.query.category.toString().replace(/-/g, ' ');
    const matchedCat = await Category.findOne({ name: { $regex: new RegExp(`^${categorySlug}$`, 'i') } });
    if (matchedCat) {
      query.$or = [
        { categoryId: matchedCat._id },
        { category: { $regex: new RegExp(`^${matchedCat.name}$`, 'i') } }
      ];
    } else {
      query.category = { $regex: new RegExp(`^${categorySlug}$`, 'i') };
    }
  }

  if (req.query.brandId) {
    query.brandId = req.query.brandId;
  } else if (req.query.brand && req.query.brand !== 'all') {
    const brandSlug = req.query.brand.toString().replace(/-/g, ' ');
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
    query['variants.offerPrice'] = { $gte: min, $lte: max };
  }

  // Active / Inactive check for public catalog
  const isAdmin = req.query.admin === 'true' || !!req.headers.authorization;
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

  // Search filter
  const searchTerm = req.query.search ? req.query.search.toString().trim() : '';
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

export const updateProduct = asyncHandler(async (req: Request, res: Response) => {
  let product = await Product.findById(req.params.id);
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

  if (req.body.variants && Array.isArray(req.body.variants)) {
    req.body.variants = req.body.variants.map((v: any) => {
      const size = v.size || v.volume || 'Standard';
      const flavor = v.flavor || 'Default';
      const volume = size;
      const parsedWeight = parseWeightFromVolume(size);
      const offerPrice = Number(v.offerPrice !== undefined ? v.offerPrice : (v.price || 0));
      const actualPrice = Number(v.actualPrice !== undefined ? v.actualPrice : (v.oldPrice || v.price || 0));
      const weight = Number(v.weight !== undefined && v.weight > 0 ? v.weight : (parsedWeight !== null ? parsedWeight : 0));
      const stock = Number(v.stock !== undefined ? v.stock : 0);
      const sku = v.sku || '';
      const image = v.image || '';
      const images = Array.isArray(v.images) ? v.images : (v.image ? [v.image] : []);
      return {
        ...v,
        size,
        flavor,
        volume,
        offerPrice,
        actualPrice,
        price: offerPrice,
        oldPrice: actualPrice,
        weight,
        stock,
        image,
        images,
        sku
      };
    });
    if (req.body.variants.length > 0) {
      req.body.weight = req.body.variants[0].weight;
      req.body.stock = req.body.variants.reduce((acc: number, curr: any) => acc + curr.stock, 0);
    }
  }
  
  if (req.body.categoryId) {
    const categoryObj = await Category.findById(req.body.categoryId);
    if (categoryObj) {
      req.body.category = categoryObj.name;
    }
  } else if (req.body.categoryId === "") {
    delete req.body.categoryId;
    req.body.$unset = req.body.$unset || {};
    req.body.$unset.categoryId = 1;
  }

  if (req.body.brandId === "") {
    delete req.body.brandId;
    req.body.$unset = req.body.$unset || {};
    req.body.$unset.brandId = 1;
  }
  
  product = await Product.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  
  successResponse(res, 200, 'Product updated successfully', product);
});

export const deleteProduct = asyncHandler(async (req: Request, res: Response) => {
  const product = await Product.findByIdAndDelete(req.params.id);
  if (!product) {
    return errorResponse(res, 404, 'Product not found');
  }
  successResponse(res, 200, 'Product deleted successfully', null);
});
