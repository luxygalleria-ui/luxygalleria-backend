"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteVideoTestimonial = exports.updateVideoTestimonial = exports.getActiveVideoTestimonials = exports.getVideoTestimonials = exports.createVideoTestimonial = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const VideoTestimonial_1 = require("../models/VideoTestimonial");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
/** Checks the fields that are present (all required on create). Returns an error message or null. */
const invalidInput = (body, creating) => {
    const { clientName, role, youtubeUrl, displayOrder, isActive } = body || {};
    const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
    if ((creating || clientName !== undefined) && !text(clientName, 100))
        return 'Client name is required (up to 100 characters)';
    if ((creating || role !== undefined) && !text(role, 100))
        return 'Role is required (up to 100 characters)';
    if ((creating || youtubeUrl !== undefined) && (typeof youtubeUrl !== 'string' || !(0, VideoTestimonial_1.extractYoutubeId)(youtubeUrl)))
        return 'Invalid YouTube URL provided. Please provide a valid YouTube video URL.';
    if (displayOrder !== undefined && !Number.isInteger(Number(displayOrder)))
        return 'Display order must be a whole number';
    if (isActive !== undefined && typeof isActive !== 'boolean')
        return 'isActive must be true or false';
    return null;
};
exports.createVideoTestimonial = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const problem = invalidInput(req.body, true);
    if (problem)
        return (0, responseHandler_1.errorResponse)(res, 400, problem);
    const { clientName, role, youtubeUrl, displayOrder, isActive } = req.body;
    // The same video twice is almost always a double submit or a copy: refuse instead of inserting a duplicate
    const duplicate = await VideoTestimonial_1.VideoTestimonial.findOne({ youtubeId: (0, VideoTestimonial_1.extractYoutubeId)(youtubeUrl) }, { clientName: 1 });
    if (duplicate)
        return (0, responseHandler_1.errorResponse)(res, 409, `This YouTube video is already in the list (${duplicate.clientName})`);
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
    if (!mongoose_1.default.isValidObjectId(req.params.id))
        return (0, responseHandler_1.errorResponse)(res, 400, 'Invalid video testimonial id');
    const problem = invalidInput(req.body, false);
    if (problem)
        return (0, responseHandler_1.errorResponse)(res, 400, problem);
    const testimonial = await VideoTestimonial_1.VideoTestimonial.findById(req.params.id);
    if (!testimonial) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Video testimonial not found');
    }
    const { clientName, role, youtubeUrl, displayOrder, isActive } = req.body;
    if (youtubeUrl !== undefined) {
        const other = await VideoTestimonial_1.VideoTestimonial.findOne({ youtubeId: (0, VideoTestimonial_1.extractYoutubeId)(youtubeUrl), _id: { $ne: testimonial._id } }, { clientName: 1 });
        if (other)
            return (0, responseHandler_1.errorResponse)(res, 409, `This YouTube video is already in the list (${other.clientName})`);
    }
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
    if (!mongoose_1.default.isValidObjectId(req.params.id))
        return (0, responseHandler_1.errorResponse)(res, 400, 'Invalid video testimonial id');
    const testimonial = await VideoTestimonial_1.VideoTestimonial.findByIdAndDelete(req.params.id);
    if (!testimonial) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Video testimonial not found');
    }
    (0, responseHandler_1.successResponse)(res, 200, 'Video testimonial deleted successfully', null);
});
//# sourceMappingURL=videoTestimonialController.js.map