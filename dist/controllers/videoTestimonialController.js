"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteVideoTestimonial = exports.updateVideoTestimonial = exports.getActiveVideoTestimonials = exports.getVideoTestimonials = exports.createVideoTestimonial = void 0;
const VideoTestimonial_1 = require("../models/VideoTestimonial");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
exports.createVideoTestimonial = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { clientName, role, youtubeUrl, displayOrder, isActive } = req.body;
    // Create document (pre-validate hook will fill youtubeId and thumbnailUrl)
    const testimonial = new VideoTestimonial_1.VideoTestimonial({
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
    (0, responseHandler_1.successResponse)(res, 201, 'Video testimonial created successfully', testimonial);
});
exports.getVideoTestimonials = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const testimonials = await VideoTestimonial_1.VideoTestimonial.find().sort({ displayOrder: 1, createdAt: -1 });
    (0, responseHandler_1.successResponse)(res, 200, 'Video testimonials fetched successfully', testimonials);
});
exports.getActiveVideoTestimonials = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const testimonials = await VideoTestimonial_1.VideoTestimonial.find({ isActive: true }).sort({ displayOrder: 1, createdAt: -1 });
    (0, responseHandler_1.successResponse)(res, 200, 'Active video testimonials fetched successfully', testimonials);
});
exports.updateVideoTestimonial = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const testimonial = await VideoTestimonial_1.VideoTestimonial.findById(req.params.id);
    if (!testimonial) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Video testimonial not found');
    }
    const { clientName, role, youtubeUrl, displayOrder, isActive } = req.body;
    if (clientName !== undefined)
        testimonial.clientName = clientName;
    if (role !== undefined)
        testimonial.role = role;
    if (youtubeUrl !== undefined)
        testimonial.youtubeUrl = youtubeUrl;
    if (displayOrder !== undefined)
        testimonial.displayOrder = Number(displayOrder);
    if (isActive !== undefined)
        testimonial.isActive = isActive;
    await testimonial.save();
    (0, responseHandler_1.successResponse)(res, 200, 'Video testimonial updated successfully', testimonial);
});
exports.deleteVideoTestimonial = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const testimonial = await VideoTestimonial_1.VideoTestimonial.findByIdAndDelete(req.params.id);
    if (!testimonial) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Video testimonial not found');
    }
    (0, responseHandler_1.successResponse)(res, 200, 'Video testimonial deleted successfully', null);
});
//# sourceMappingURL=videoTestimonialController.js.map