import { Request, Response } from 'express';
import { VideoTestimonial } from '../models/VideoTestimonial';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';

export const createVideoTestimonial = asyncHandler(async (req: Request, res: Response) => {
  const { clientName, role, youtubeUrl, displayOrder, isActive } = req.body;
  
  // Create document (pre-validate hook will fill youtubeId and thumbnailUrl)
  const testimonial = new VideoTestimonial({
    clientName,
    role,
    youtubeUrl,
    displayOrder: displayOrder !== undefined ? Number(displayOrder) : 0,
    isActive: isActive !== undefined ? isActive : true,
    // Provide temporary non-empty values so validation passes before hook updates them (if needed)
    youtubeId: 'temp_id_val',
    thumbnailUrl: 'temp_thumb_val'
  });

  await testimonial.save();
  successResponse(res, 201, 'Video testimonial created successfully', testimonial);
});

export const getVideoTestimonials = asyncHandler(async (req: Request, res: Response) => {
  const testimonials = await VideoTestimonial.find().sort({ displayOrder: 1, createdAt: -1 });
  successResponse(res, 200, 'Video testimonials fetched successfully', testimonials);
});

export const getActiveVideoTestimonials = asyncHandler(async (req: Request, res: Response) => {
  const testimonials = await VideoTestimonial.find({ isActive: true }).sort({ displayOrder: 1, createdAt: -1 });
  successResponse(res, 200, 'Active video testimonials fetched successfully', testimonials);
});

export const updateVideoTestimonial = asyncHandler(async (req: Request, res: Response) => {
  const testimonial = await VideoTestimonial.findById(req.params.id);
  if (!testimonial) {
    return errorResponse(res, 404, 'Video testimonial not found');
  }

  const { clientName, role, youtubeUrl, displayOrder, isActive } = req.body;

  if (clientName !== undefined) testimonial.clientName = clientName;
  if (role !== undefined) testimonial.role = role;
  if (youtubeUrl !== undefined) testimonial.youtubeUrl = youtubeUrl;
  if (displayOrder !== undefined) testimonial.displayOrder = Number(displayOrder);
  if (isActive !== undefined) testimonial.isActive = isActive;

  await testimonial.save();
  successResponse(res, 200, 'Video testimonial updated successfully', testimonial);
});

export const deleteVideoTestimonial = asyncHandler(async (req: Request, res: Response) => {
  const testimonial = await VideoTestimonial.findByIdAndDelete(req.params.id);
  if (!testimonial) {
    return errorResponse(res, 404, 'Video testimonial not found');
  }
  successResponse(res, 200, 'Video testimonial deleted successfully', null);
});
