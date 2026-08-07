import { Request, Response } from 'express';
import { Brand } from '../models/Brand';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';

export const createBrand = asyncHandler(async (req: Request, res: Response) => {
  if (req.file) {
    req.body.logo = req.file.path;
  }
  const brand = await Brand.create(req.body);
  successResponse(res, 201, 'Brand created successfully', brand);
});

export const getBrands = asyncHandler(async (req: Request, res: Response) => {
  const brands = await Brand.find().sort({ displayOrder: 1, createdAt: -1 });
  successResponse(res, 200, 'Brands fetched successfully', brands);
});

export const updateBrand = asyncHandler(async (req: Request, res: Response) => {
  let brand = await Brand.findById(req.params.id);
  if (!brand) {
    return errorResponse(res, 404, 'Brand not found');
  }
  if (req.file) {
    req.body.logo = req.file.path;
  }
  brand = await Brand.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  successResponse(res, 200, 'Brand updated successfully', brand);
});

export const deleteBrand = asyncHandler(async (req: Request, res: Response) => {
  const brand = await Brand.findByIdAndDelete(req.params.id);
  if (!brand) {
    return errorResponse(res, 404, 'Brand not found');
  }
  successResponse(res, 200, 'Brand deleted successfully', null);
});
