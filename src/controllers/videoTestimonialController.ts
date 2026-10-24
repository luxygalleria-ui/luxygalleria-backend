import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { VideoTestimonial, extractYoutubeId } from '../models/VideoTestimonial';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';

/** Checks the fields that are present (all required on create). Returns an error message or null. */
const invalidInput = (body: any, creating: boolean): string | null => {
  const { clientName, role, youtubeUrl, displayOrder, isActive } = body || {};
  const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
  if ((creating || clientName !== undefined) && !text(clientName, 100)) return 'Client name is required (up to 100 characters)';
  if ((creating || role !== undefined) && !text(role, 100)) return 'Role is required (up to 100 characters)';
  if ((creating || youtubeUrl !== undefined) && (typeof youtubeUrl !== 'string' || !extractYoutubeId(youtubeUrl))) return 'Invalid YouTube URL provided. Please provide a valid YouTube video URL.';
  if (displayOrder !== undefined && !Number.isInteger(Number(displayOrder))) return 'Display order must be a whole number';
  if (isActive !== undefined && typeof isActive !== 'boolean') return 'isActive must be true or false';
  return null;
};

export const createVideoTestimonial = asyncHandler(async (req: Request, res: Response) => {
  const problem = invalidInput(req.body, true);
  if (problem) return errorResponse(res, 400, problem);
  const { clientName, role, youtubeUrl, displayOrder, isActive } = req.body;
  // The same video twice is almost always a double submit or a copy: refuse instead of inserting a duplicate
  const duplicate = await VideoTestimonial.findOne({ youtubeId: extractYoutubeId(youtubeUrl) }, { clientName: 1 });
  if (duplicate) return errorResponse(res, 409, `This YouTube video is already in the list (${duplicate.clientName})`);
  
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
  if (!mongoose.isValidObjectId(req.params.id)) return errorResponse(res, 400, 'Invalid video testimonial id');
  const problem = invalidInput(req.body, false);
  if (problem) return errorResponse(res, 400, problem);
  const testimonial = await VideoTestimonial.findById(req.params.id);
  if (!testimonial) {
    return errorResponse(res, 404, 'Video testimonial not found');
  }

  const { clientName, role, youtubeUrl, displayOrder, isActive } = req.body;
  if (youtubeUrl !== undefined) {
    const other = await VideoTestimonial.findOne({ youtubeId: extractYoutubeId(youtubeUrl), _id: { $ne: testimonial._id } }, { clientName: 1 });
    if (other) return errorResponse(res, 409, `This YouTube video is already in the list (${other.clientName})`);
  }

  if (clientName !== undefined) testimonial.clientName = clientName;
  if (role !== undefined) testimonial.role = role;
  if (youtubeUrl !== undefined) testimonial.youtubeUrl = youtubeUrl;
  if (displayOrder !== undefined) testimonial.displayOrder = Number(displayOrder);
  if (isActive !== undefined) testimonial.isActive = isActive;

  await testimonial.save();
  successResponse(res, 200, 'Video testimonial updated successfully', testimonial);
});

export const deleteVideoTestimonial = asyncHandler(async (req: Request, res: Response) => {
  if (!mongoose.isValidObjectId(req.params.id)) return errorResponse(res, 400, 'Invalid video testimonial id');
  const testimonial = await VideoTestimonial.findByIdAndDelete(req.params.id);
  if (!testimonial) {
    return errorResponse(res, 404, 'Video testimonial not found');
  }
  successResponse(res, 200, 'Video testimonial deleted successfully', null);
});
