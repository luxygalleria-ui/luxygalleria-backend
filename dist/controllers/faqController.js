"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.toggleFaqStatus = exports.deleteFaq = exports.updateFaq = exports.createFaq = exports.getAdminFaqs = exports.getPublicFaqs = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const Faq_1 = require("../models/Faq");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
exports.getPublicFaqs = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const faqs = await Faq_1.Faq.find({ isActive: true }).sort({ order: 1, createdAt: -1 });
    (0, responseHandler_1.successResponse)(res, 200, 'FAQs fetched successfully', faqs);
});
exports.getAdminFaqs = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const faqs = await Faq_1.Faq.find().sort({ order: 1, createdAt: -1 });
    (0, responseHandler_1.successResponse)(res, 200, 'FAQs fetched successfully', faqs);
});
/** Trimmed text, a finite order and a boolean status; only the fields sent (all text fields required on create). */
const readFaq = (body, creating) => {
    const data = {};
    for (const k of ['question', 'answer']) {
        if (body?.[k] === undefined) {
            if (creating)
                return { error: 'Please provide question and answer' };
            continue;
        }
        const v = typeof body[k] === 'string' ? body[k].trim() : '';
        if (!v)
            return { error: `The ${k} cannot be empty` };
        data[k] = v;
    }
    if (body?.order !== undefined && body.order !== '') {
        const o = Number(body.order);
        if (!Number.isFinite(o))
            return { error: 'Order must be a number' };
        data.order = o;
    }
    if (body?.isActive !== undefined) {
        if (typeof body.isActive !== 'boolean')
            return { error: 'isActive must be true or false' };
        data.isActive = body.isActive;
    }
    return { data };
};
const validId = (id) => mongoose_1.default.Types.ObjectId.isValid(id);
exports.createFaq = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { data, error } = readFaq(req.body, true);
    if (error)
        return (0, responseHandler_1.errorResponse)(res, 400, error);
    const faq = await Faq_1.Faq.create(data);
    (0, responseHandler_1.successResponse)(res, 201, 'FAQ created successfully', faq);
});
exports.updateFaq = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = req.params;
    if (!validId(id))
        return (0, responseHandler_1.errorResponse)(res, 400, 'Invalid FAQ id');
    const { data, error } = readFaq(req.body, false);
    if (error)
        return (0, responseHandler_1.errorResponse)(res, 400, error);
    const faq = await Faq_1.Faq.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true });
    if (!faq)
        return (0, responseHandler_1.errorResponse)(res, 404, 'FAQ not found');
    (0, responseHandler_1.successResponse)(res, 200, 'FAQ updated successfully', faq);
});
exports.deleteFaq = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = req.params;
    if (!validId(id))
        return (0, responseHandler_1.errorResponse)(res, 400, 'Invalid FAQ id');
    const faq = await Faq_1.Faq.findByIdAndDelete(id);
    if (!faq)
        return (0, responseHandler_1.errorResponse)(res, 404, 'FAQ not found');
    (0, responseHandler_1.successResponse)(res, 200, 'FAQ deleted successfully', null);
});
exports.toggleFaqStatus = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = req.params;
    if (!validId(id))
        return (0, responseHandler_1.errorResponse)(res, 400, 'Invalid FAQ id');
    const faq = await Faq_1.Faq.findById(id);
    if (!faq)
        return (0, responseHandler_1.errorResponse)(res, 404, 'FAQ not found');
    faq.isActive = !faq.isActive;
    await faq.save();
    (0, responseHandler_1.successResponse)(res, 200, `FAQ ${faq.isActive ? 'activated' : 'deactivated'} successfully`, faq);
});
//# sourceMappingURL=faqController.js.map