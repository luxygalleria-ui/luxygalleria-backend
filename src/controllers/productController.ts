import { Request, Response } from 'express';
import { Product } from '../models/Product';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';
import { parseWeightFromVolume } from '../utils/shippingCalculator';

export const createProduct = asyncHandler(async (req: Request, res: Response) => {
  if (req.files && Array.isArray(req.files)) {
    const fileUrls = req.files.map(file => file.path);
    
    // Parse the stringified arrays/objects from formData if necessary
    if (typeof req.body.images === 'string') {
      req.body.images = [req.body.images];
    }
    
    req.body.images = [...(req.body.images || []), ...fileUrls];
  }

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
      const parsedWeight = parseWeightFromVolume(v.volume || '');
      const offerPrice = Number(v.offerPrice !== undefined ? v.offerPrice : (v.price || 0));
      const actualPrice = Number(v.actualPrice !== undefined ? v.actualPrice : (v.oldPrice || v.price || 0));
      const weight = Number(v.weight !== undefined ? v.weight : (parsedWeight !== null ? parsedWeight : 0));
      const stock = Number(v.stock !== undefined ? v.stock : 0);
      const sku = v.sku || '';
      const image = v.image || '';
      const images = Array.isArray(v.images) ? v.images : (v.image ? [v.image] : []);
      return {
        ...v,
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

  const product = await Product.create(req.body);
  successResponse(res, 201, 'Product created successfully', product);
});

export const getProducts = asyncHandler(async (req: Request, res: Response) => {
  const products = await Product.find().sort({ createdAt: -1 });
  successResponse(res, 200, 'Products fetched successfully', products);
});

export const updateProduct = asyncHandler(async (req: Request, res: Response) => {
  let product = await Product.findById(req.params.id);
  if (!product) {
    return errorResponse(res, 404, 'Product not found');
  }
  
  if (req.files && Array.isArray(req.files)) {
    const fileUrls = req.files.map(file => file.path);
    if (typeof req.body.images === 'string') {
      req.body.images = [req.body.images];
    }
    req.body.images = [...(req.body.images || []), ...fileUrls];
  }

  if (typeof req.body.variants === 'string') {
    try {
      req.body.variants = JSON.parse(req.body.variants);
    } catch (e) {
      // do nothing
    }
  }

  if (req.body.variants && Array.isArray(req.body.variants)) {
    req.body.variants = req.body.variants.map((v: any) => {
      const parsedWeight = parseWeightFromVolume(v.volume || '');
      const offerPrice = Number(v.offerPrice !== undefined ? v.offerPrice : (v.price || 0));
      const actualPrice = Number(v.actualPrice !== undefined ? v.actualPrice : (v.oldPrice || v.price || 0));
      const weight = Number(v.weight !== undefined ? v.weight : (parsedWeight !== null ? parsedWeight : 0));
      const stock = Number(v.stock !== undefined ? v.stock : 0);
      const sku = v.sku || '';
      const image = v.image || '';
      const images = Array.isArray(v.images) ? v.images : (v.image ? [v.image] : []);
      return {
        ...v,
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
