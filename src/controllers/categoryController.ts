import { Request, Response } from 'express';
import { Category } from '../models/Category';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';

export const createCategory = asyncHandler(async (req: Request, res: Response) => {
  if (req.file) {
    req.body.image = req.file.path;
  }
  const category = await Category.create(req.body);
  successResponse(res, 201, 'Category created successfully', category);
});

export const getCategories = asyncHandler(async (req: Request, res: Response) => {
  const categories = await Category.find().sort({ displayOrder: 1, createdAt: -1 });
  successResponse(res, 200, 'Categories fetched successfully', categories);
});

export const updateCategory = asyncHandler(async (req: Request, res: Response) => {
  let category = await Category.findById(req.params.id);
  if (!category) {
    return errorResponse(res, 404, 'Category not found');
  }
  if (req.file) {
    req.body.image = req.file.path;
  }
  category = await Category.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  successResponse(res, 200, 'Category updated successfully', category);
});

export const deleteCategory = asyncHandler(async (req: Request, res: Response) => {
  const category = await Category.findByIdAndDelete(req.params.id);
  if (!category) {
    return errorResponse(res, 404, 'Category not found');
  }
  successResponse(res, 200, 'Category deleted successfully', null);
});
