import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Faq } from '../models/Faq';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';

export const getPublicFaqs = asyncHandler(async (req: Request, res: Response) => {
  const faqs = await Faq.find({ isActive: true }).sort({ order: 1, createdAt: -1 });
  successResponse(res, 200, 'FAQs fetched successfully', faqs);
});

export const getAdminFaqs = asyncHandler(async (req: Request, res: Response) => {
  const faqs = await Faq.find().sort({ order: 1, createdAt: -1 });
  successResponse(res, 200, 'FAQs fetched successfully', faqs);
});

/** Trimmed text, a finite order and a boolean status; only the fields sent (all text fields required on create). */
const readFaq = (body: any, creating: boolean): { data?: Record<string, unknown>; error?: string } => {
  const data: Record<string, unknown> = {};
  for (const k of ['question', 'answer'] as const) {
    if (body?.[k] === undefined) { if (creating) return { error: 'Please provide question and answer' }; continue; }
    const v = typeof body[k] === 'string' ? body[k].trim() : '';
    if (!v) return { error: `The ${k} cannot be empty` };
    data[k] = v;
  }
  if (body?.order !== undefined && body.order !== '') {
    const o = Number(body.order);
    if (!Number.isFinite(o)) return { error: 'Order must be a number' };
    data.order = o;
  }
  if (body?.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') return { error: 'isActive must be true or false' };
    data.isActive = body.isActive;
  }
  return { data };
};

const validId = (id: string) => mongoose.Types.ObjectId.isValid(id);

export const createFaq = asyncHandler(async (req: Request, res: Response) => {
  const { data, error } = readFaq(req.body, true);
  if (error) return errorResponse(res, 400, error);
  const faq = await Faq.create(data);
  successResponse(res, 201, 'FAQ created successfully', faq);
});

export const updateFaq = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!validId(id)) return errorResponse(res, 400, 'Invalid FAQ id');
  const { data, error } = readFaq(req.body, false);
  if (error) return errorResponse(res, 400, error);
  const faq = await Faq.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true });
  if (!faq) return errorResponse(res, 404, 'FAQ not found');
  successResponse(res, 200, 'FAQ updated successfully', faq);
});

export const deleteFaq = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!validId(id)) return errorResponse(res, 400, 'Invalid FAQ id');
  const faq = await Faq.findByIdAndDelete(id);
  if (!faq) return errorResponse(res, 404, 'FAQ not found');
  successResponse(res, 200, 'FAQ deleted successfully', null);
});

export const toggleFaqStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!validId(id)) return errorResponse(res, 400, 'Invalid FAQ id');
  const faq = await Faq.findById(id);
  if (!faq) return errorResponse(res, 404, 'FAQ not found');

  faq.isActive = !faq.isActive;
  await faq.save();

  successResponse(res, 200, `FAQ ${faq.isActive ? 'activated' : 'deactivated'} successfully`, faq);
});
