import { Request, Response } from 'express';
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

export const createFaq = asyncHandler(async (req: Request, res: Response) => {
  const { question, answer, order, isActive } = req.body;
  if (!question || !answer) {
    return errorResponse(res, 400, 'Please provide question and answer');
  }

  const faq = await Faq.create({ question, answer, order, isActive });
  successResponse(res, 201, 'FAQ created successfully', faq);
});

export const updateFaq = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { question, answer, order, isActive } = req.body;

  const faq = await Faq.findByIdAndUpdate(
    id,
    { question, answer, order, isActive },
    { new: true, runValidators: true }
  );

  if (!faq) return errorResponse(res, 404, 'FAQ not found');
  successResponse(res, 200, 'FAQ updated successfully', faq);
});

export const deleteFaq = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const faq = await Faq.findByIdAndDelete(id);

  if (!faq) return errorResponse(res, 404, 'FAQ not found');
  successResponse(res, 200, 'FAQ deleted successfully', null);
});

export const toggleFaqStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const faq = await Faq.findById(id);

  if (!faq) return errorResponse(res, 404, 'FAQ not found');

  faq.isActive = !faq.isActive;
  await faq.save();

  successResponse(res, 200, `FAQ ${faq.isActive ? 'activated' : 'deactivated'} successfully`, faq);
});
